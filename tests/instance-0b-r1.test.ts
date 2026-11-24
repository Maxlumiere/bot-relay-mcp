// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Item 0b, review round 1: (P1, ruled) a component swapped AFTER its validation cannot be prevented without openat,
 * so it is DETECTED after the last write and refused loudly by ROLE, nothing undone; (P2) the metadata reader refuses
 * a STATIC link among its ancestors; (P2) the case detector only trusts a component on the target's own device;
 * (P3) a native failure is phrased by ROLE, never the path; instance.json as a directory leaves no temp file; a FIFO
 * at instance.json never hangs a reader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInstance, _setProvisionSeamForTests } from "../src/instance.js";
import { readInstanceMetadataFile, instanceDirOfDbPath } from "../src/resolve-instance.js";
import * as RESOLVE from "../src/resolve-instance.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_CLAUDE_HOME"] as const;
const POSIX = process.platform !== "win32";
let home: string;
let saved: Record<string, string | undefined>;
const instances = () => path.join(fs.realpathSync(path.join(home, ".bot-relay")), "instances");

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-")));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".bot-relay"), { recursive: true });
});
afterEach(() => {
  _setProvisionSeamForTests(null);
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!POSIX)("P1 (ruled): a component swapped between its validation and the last write is DETECTED and refused by role", () => {
  it("the instance directory replaced inside the window → refused, naming the ROLE (never the path), 'may have been redirected', nothing undone", () => {
    _setProvisionSeamForTests(() => {
      const dir = path.join(instances(), "swapped");
      fs.renameSync(dir, `${dir}-moved`);
      fs.mkdirSync(dir, { mode: 0o700 }); // another directory at the same name: another inode
    });
    let msg = "";
    try {
      createInstance("swapped", "t");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/the instance directory changed while the instance was being provisioned; the operation may have been redirected\. Nothing was undone/);
    expect(msg).not.toContain(home);
    expect(fs.existsSync(path.join(instances(), "swapped-moved")), "nothing undone: the moved directory is left for a person").toBe(true);
  });
  it("R2 P1: a swap AND a failing metadata open → the redirect line FIRST (the swap wins), then the original failure", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r2-ro-"));
    _setProvisionSeamForTests(() => {
      const dir = path.join(instances(), "both");
      fs.renameSync(dir, `${dir}-moved`);
      fs.chmodSync(elsewhere, 0o500); // the record cannot be created there
      fs.symlinkSync(elsewhere, dir);
    });
    let msg = "";
    try {
      createInstance("both", "t");
    } catch (err) {
      msg = (err as Error).message;
    }
    fs.chmodSync(elsewhere, 0o700);
    expect(msg).toMatch(/^refusing: the instance directory changed while the instance was being provisioned; the operation may have been redirected\./);
    expect(msg).toContain("The operation also failed: refusing to provision the instance: its metadata record could not be created");
    expect(msg).not.toContain(home);
    expect(msg).not.toContain(elsewhere);
    expect(fs.readdirSync(elsewhere), "nothing written at the link's target").toEqual([]);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
  it("the CONTROL: with no swap the same provisioning succeeds", () => {
    _setProvisionSeamForTests(() => {});
    expect(createInstance("calm", "t").instance_id).toBe("calm");
  });
});

describe.skipIf(!POSIX)("P2: the metadata reader refuses a STATIC link among its ancestors (no race needed)", () => {
  it("instances/<id> → a directory elsewhere holding a regular instance.json → NOT a record (and its target untouched)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-outside-"));
    fs.writeFileSync(path.join(outside, "instance.json"), JSON.stringify({ instance_id: "x" }));
    fs.mkdirSync(instances(), { recursive: true });
    fs.symlinkSync(outside, path.join(instances(), "x"));
    expect(readInstanceMetadataFile(path.join(instances(), "x"))).toBeNull();
    expect(fs.readFileSync(path.join(outside, "instance.json"), "utf-8")).toBe(JSON.stringify({ instance_id: "x" }));
    fs.rmSync(outside, { recursive: true, force: true });
  });
  it("a LINKED instances/ (its <id> a real directory inside the target) → NOT a record", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-outside-"));
    fs.mkdirSync(path.join(outside, "y"));
    fs.writeFileSync(path.join(outside, "y", "instance.json"), JSON.stringify({ instance_id: "y" }));
    fs.symlinkSync(outside, instances());
    expect(readInstanceMetadataFile(path.join(instances(), "y"))).toBeNull();
    fs.rmSync(outside, { recursive: true, force: true });
  });
  it("the CONTROL: a real instance's record reads", () => {
    createInstance("real", "t");
    expect(readInstanceMetadataFile(path.join(instances(), "real"))).toMatchObject({ instance_id: "real" });
  });
});

