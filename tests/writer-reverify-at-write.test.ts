// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Cached writer dirs re-verify provisioning AT WRITE TIME (the #442 review's P2-2, after the open-time re-check):
 * a writer whose instance path was resolved while the instance existed must not re-create that instance when it is
 * gone by the time of the write. The token store and the hooks' vault and spawn-manifest writers refuse, and nothing
 * is created; they never `mkdir -p` from above the instance directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInstance } from "../src/instance.js";
import { FileTokenStore, _setTokenTempNameForTests } from "../src/token-store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_CLAUDE_HOME"] as const;
let home: string;
let saved: Record<string, string | undefined>;
const instDir = (id: string) => path.join(home, ".bot-relay", "instances", id);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-writer-reverify-")));
  process.env.HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the token store re-verifies its instance at write time", () => {
  it("a provisioned instance: the write lands (agents/ 0700, the token 0600)", async () => {
    createInstance("live", "t");
    process.env.RELAY_INSTANCE_ID = "live";
    const store = new FileTokenStore();
    await store.write("w-bob", "abcdefgh12345678");
    expect(fs.readFileSync(path.join(instDir("live"), "agents", "w-bob.token"), "utf-8")).toBe("abcdefgh12345678\n");
    expect(fs.statSync(path.join(instDir("live"), "agents")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(instDir("live"), "agents", "w-bob.token")).mode & 0o777, "the token FILE is 0600").toBe(0o600);
  });
  it("R2 P2-b: a symlink PLANTED at the temp name → the exclusive create refuses; nothing written through it; no token", async () => {
    createInstance("live", "t");
    process.env.RELAY_INSTANCE_ID = "live";
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    const agents = path.join(instDir("live"), "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.symlinkSync(path.join(target, "stolen"), path.join(agents, ".w-bob.token.tmp.fixed"));
    _setTokenTempNameForTests(() => ".w-bob.token.tmp.fixed");
    try {
      await expect(new FileTokenStore().write("w-bob", "abcdefgh12345678")).rejects.toThrow(/EEXIST|ELOOP/);
    } finally {
      _setTokenTempNameForTests(null);
    }
    expect(fs.existsSync(path.join(target, "stolen")), "nothing written through the planted link").toBe(false);
    expect(fs.existsSync(path.join(agents, "w-bob.token"))).toBe(false);
    expect(fs.lstatSync(path.join(agents, ".w-bob.token.tmp.fixed")).isSymbolicLink(), "the planted name is not ours: left alone").toBe(true);
  });
  it("the instance REMOVED after the store resolved its path → the write refuses, and nothing is re-created", async () => {
    createInstance("gone", "t");
    process.env.RELAY_INSTANCE_ID = "gone";
    const store = new FileTokenStore(); // resolves <instances>/gone/agents now
    fs.rmSync(instDir("gone"), { recursive: true, force: true });
    await expect(store.write("w-bob", "abcdefgh12345678")).rejects.toThrow(/instance "gone"/);
    expect(fs.existsSync(instDir("gone")), "the instance dir is not re-created").toBe(false);
  });
  it("an instance reduced to a BARE directory (its record and DB gone) → refused: a bare directory is not a provisioning", async () => {
    createInstance("bare", "t");
    process.env.RELAY_INSTANCE_ID = "bare";
    const store = new FileTokenStore();
    for (const f of fs.readdirSync(instDir("bare"))) fs.rmSync(path.join(instDir("bare"), f), { recursive: true, force: true });
    await expect(store.write("w-bob", "abcdefgh12345678")).rejects.toThrow(/instance "bare"/);
    expect(fs.existsSync(path.join(instDir("bare"), "agents"))).toBe(false);
  });
  it("a LINKED agents/ under a provisioned instance → refused; its target is untouched", async () => {
    createInstance("live", "t");
    process.env.RELAY_INSTANCE_ID = "live";
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    fs.rmSync(path.join(instDir("live"), "agents"), { recursive: true, force: true });
    fs.symlinkSync(target, path.join(instDir("live"), "agents"));
    await expect(new FileTokenStore().write("w-bob", "abcdefgh12345678")).rejects.toThrow(/not a real directory/);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

/** Case-insensitive file system at `p` (macOS APFS default, Windows): the case-variant rows need it. */
const caseInsensitiveAt = (p: string): boolean => {
  try {
    return fs.statSync(p.toUpperCase()).ino === fs.statSync(p).ino;
  } catch {
    return false;
  }
};
const POSIX = process.platform !== "win32";

describe("the mutation fixture (tests/fixtures/writer-reverify-mutants.json, run by scripts/mutation-sweep.mjs)", () => {
  it("every mutant still applies: its find text occurs exactly once in its file; names are unique", () => {
    const M = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "writer-reverify-mutants.json"), "utf-8")) as Array<{ name: string; file: string; find: string }>;
    expect(M.length).toBeGreaterThanOrEqual(15);
    expect(new Set(M.map((m) => m.name)).size).toBe(M.length);
    for (const m of M) expect(fs.readFileSync(path.join(REPO, m.file), "utf-8").split(m.find).length - 1, m.name).toBe(1);
  });
});

