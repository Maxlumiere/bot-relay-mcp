// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.1 — stable mint-once-reuse (the launcher side of the autowake fix).
 *
 * (4) A repeated launch with an authenticating vault REUSES the token —
 *     token_hash is byte-stable, no churn. Negative control: a force-rotate
 *     DOES change the hash (proving the reuse path isn't a no-op mirage).
 * (5) A row whose vault does NOT authenticate (missing / stale) is a MISMATCH:
 *     no silent rotation, no token returned/logged — the caller must recover.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import bcrypt from "bcryptjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v2161-stablemint-"));
process.env.RELAY_HOME = ROOT;
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
process.env.RELAY_CONFIG_PATH = path.join(ROOT, "config.json");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { defaultTokenStore } = await import("../src/token-store.js");
const { stableMintOrReuse, forceRotateAndVault } = await import("../src/mint-reuse.js");

function hashOf(name: string): string {
  return (db.getDb().prepare("SELECT token_hash FROM agents WHERE name = ?").get(name) as { token_hash: string })
    .token_hash;
}
function vaultFile(name: string): string {
  return path.join(ROOT, "agents", `${name}.token`);
}

afterAll(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("v2.16.1 — stable mint-once-reuse", () => {
  it("(4a) genuinely absent identity → creates + writes a vault that authenticates", async () => {
    const r = await stableMintOrReuse("fresh-agent", "builder", []);
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    expect(fs.existsSync(vaultFile("fresh-agent")), "vault must be written on create (closes the strand)").toBe(true);
    const vault = fs.readFileSync(vaultFile("fresh-agent"), "utf-8").trim();
    expect(vault).toBe(r.token);
    expect(bcrypt.compareSync(vault, hashOf("fresh-agent"))).toBe(true);
  });

  it("(4b) repeated launch with an authenticating vault → REUSE, token_hash byte-stable (no churn)", async () => {
    await stableMintOrReuse("stable-agent", "builder", []);
    const hash1 = hashOf("stable-agent");
    const vault1 = fs.readFileSync(vaultFile("stable-agent"), "utf-8").trim();

    // Relaunch (non-force) twice — must reuse, never rotate.
    const r2 = await stableMintOrReuse("stable-agent", "builder", []);
    const r3 = await stableMintOrReuse("stable-agent", "builder", []);
    expect(r2.status).toBe("reused");
    expect(r3.status).toBe("reused");
    if (r2.status === "reused") expect(r2.token).toBe(vault1);

    expect(hashOf("stable-agent"), "token_hash must be byte-stable across relaunch").toBe(hash1);
  });

  it("(4c) NEGATIVE CONTROL — force-rotate DOES change the hash + rewrites the vault (reuse isn't a mirage)", async () => {
    await stableMintOrReuse("rot-agent", "builder", []);
    const hashBefore = hashOf("rot-agent");
    const vaultBefore = fs.readFileSync(vaultFile("rot-agent"), "utf-8").trim();

    const forced = await forceRotateAndVault("rot-agent", "builder", []);
    const hashAfter = hashOf("rot-agent");
    const vaultAfter = fs.readFileSync(vaultFile("rot-agent"), "utf-8").trim();

    expect(hashAfter, "force MUST rotate the hash").not.toBe(hashBefore);
    expect(vaultAfter, "force MUST rewrite the vault (no strand)").toBe(forced.token);
    expect(bcrypt.compareSync(vaultAfter, hashAfter)).toBe(true);
    // The old vault token no longer authenticates — the deliberate rotation.
    expect(bcrypt.compareSync(vaultBefore, hashAfter)).toBe(false);
  });

  it("(5a) MISMATCH — row exists but vault is MISSING → no silent rotate, no token", async () => {
    await stableMintOrReuse("miss-agent", "builder", []);
    const hashBefore = hashOf("miss-agent");
    fs.rmSync(vaultFile("miss-agent")); // simulate a lost/absent vault

    const r = await stableMintOrReuse("miss-agent", "builder", []);
    expect(r.status).toBe("mismatch");
    expect((r as { token?: string }).token, "mismatch returns NO token").toBeUndefined();
    expect(hashOf("miss-agent"), "must NOT silently rotate on mismatch").toBe(hashBefore);
  });

  it("(5b) MISMATCH — row exists but vault holds a STALE (non-authenticating) token → no rotate", async () => {
    await stableMintOrReuse("stale-agent", "builder", []);
    const hashBefore = hashOf("stale-agent");
    // Overwrite the vault with a valid-shaped but WRONG token.
    await defaultTokenStore().write("stale-agent", "Z".repeat(40));

    const r = await stableMintOrReuse("stale-agent", "builder", []);
    expect(r.status).toBe("mismatch");
    expect(hashOf("stale-agent")).toBe(hashBefore); // untouched
  });
});
