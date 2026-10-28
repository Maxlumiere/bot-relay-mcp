// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A key id that is an Object.prototype name (`__proto__`, `constructor`, `prototype`) is an ORDINARY key id.
 *
 * MEASURED before this change: the keyring was a plain object, so a `__proto__` entry SET its prototype instead of
 * adding a key. That key was invisible (missing from known_key_ids) yet still decrypted its rows, and a keyring whose
 * `current` was `__proto__` encrypted everything under a key it reported it did not have. Rows under a missing
 * `constructor` id failed with a TypeError instead of the named error.
 *
 * Now the keyring is a Map with own-key lookups: such an id is visible, decrypts its own rows, round-trips as
 * `current`, and can be re-encrypted away from with the normal command. A loud warning at load names that command.
 * A keyring that cannot be loaded classifies an envelope as unverifiable for its own reason, `keyring_unreadable`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript-legacy";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";

const ENV = ["RELAY_ENCRYPTION_KEYRING", "RELAY_ENCRYPTION_KEYRING_PATH", "RELAY_ENCRYPTION_KEY", "RELAY_ENCRYPTION_LEGACY_KEY_ID", "RELAY_DB_PATH", "RELAY_HTTP_PORT", "RELAY_CONFIG_PATH", "RELAY_LOG_LEVEL"] as const;
const b64 = (b: Buffer): string => b.toString("base64");
const newKey = (): Buffer => crypto.randomBytes(32);
/** A real v2 ciphertext of `text` under `key`, labelled `id` (what encryptContent writes). */
function seal(key: Buffer, id: string, text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return `enc:${id}:${b64(iv)}:${b64(ct)}`;
}
/** The keyring JSON exactly as an operator writes it (a `__proto__` key in the TEXT is an own key once parsed). */
function ringJson(current: string, keys: Array<[string, Buffer]>): string {
  return `{"current":${JSON.stringify(current)},"keys":{${keys.map(([id, k]) => `${JSON.stringify(id)}:${JSON.stringify(b64(k))}`).join(",")}}}`;
}
async function useRing(json: string | null) {
  if (json === null) delete process.env.RELAY_ENCRYPTION_KEYRING;
  else process.env.RELAY_ENCRYPTION_KEYRING = json;
  const enc = await import("../src/encryption.js");
  enc._resetKeyringCacheForTests();
  return enc;
}

let saved: Record<string, string | undefined>;
let root: string;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keyring-reserved-")));
});
afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  (await import("../src/encryption.js"))._resetKeyringCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const RESERVED = ["__proto__", "constructor", "prototype"];