describe("ruling c998eaf6: case is never DETECTED; the layout test always folds", () => {
  it("the detector is gone: the resolver exports no case-sensitivity probe", () => {
    expect("fsIsCaseInsensitiveAt" in RESOLVE).toBe(false);
  });
});

describe.skipIf(!POSIX)("R2 P3: no refusal on these paths carries an absolute path", () => {
  it("the link refusals, a provisioning refusal through a linked instances/, the redirect, use-instance: none names the home, the temp dir or a target", async () => {
    const msgs: string[] = [];
    const catchMsg = (f: () => unknown) => {
      try {
        f();
      } catch (err) {
        msgs.push((err as Error).message);
      }
    };
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r2-p3-"));
    fs.mkdirSync(path.join(storage, "x"));
    fs.writeFileSync(path.join(storage, "x", "instance.json"), "{}");
    fs.symlinkSync(storage, instances()); // a linked instances/
    const { resolveInstance, setActiveInstance } = await import("../src/instance.js");
    process.env.RELAY_INSTANCE_ID = "x";
    msgs.push((resolveInstance() as { reason?: string }).reason ?? "");
    catchMsg(() => createInstance("y", "t"));
    catchMsg(() => setActiveInstance("x"));
    fs.unlinkSync(instances());
    createInstance("swap", "t");
    _setProvisionSeamForTests(() => {
      const dir = path.join(instances(), "swap");
      fs.renameSync(dir, `${dir}-moved`);
      fs.mkdirSync(dir);
    });
    catchMsg(() => createInstance("swap", "t"));
    _setProvisionSeamForTests(null);
    expect(msgs.length, msgs.join("\n")).toBe(4);
    for (const m of msgs) {
      expect(m.length, "a refusal").toBeGreaterThan(0);
      expect(m).not.toContain(home);
      expect(m).not.toContain(storage);
      expect(m).not.toContain(fs.realpathSync(os.tmpdir()));
    }
    fs.rmSync(storage, { recursive: true, force: true });
  });
});