describe.skipIf(!POSIX)("the token store: no link below the relay home at write time (ruling 3fc05540)", () => {
  const LINK = /relay: the instance directory (instances\/live|instances\/) is a symbolic link, which is not allowed below the relay home/;
  it("RACE: instances/<id> replaced by a link to a directory holding a valid record AND a relay.db, after the store resolved → refused with the link line; the target untouched", async () => {
    createInstance("live", "t");
    process.env.RELAY_INSTANCE_ID = "live";
    const store = new FileTokenStore();
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    fs.copyFileSync(path.join(instDir("live"), "instance.json"), path.join(target, "instance.json"));
    fs.writeFileSync(path.join(target, "relay.db"), "");
    fs.renameSync(instDir("live"), `${instDir("live")}.moved`);
    fs.symlinkSync(target, instDir("live"));
    await expect(store.write("w-bob", "abcdefgh12345678")).rejects.toThrow(LINK);
    expect(fs.readdirSync(target).sort()).toEqual(["instance.json", "relay.db"]);
  });
  it("RACE: instances/ replaced by a link after the store resolved → refused with the line naming instances/", async () => {
    createInstance("live", "t");
    process.env.RELAY_INSTANCE_ID = "live";
    const store = new FileTokenStore();
    const instances = path.dirname(instDir("live"));
    const target = path.join(home, "elsewhere");
    fs.cpSync(instances, target, { recursive: true });
    fs.renameSync(instances, `${instances}.moved`);
    fs.symlinkSync(target, instances);
    await expect(store.write("w-bob", "abcdefgh12345678")).rejects.toThrow(/the instance directory instances\/ is a symbolic link/);
    expect(fs.existsSync(path.join(target, "live", "agents", "w-bob.token"))).toBe(false);
  });
});