describe("an Object.prototype name is an ordinary key id", () => {
  it.each(["__proto__", "constructor"])("(A) a row under %s, an id the keyring does NOT hold: the NAMED not-in-keyring error, not a TypeError", async (id) => {
    const enc = await useRing(ringJson("k1", [["k1", newKey()]]));
    let err: unknown;
    try {
      enc.decryptContent(seal(newKey(), id, "x"));
    } catch (e) {
      err = e;
    }
    expect(err, "it throws").toBeInstanceOf(Error);
    expect(err, "not a TypeError from a non-key reaching the cipher").not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(new RegExp(`key_id="${id}" but that key is not in the keyring`));
  });

  it("(A) a row under `length` with a `__proto__` entry present: the named error (the keys map has no prototype to read through)", async () => {
    const enc = await useRing(ringJson("k1", [["k1", newKey()], ["__proto__", newKey()]]));
    expect(() => enc.decryptContent(seal(newKey(), "length", "x"))).toThrow(/key_id="length" but that key is not in the keyring/);
  });

  it.each(RESERVED)("(B) a keyring holding %s next to k1: the id is VISIBLE in known_key_ids, and its rows decrypt under ITS key", async (id) => {
    const K = newKey();
    const enc = await useRing(ringJson("k1", [["k1", newKey()], [id, K]]));
    expect(enc.getKeyringInfo().known_key_ids).toEqual(["k1", id].sort());
    expect(enc.decryptContent(seal(K, id, "under-the-reserved-id"))).toBe("under-the-reserved-id");
    expect(() => enc.decryptContent(seal(newKey(), id, "x")), "a different key under that id does not authenticate").toThrow();
  });

  it.each(RESERVED)("(C) `current` = %s: the keyring reports it, encrypts under it, and round-trips", async (id) => {
    const enc = await useRing(ringJson(id, [[id, newKey()]]));
    const info = enc.getKeyringInfo();
    expect(info.current).toBe(id);
    expect(info.known_key_ids).toEqual([id]);
    const stored = enc.encryptContent("written-under-a-reserved-id");
    expect(stored.startsWith(`enc:${id}:`)).toBe(true);
    expect(enc.decryptContent(stored)).toBe("written-under-a-reserved-id");
  });

  it("a keyring using a reserved id loads with a LOUD warning naming the remedy command", async () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => {
      writes.push(String(c));
      return orig(c as string, ...(a as []));
    };
    try {
      const enc = await useRing(ringJson("k1", [["k1", newKey()], ["__proto__", newKey()]]));
      enc.validateKeyringStrict();
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(writes.join("")).toMatch(/__proto__.*relay re-encrypt --from __proto__ --to <new id>/s);
  });

  it("known-good twin: an ordinary keyring loads with NO such warning", async () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => {
      writes.push(String(c));
      return orig(c as string, ...(a as []));
    };
    try {
      const enc = await useRing(ringJson("k1", [["k1", newKey()]]));
      enc.validateKeyringStrict();
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(writes.join("")).not.toMatch(/relay re-encrypt --from/);
  });

  it("`relay re-encrypt --from __proto__ --to k2` succeeds: every row moves to k2 and still decrypts", async () => {
    const Kp = newKey();
    const K2 = newKey();
    process.env.RELAY_DB_PATH = path.join(root, "relay.db");
    process.env.RELAY_HTTP_PORT = "1";
    await useRing(ringJson("__proto__", [["__proto__", Kp]]));
    const db = await import("../src/db.js");
    await db.initializeDb();
    db.registerAgent("alpha", "r", []);
    db.registerAgent("beta", "r", []);
    db.sendMessage("alpha", "beta", "a body under __proto__", "normal");
    expect((db.getDb().prepare("SELECT content FROM messages").get() as { content: string }).content.startsWith("enc:__proto__:")).toBe(true);
    db.closeDb();
    await useRing(ringJson("k2", [["__proto__", Kp], ["k2", K2]]));
    const { run } = await import("../src/cli/re-encrypt.js");
    const code = await run(["--from", "__proto__", "--to", "k2", "--yes"]);
    expect(code, "re-encrypt exit code").toBe(0);
    db.closeDb();
    await db.initializeDb();
    const content = (db.getDb().prepare("SELECT content FROM messages").get() as { content: string }).content;
    expect(content.startsWith("enc:k2:"), "the row is under k2 now").toBe(true);
    expect(db.getMessages("beta", "all", 10, true).map((m: { content: string }) => m.content)).toEqual(["a body under __proto__"]);
  });

  it("a keyring that cannot be LOADED classifies an envelope as unverifiable for its own reason, keyring_unreadable (never no_keyring)", async () => {
    const enc = await useRing("{ this is not json");
    expect(enc.classifyStored(seal(newKey(), "k1", "x"))).toEqual({ kind: "unverifiable", keyId: "k1", reason: "keyring_unreadable" });
  });

  it("known-good twin: with NO keyring configured at all, the reason is no_keyring", async () => {
    const enc = await useRing(null);
    expect(enc.classifyStored(seal(newKey(), "k1", "x"))).toEqual({ kind: "unverifiable", keyId: "k1", reason: "no_keyring" });
  });
});

/** stderr captured while `fn` runs. */
async function stderrOf(fn: () => unknown | Promise<unknown>): Promise<string> {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => {
    writes.push(String(c));
    return orig(c as string, ...(a as []));
  };
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
  }
  return writes.join("");
}

describe("Codex R1: the reserved-id warning does not depend on the log level", () => {
  it.each([
    ["the keyring", (K: Buffer) => { process.env.RELAY_ENCRYPTION_KEYRING = ringJson("k1", [["k1", newKey()], ["__proto__", K]]); }, "__proto__"],
    ["the legacy single key", (K: Buffer) => { process.env.RELAY_ENCRYPTION_KEY = b64(K); process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID = "constructor"; }, "constructor"],
  ] as Array<[string, (K: Buffer) => void, string]>)("under RELAY_LOG_LEVEL=error, a reserved id in %s is still warned about: ONCE per load, with no key bytes", async (_label, set, id) => {
    process.env.RELAY_LOG_LEVEL = "error";
    const K = newKey();
    set(K);
    const enc = await import("../src/encryption.js");
    enc._resetKeyringCacheForTests();
    const out = await stderrOf(() => {
      enc.validateKeyringStrict();
      enc.validateKeyringStrict(); // the cached keyring: no second warning
    });
    const hits = out.split("\n").filter((l) => l.includes(`relay re-encrypt --from ${id} --to <new id>`));
    expect(hits.length, `one warning per load:\n${out}`).toBe(1);
    expect(out.includes(b64(K)), "no key bytes").toBe(false);
    expect(out.includes(K.toString("hex")), "no key bytes (hex)").toBe(false);
    enc._resetKeyringCacheForTests();
    expect((await stderrOf(() => enc.validateKeyringStrict())).includes(`--from ${id}`), "a new load warns again").toBe(true);
  });
});