describe("P3 + the security fold-ins: role-only errors, no temp left behind, no hang on a FIFO", () => {
  it.skipIf(!POSIX)("a native failure narrowing a component (a swap between the lstat and the open) → a ROLE refusal, never the path", () => {
    const real = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) throw Object.assign(new Error(`ENOTDIR: not a directory, open '${String(p)}'`), { code: "ENOTDIR" });
      return real(p, flags, mode);
    }) as typeof fs.openSync);
    let msg = "";
    try {
      createInstance("narrow", "t");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/the instances directory changed while it was being checked/);
    expect(msg).not.toContain(home);
  });
  it("instance.json that is a DIRECTORY → refused by role ('not a regular file'), no path, and NO temp file left behind", () => {
    fs.mkdirSync(path.join(instances(), "dirrec", "instance.json"), { recursive: true });
    let msg = "";
    try {
      createInstance("dirrec", "t");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toBe("refusing to provision the instance: its metadata record (instance.json) is not a regular file");
    expect(fs.readdirSync(path.join(instances(), "dirrec")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  it.skipIf(!POSIX)("a FIFO at instance.json → the reader returns at once (null) and createInstance never hangs (each in a child with a 5 s timeout)", () => {
    fs.mkdirSync(path.join(instances(), "fifo"), { recursive: true });
    expect(spawnSync("mkfifo", [path.join(instances(), "fifo", "instance.json")]).status).toBe(0);
    const reader = spawnSync(process.execPath, ["-e", `import(require("url").pathToFileURL(process.argv[1]).href).then((m) => process.stdout.write(JSON.stringify(m.readInstanceMetadataFile(process.argv[2]))))`, path.join(REPO, "dist", "resolve-instance.js"), path.join(instances(), "fifo")], { encoding: "utf-8", timeout: 5000 });
    expect([reader.status, reader.stdout]).toEqual([0, "null"]);
    const create = spawnSync(process.execPath, ["-e", `import(require("url").pathToFileURL(process.argv[1]).href).then((m) => { try { m.createInstance("fifo", "t"); process.stdout.write("created"); } catch (e) { process.stdout.write("refused: " + e.message); } })`, path.join(REPO, "dist", "instance.js")], { encoding: "utf-8", timeout: 5000, env: { ...process.env, HOME: home } });
    expect(create.error, "createInstance did not hang").toBeUndefined();
    expect(create.status).toBe(0);
  });
});

describe.skipIf(!POSIX)("ruling 3fc05540: a link BELOW the relay home is never an instance, with its own refusal (read and write)", () => {
  const LINE = /^relay: the instance directory (instances\/a|instances\/) is a symbolic link, which is not allowed below the relay home\. To keep the relay on other storage, move or link the WHOLE relay home \(RELAY_HOME \/ ~\/\.bot-relay\) instead\.$/;
  it("a linked instances/<id> → the specific line (never 'does not exist'); the open refuses and creates nothing", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-storage-"));
    fs.writeFileSync(path.join(storage, "instance.json"), "{}");
    fs.mkdirSync(instances(), { recursive: true });
    fs.symlinkSync(storage, path.join(instances(), "a"));
    process.env.RELAY_INSTANCE_ID = "a";
    const { resolveInstance } = await import("../src/instance.js");
    const r = resolveInstance() as { kind: string; reason?: string };
    expect(r.kind).toBe("error");
    expect(r.reason).toMatch(LINE);
    expect(r.reason).toContain("instances/a ");
    const { initializeDb, closeDb } = await import("../src/db.js");
    await expect(initializeDb()).rejects.toThrow(/is a symbolic link, which is not allowed below the relay home/);
    closeDb();
    expect(fs.readdirSync(storage)).toEqual(["instance.json"]);
    fs.rmSync(storage, { recursive: true, force: true });
  });
  it("a linked instances/<id> holding a relay.db (no record) → the same line: a DB behind a link is NOT a provisioning; the open refuses", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-storage-"));
    fs.writeFileSync(path.join(storage, "relay.db"), "");
    fs.mkdirSync(instances(), { recursive: true });
    fs.symlinkSync(storage, path.join(instances(), "a"));
    process.env.RELAY_INSTANCE_ID = "a";
    const { resolveInstance } = await import("../src/instance.js");
    const r = resolveInstance() as { kind: string; reason?: string };
    expect(r.kind).toBe("error");
    expect(r.reason).toMatch(LINE);
    const { assertInstanceProvisionedAtOpen } = await import("../src/instance.js");
    expect(() => assertInstanceProvisionedAtOpen(path.join(instances(), "a", "relay.db"))).toThrow(/instances\/a is a symbolic link/);
    fs.rmSync(storage, { recursive: true, force: true });
  });
  it("a linked instances/ → the same line, naming instances/", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-storage-"));
    fs.mkdirSync(path.join(storage, "a"));
    fs.writeFileSync(path.join(storage, "a", "instance.json"), "{}");
    fs.symlinkSync(storage, instances());
    process.env.RELAY_INSTANCE_ID = "a";
    const { resolveInstance } = await import("../src/instance.js");
    const r = resolveInstance() as { kind: string; reason?: string };
    expect(r.reason).toMatch(LINE);
    expect(r.reason).toContain("instances/ is a symbolic link");
    fs.rmSync(storage, { recursive: true, force: true });
  });
  it("an ALIAS OUTSIDE the relay home (an explicit RELAY_DB_PATH through ~/alias -> <home>/instances) is only an access path: it resolves as the instance, never the link line", async () => {
    createInstance("ok", "t");
    const alias = path.join(home, "alias-instances");
    fs.symlinkSync(instances(), alias);
    process.env.RELAY_DB_PATH = path.join(alias, "ok", "relay.db");
    const { resolveInstance, assertInstanceProvisionedAtOpen } = await import("../src/instance.js");
    const r = resolveInstance() as { kind: string; reason?: string };
    expect(r.reason ?? "", "never the link line for a link outside the root").not.toMatch(/symbolic link/);
    expect(r.kind).toBe("explicit-db");
    expect(assertInstanceProvisionedAtOpen(path.join(alias, "ok", "relay.db")), "the instance dir, spelled under the root").toBe(path.join(instances(), "ok"));
  });
  it("the same ALIAS when the real instances/<id> IS a link → refused with the line naming instances/<id> (the component that is the link), never the alias", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-storage-"));
    fs.writeFileSync(path.join(storage, "instance.json"), "{}");
    fs.writeFileSync(path.join(storage, "relay.db"), "");
    fs.mkdirSync(instances(), { recursive: true });
    fs.symlinkSync(storage, path.join(instances(), "lnk"));
    const alias = path.join(home, "alias-instances");
    fs.symlinkSync(instances(), alias);
    process.env.RELAY_DB_PATH = path.join(alias, "lnk", "relay.db");
    const { resolveInstance } = await import("../src/instance.js");
    const r = resolveInstance() as { kind: string; reason?: string };
    expect(r.kind).toBe("error");
    expect(r.reason).toContain("the instance directory instances/lnk is a symbolic link");
    expect(r.reason, "never names the alias").not.toContain("alias-instances");
    expect(fs.readdirSync(storage).sort()).toEqual(["instance.json", "relay.db"]);
    fs.rmSync(storage, { recursive: true, force: true });
  });
  it("R2: /outside/alias → instances/link → instances/real: the link traversed BELOW the root is refused, naming instances/link (never the alias, never the real one)", async () => {
    createInstance("real", "t");
    fs.symlinkSync(path.join(instances(), "real"), path.join(instances(), "link"));
    const alias = path.join(home, "outside-alias");
    fs.symlinkSync(path.join(instances(), "link"), alias);
    expect(instanceDirOfDbPath(path.join(alias, "relay.db"), instances()), "the layout dir is the link's own name").toBe(path.join(instances(), "link"));
    process.env.RELAY_DB_PATH = path.join(alias, "relay.db");
    const { resolveInstance } = await import("../src/instance.js");
    const r = resolveInstance() as { kind: string; reason?: string };
    expect(r.kind).toBe("error");
    expect(r.reason).toContain("the instance directory instances/link is a symbolic link");
    expect(r.reason).not.toContain("outside-alias");
  });
  it("R2 P3: use-instance on a LINKED instance → the link refusal, never a generic 'not found'", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r2-storage-"));
    fs.writeFileSync(path.join(storage, "instance.json"), JSON.stringify({ instance_id: "lnk" }));
    fs.mkdirSync(instances(), { recursive: true });
    fs.symlinkSync(storage, path.join(instances(), "lnk"));
    const { setActiveInstance } = await import("../src/instance.js");
    expect(() => setActiveInstance("lnk")).toThrow(/the instance directory instances\/lnk is a symbolic link/);
    fs.rmSync(storage, { recursive: true, force: true });
  });
  it("the CONTROL: a linked relay HOME (the trust root) with real children still resolves the instance", async () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-r1-realhome-"));
    const linkedHome = path.join(home, "linked-relay-home");
    fs.symlinkSync(realHome, linkedHome);
    process.env.RELAY_HOME = linkedHome;
    createInstance("ok", "t");
    process.env.RELAY_INSTANCE_ID = "ok";
    const { resolveInstance } = await import("../src/instance.js");
    expect((resolveInstance() as { kind: string }).kind).toBe("instance");
    fs.rmSync(realHome, { recursive: true, force: true });
  });
});

describe("the mutation fixture (tests/fixtures/instance-0b-mutants.json; run: node scripts/mutation-sweep.mjs <fixture>)", () => {
  it("every mutant still applies: its find text occurs exactly once in its file; names are unique", () => {
    const M = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "instance-0b-mutants.json"), "utf-8")) as Array<{ name: string; file: string; find: string }>;
    expect(M.length).toBeGreaterThanOrEqual(15);
    for (const m of M) expect(fs.readFileSync(path.join(REPO, m.file), "utf-8").split(m.find).length - 1, m.name).toBe(1);
    expect(new Set(M.map((m) => m.name)).size).toBe(M.length);
  });
});