describe.skipIf(!POSIX)("the hooks' writers: the RESOLVER's layout (relay where line 9), re-verified at write time (a path resolved while it existed)", () => {
  const helper = path.join(REPO, "hooks", "_vault-helpers.sh");
  const CLI = path.join(REPO, "bin", "relay");
  /**
   * Source the helpers, ask the REAL resolver once (`relay where --fields` through relay_where_load), run `between`
   * (the change after the resolution), then both writers. stdout's last line: "<token rc> <manifest rc>".
   */
  const run = (env: Record<string, string>, between = ":", cli = CLI) => {
    const script = `set -u\n. '${helper}'\nrelay_where_load '${cli}' 30 || true\n${between}\nwrite_relay_token_to_vault w-bob abcdefgh12345678; a=$?\nwrite_relay_spawn_manifest w-bob somerole; b=$?\necho "$a $b"\n`;
    return spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), ...env }, encoding: "utf-8", timeout: 60_000 });
  };
  const last = (out: string) => out.trim().split("\n").pop();
  const LINK_LINE = /relay: the instance directory (instances\/[^ ]*|instances\/) is a symbolic link, which is not allowed below the relay home\. To keep the relay on other storage, move or link the WHOLE relay home \(RELAY_HOME \/ ~\/\.bot-relay\) instead\./;

  it("a provisioned instance: both writers succeed under the resolver's instance dir: agents/ 0700, the token 0600, the manifest 0600, no temp left", () => {
    createInstance("live", "t");
    const r = run({ RELAY_INSTANCE_ID: "live" });
    expect(last(r.stdout), r.stderr).toBe("0 0");
    const agents = path.join(instDir("live"), "agents");
    expect(fs.readFileSync(path.join(agents, "w-bob.token"), "utf-8")).toBe("abcdefgh12345678\n");
    expect(fs.statSync(agents).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(agents, "w-bob.token")).mode & 0o777, "the token is 0600").toBe(0o600);
    const manifests = fs.readdirSync(agents, { recursive: true }).map(String).filter((f) => f.endsWith(".manifest") || f.includes("manifest"));
    for (const m of manifests) {
      const st = fs.statSync(path.join(agents, m));
      if (st.isFile()) expect(st.mode & 0o777, `the manifest ${m} is 0600`).toBe(0o600);
    }
    expect(fs.readdirSync(agents, { recursive: true }).map(String).filter((f) => path.basename(f).startsWith(".")), "no temp file left").toEqual([]);
  });
  it("the instance REMOVED after the resolution → both writers refuse (1 1), and nothing is re-created", () => {
    createInstance("gone", "t");
    const r = run({ RELAY_INSTANCE_ID: "gone" }, `rm -rf '${instDir("gone")}'`);
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(r.stderr).toContain("not provisioned");
    expect(fs.existsSync(instDir("gone"))).toBe(false);
  });
  it("a LINKED agents/ under a provisioned instance → both refuse; the target is untouched", () => {
    createInstance("live", "t");
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    fs.rmSync(path.join(instDir("live"), "agents"), { recursive: true, force: true });
    fs.symlinkSync(target, path.join(instDir("live"), "agents"));
    const r = run({ RELAY_INSTANCE_ID: "live" });
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it("RACE: instances/<id> REPLACED by a link to a directory holding a valid record, after the resolution → the link line, the target untouched", () => {
    createInstance("live", "t");
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    fs.copyFileSync(path.join(instDir("live"), "instance.json"), path.join(target, "instance.json"));
    const r = run({ RELAY_INSTANCE_ID: "live" }, `mv '${instDir("live")}' '${instDir("live")}.moved' && ln -s '${target}' '${instDir("live")}'`);
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(r.stderr).toMatch(LINK_LINE);
    expect(r.stderr).toContain("instances/live is a symbolic link");
    expect(fs.readdirSync(target)).toEqual(["instance.json"]);
  });
  it("RACE: instances/ REPLACED by a link after the resolution → the link line naming instances/, the target untouched", () => {
    createInstance("live", "t");
    const instances = path.dirname(instDir("live"));
    const target = path.join(home, "elsewhere");
    fs.cpSync(instances, target, { recursive: true });
    const r = run({ RELAY_INSTANCE_ID: "live" }, `mv '${instances}' '${instances}.moved' && ln -s '${target}' '${instances}'`);
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(r.stderr).toContain("the instance directory instances/ is a symbolic link");
    expect(fs.existsSync(path.join(target, "live", "agents", "w-bob.token"))).toBe(false);
  });
  it("a linked instances/<id> at RESOLVE time → the resolver refuses, so do both writers: nothing written at the target", () => {
    fs.mkdirSync(path.dirname(instDir("x")), { recursive: true });
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    createInstance("real", "t");
    fs.copyFileSync(path.join(instDir("real"), "instance.json"), path.join(target, "instance.json"));
    fs.symlinkSync(target, instDir("x"));
    const r = run({ RELAY_INSTANCE_ID: "x" });
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(fs.readdirSync(target)).toEqual(["instance.json"]);
  });
  it("an ALIAS (an explicit RELAY_DB_PATH through a link outside the relay home to instances/) + the instance removed after the resolution → refused, nothing re-created", () => {
    createInstance("gone", "t");
    const alias = path.join(home, "alias-instances");
    fs.symlinkSync(path.dirname(instDir("gone")), alias);
    const r = run({ RELAY_DB_PATH: path.join(alias, "gone", "relay.db") }, `rm -rf '${instDir("gone")}'`);
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(r.stderr, "refused for the right reason (the alias is an access path, never a link below the root)").toContain("not provisioned");
    expect(r.stderr).not.toContain("symbolic link");
    expect(fs.existsSync(instDir("gone")), "the alias did not re-create the instance").toBe(false);
  });
  it("an ALIAS into a PROVISIONED instance → both writers succeed, and the files land in the real instance directory", () => {
    createInstance("ok", "t");
    const alias = path.join(home, "alias-instances");
    fs.symlinkSync(path.dirname(instDir("ok")), alias);
    const r = run({ RELAY_DB_PATH: path.join(alias, "ok", "relay.db") });
    expect(last(r.stdout), r.stderr).toBe("0 0");
    expect(fs.readFileSync(path.join(instDir("ok"), "agents", "w-bob.token"), "utf-8")).toBe("abcdefgh12345678\n");
  });
  it("R2 P2-b: a symlink PLANTED at the EXACT temp name (bash's RANDOM seeded to predict it) → the token writer refuses; nothing written through it", () => {
    createInstance("live", "t");
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    const agents = path.join(instDir("live"), "agents");
    fs.mkdirSync(agents, { recursive: true });
    // Seeding RANDOM makes the writer's next two $RANDOM values the ones computed here.
    const plant = `RANDOM=4242; n="$RANDOM$RANDOM"; RANDOM=4242; ln -s '${path.join(target, "stolen")}' "${agents}/.w-bob.token.$$.$n"`;
    const r = run({ RELAY_INSTANCE_ID: "live" }, plant);
    expect(last(r.stdout), r.stderr).toMatch(/^1 /);
    expect(r.stderr).toContain("something already exists at the temp name");
    expect(fs.existsSync(path.join(target, "stolen")), "nothing written through the planted link").toBe(false);
    expect(fs.existsSync(path.join(agents, "w-bob.token"))).toBe(false);
  });
  it("R2 P2-a: an INHERITED resolution cache (DB A + dir B, exported by a parent) is discarded: the writers re-resolve, and nothing lands under B", () => {
    createInstance("live", "t");
    createInstance("b", "t");
    const script = `set -u\n. '${helper}'\nwrite_relay_token_to_vault w-bob abcdefgh12345678; a=$?\nwrite_relay_spawn_manifest w-bob somerole; b=$?\necho "$a $b"\n`;
    const inherited = { RELAY_RES_LOADED: "1", RELAY_RES_KIND: "explicit-db", RELAY_RES_DB_PATH: path.join(home, "a-db", "relay.db"), RELAY_RES_EXISTS: "true", RELAY_RES_INSTANCE_DIR: instDir("b"), RELAY_RES_LAYOUT_KNOWN: "1" };
    const r = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), RELAY_INSTANCE_ID: "live", ...inherited }, encoding: "utf-8", timeout: 60_000 });
    expect(last(r.stdout), r.stderr).toBe("0 0");
    expect(fs.existsSync(path.join(instDir("live"), "agents", "w-bob.token")), "re-resolved: the instance the environment names").toBe(true);
    expect(fs.existsSync(path.join(instDir("b"), "agents", "w-bob.token")), "nothing under B").toBe(false);
  });
  it("R2 P2-a: an inherited cache with NO mismatch (instance X) is still discarded: the environment's instance (Y) is the one written", () => {
    createInstance("x", "t");
    createInstance("y", "t");
    const script = `set -u\n. '${helper}'\nwrite_relay_token_to_vault w-bob abcdefgh12345678; echo "rc=$?"\n`;
    const inherited = { RELAY_RES_LOADED: "1", RELAY_RES_KIND: "instance", RELAY_RES_DB_PATH: path.join(instDir("x"), "relay.db"), RELAY_RES_EXISTS: "true", RELAY_RES_INSTANCE_DIR: instDir("x"), RELAY_RES_LAYOUT_KNOWN: "1" };
    const r = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), RELAY_INSTANCE_ID: "y", ...inherited }, encoding: "utf-8", timeout: 60_000 });
    expect(r.stdout, r.stderr).toContain("rc=0");
    expect(fs.existsSync(path.join(instDir("y"), "agents", "w-bob.token"))).toBe(true);
    expect(fs.existsSync(path.join(instDir("x"), "agents", "w-bob.token"))).toBe(false);
  });
  it("R2 P2-a: BOUND at write time: this process's own cache naming DB A with directory B (set after the helpers load) → refused, nothing under B", () => {
    createInstance("a", "t");
    createInstance("b", "t");
    const set = `RELAY_RES_LOADED=1 RELAY_RES_KIND=instance RELAY_RES_DB_PATH='${path.join(instDir("a"), "relay.db")}' RELAY_RES_EXISTS=true RELAY_RES_INSTANCE_DIR='${instDir("b")}' RELAY_RES_LAYOUT_KNOWN=1; export RELAY_RES_LOADED RELAY_RES_KIND RELAY_RES_DB_PATH RELAY_RES_EXISTS RELAY_RES_INSTANCE_DIR RELAY_RES_LAYOUT_KNOWN`;
    const script = `set -u\n. '${helper}'\n${set}\nwrite_relay_token_to_vault w-bob abcdefgh12345678; a=$?\nwrite_relay_spawn_manifest w-bob somerole; b=$?\necho "$a $b"\n`;
    const r = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir() }, encoding: "utf-8", timeout: 60_000 });
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(r.stderr).toContain("does not belong to the resolved instance directory");
    expect(fs.existsSync(path.join(instDir("b"), "agents", "w-bob.token"))).toBe(false);
    expect(fs.existsSync(path.join(instDir("a"), "agents", "w-bob.token"))).toBe(false);
  });
  it("a WRONG-CASE explicit RELAY_DB_PATH (case-insensitive file system) + the instance removed after the resolution → refused, nothing re-created", (ctx) => {
    createInstance("gone", "t");
    if (!caseInsensitiveAt(instDir("gone"))) ctx.skip();
    const wrong = path.join(home, ".bot-relay", "INSTANCES", "gone", "relay.db");
    const r = run({ RELAY_DB_PATH: wrong }, `rm -rf '${instDir("gone")}'`);
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(fs.existsSync(instDir("gone"))).toBe(false);
  });
  it("a MALFORMED record (an empty instance.json, no DB) → the resolver refuses it, so the writers do too: the hooks and the TS reader agree", () => {
    createInstance("bad", "t");
    fs.writeFileSync(path.join(instDir("bad"), "instance.json"), "");
    for (const f of fs.readdirSync(instDir("bad"))) if (f !== "instance.json") fs.rmSync(path.join(instDir("bad"), f), { recursive: true, force: true });
    const r = run({ RELAY_INSTANCE_ID: "bad" });
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(fs.existsSync(path.join(instDir("bad"), "agents"))).toBe(false);
  });
  it("the writers called WITHOUT a prior relay_where_load (they load it in their own shell, never only inside a subshell) → both succeed", () => {
    createInstance("live", "t");
    const script = `set -u\n. '${helper}'\nwrite_relay_token_to_vault w-bob abcdefgh12345678; a=$?\nwrite_relay_spawn_manifest w-bob somerole; b=$?\necho "$a $b"\n`;
    const r = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), RELAY_INSTANCE_ID: "live" }, encoding: "utf-8", timeout: 60_000 });
    expect(last(r.stdout), r.stderr).toBe("0 0");
    expect(fs.existsSync(path.join(instDir("live"), "agents", "w-bob.token"))).toBe(true);
  });
  it("an OLDER relay CLI (an 8-line answer, no instance-directory line) → both writers refuse, name both sides, and create NOTHING", () => {
    createInstance("live", "t");
    fs.rmSync(path.join(instDir("live"), "agents"), { recursive: true, force: true });
    const old = path.join(home, "old-relay.js");
    fs.writeFileSync(old, `const r=require("child_process").spawnSync(process.execPath,[${JSON.stringify(CLI)},...process.argv.slice(2)],{encoding:"utf-8",env:process.env});process.stdout.write(r.stdout.split("\\n").slice(0,8).join("\\n")+"\\n");process.exit(r.status??1);\n`);
    const r = run({ RELAY_INSTANCE_ID: "live" }, ":", old);
    expect(last(r.stdout), r.stderr).toBe("1 1");
    expect(r.stderr).toContain("the relay CLI is older than these hooks");
    expect(r.stderr).toContain("update the relay");
    expect(fs.existsSync(path.join(instDir("live"), "agents")), "nothing created on skew").toBe(false);
  });
});