describe("Codex R1 (ruled): a keyring that cannot be LOADED does not stop a backup", () => {
  async function seedUnderKey(K: Buffer) {
    process.env.RELAY_DB_PATH = path.join(root, "relay.db");
    process.env.RELAY_CONFIG_PATH = path.join(root, "config.json");
    process.env.RELAY_HTTP_PORT = "1";
    await useRing(ringJson("k1", [["k1", K]]));
    const db = await import("../src/db.js");
    await db.initializeDb();
    db.registerAgent("alpha", "r", []);
    db.registerAgent("beta", "r", []);
    db.sendMessage("alpha", "beta", "a private body", "normal");
    db.registerWebhook("https://example.com/hook", "message.sent", undefined, "whsec-under-k1");
    return db;
  }
  const backupsOf = () => {
    const d = path.join(root, "backups");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith("pre-restore-")) : [];
  };

  it("the export COMPLETES: each needed key id has fingerprint null with the reason, the webhook secret is unverifiable (keyring_unreadable), and the warning is in stderr and the result", async () => {
    await seedUnderKey(newKey());
    await useRing("{ not json");
    const { exportRelayState } = await import("../src/backup.js");
    let exp: Record<string, unknown> = {};
    const out = await stderrOf(async () => {
      exp = (await exportRelayState({ destinationPath: path.join(root, "broken-ring.tar.gz") })) as unknown as Record<string, unknown>;
    });
    expect(fs.existsSync(String(exp.archive_path)), "the archive was written").toBe(true);
    const keys = (exp.encryption as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys.map((k) => [k.key_id, k.fingerprint, k.fingerprint_reason])).toEqual([["k1", null, "keyring_unreadable"]]);
    expect(exp.webhook_secrets).toEqual({ plaintext: 0, encrypted: 0, unverifiable: 1, unverifiable_reasons: { no_keyring: 0, key_not_held: 0, auth_failed: 0, keyring_unreadable: 1 } });
    expect((exp.warnings as string[]).join(" ")).toMatch(/keyring could not be LOADED/);
    expect(out).toMatch(/keyring could not be LOADED/);
  });

  it("restore of that archive under the WRONG key is refused before any mutation (a null fingerprint lets nothing through: the decrypt probe refuses)", async () => {
    const db = await seedUnderKey(newKey());
    await useRing("{ not json");
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(root, "broken-ring.tar.gz") });
    await useRing(ringJson("k1", [["k1", newKey()]])); // the same id, another key
    db.closeDb();
    await db.initializeDb();
    db.registerAgent("live-only", "r", []);
    await expect(importRelayState(exp.archive_path, { force: true })).rejects.toThrow(/does not decrypt/);
    expect(backupsOf(), "no safety backup").toEqual([]);
    expect(db.getAgents().map((a: { name: string }) => a.name)).toContain("live-only");
  });

  it("known-good twin: restore of that archive under the RIGHT key proceeds", async () => {
    const K = newKey();
    await seedUnderKey(K);
    await useRing("{ not json");
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(root, "broken-ring.tar.gz") });
    await useRing(ringJson("k1", [["k1", K]]));
    expect((await importRelayState(exp.archive_path, { force: true })).restored).toBe(true);
  });
});

/**
 * The pin: no src/ file outside src/encryption.ts builds a keyring, so the one keyring builder (a Map, own-key
 * lookups) is the only one. A keyring is recognised as an object literal with BOTH a `current` and a `keys` property.
 */
function keyringLiteralsOutsideEncryption(program: ts.Program, rel: (f: string) => string): string[] {
  const out: string[] = [];
  for (const sf of program.getSourceFiles()) {
    const f = rel(sf.fileName);
    if (!f.startsWith("src/") || f === "src/encryption.ts") continue;
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const names = new Set(n.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "")));
        if (names.has("current") && names.has("keys")) out.push(`${f}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("the pin: one keyring builder", () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  it("no src/ file outside src/encryption.ts builds a keyring object", () => {
    const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");
    expect(keyringLiteralsOutsideEncryption(srcProgram(), rel)).toEqual([]);
  });
  it("known-bad twin: a keyring literal in another src/ file IS caught", () => {
    const prog = virtualProgram({ "src/rogue.ts": "export const kr = { current: 'k1', keys: {} };\n" });
    const rel = (f: string) => f.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "").replace(/^\/virtual\//, "");
    expect(keyringLiteralsOutsideEncryption(prog, rel)).toEqual(["src/rogue.ts:1"]);
  });
});
