// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR C — the hooks take the ONE resolver's answer; bash no longer
 * derives the relay DB path.
 *   - SessionStart runs `relay where --json` ONCE, before the mail read, and its
 *     own reads (liveness, anchor, tasks, topology) plus the vault follow it. The
 *     bash containment guard is gone: the resolver owns containment.
 *   - PostToolUse and Stop take the resolution `relay pending --json` embeds (no
 *     extra node start in local mode); the vault is read after the mail read.
 *   - `resolve_relay_db_path` is a shim over the resolver.
 * HARM rows (they must hold): a resolver error is DEGRADED with the resolver's
 * reason, never a mute exit, and nothing goes over HTTP in local mode.
 *
 * Measured with stubs on PATH: `curl` logs every call (the HTTP count), and a
 * `node` wrapper logs every relay CLI verb it starts (the resolver count/order).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = path.join(REPO_ROOT, "hooks");
const DIST_DB = path.join(REPO_ROOT, "dist", "db.js");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048c-")));
const HOME = path.join(ROOT, "home");
const RH = path.join(HOME, ".bot-relay");
const STUBS = path.join(ROOT, "stubs");
const CURL_LOG = path.join(ROOT, "curl.log");
const NODE_LOG = path.join(ROOT, "node.log");
const HEALTH_OK = path.join(ROOT, "health-ok");
const AGENT = "c-agent";
const TASK_TITLE = "TASK-FROM-THE-WRONG-DB";
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

fs.mkdirSync(STUBS, { recursive: true });
// Every call is logged; /health answers only when HEALTH_OK exists (a reachable remote).
fs.writeFileSync(
  path.join(STUBS, "curl"),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> "${CURL_LOG}"\ncase "$*" in *"/health"*) [ -e "${HEALTH_OK}" ] && { echo ok; exit 0; } ;; esac\nexit 7\n`,
  { mode: 0o755 },
);
// Log the relay verb (argv[2] after the CLI path), then run the real node.
fs.writeFileSync(
  path.join(STUBS, "node"),
  `#!/bin/sh\ncase "$1" in */bin/relay) printf '%s\\n' "$2" >> "${NODE_LOG}" ;; esac\nexec "${process.execPath}" "$@"\n`,
  { mode: 0o755 },
);

/** A real relay DB with AGENT registered (and optionally a task for it), built by the real code. */
function seedDb(dbPath: string, withTask: boolean): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    process.env.RELAY_DB_PATH = ${JSON.stringify(dbPath)};
    const db = await import(${JSON.stringify(DIST_DB)});
    db.registerAgent(${JSON.stringify(AGENT)}, "r", []);
    db.registerAgent("c-boss", "r", []);
    if (${withTask}) db.postTask("c-boss", ${JSON.stringify(AGENT)}, ${JSON.stringify(TASK_TITLE)}, "do it", "high");
    db.closeDb();`], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME, RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json") } });
  expect(r.status, r.stderr).toBe(0);
}

function runHook(hook: string, env: Record<string, string> = {}, stdin = "") {
  fs.rmSync(CURL_LOG, { force: true });
  fs.rmSync(NODE_LOG, { force: true });
  const r = spawnSync("bash", [path.join(HOOKS, hook)], {
    encoding: "utf-8",
    timeout: 30_000,
    input: stdin,
    env: {
      PATH: `${STUBS}:${process.env.PATH ?? ""}`,
      HOME,
      RELAY_AGENT_NAME: AGENT,
      RELAY_HTTP_PORT: "1",
      RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json"),
      ...env,
    },
  });
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean) : []);
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    out,
    verdict: (/\[RELAY\] VERDICT=[A-Z-]+[^\n]*/.exec(out) ?? [""])[0],
    curls: read(CURL_LOG),
    verbs: read(NODE_LOG),
  };
}

beforeEach(() => {
  fs.rmSync(HEALTH_OK, { force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
});

describe("ADR-0048 PR C — SessionStart's OWN reads follow the resolver (bash derived a different DB)", () => {
  // Each row: the resolver says error, while the old bash derivation landed on the
  // FLAT DB (which holds a task) and read it. Now: no read of the wrong DB, a
  // DEGRADED verdict naming the resolver's reason, never mute, zero HTTP.
  const rows: Array<[string, () => Record<string, string>, RegExp]> = [
    [
      "a marker naming \"..\" (bash: instances/../relay.db = the flat DB)",
      () => {
        fs.mkdirSync(path.join(RH, "instances"), { recursive: true });
        fs.symlinkSync("..", path.join(RH, "active-instance"));
        return {};
      },
      /path step, not a name/,
    ],
    [
      "RELAY_INSTANCE_ID=\"..\" (the same collapse through the env)",
      () => {
        fs.mkdirSync(path.join(RH, "instances"), { recursive: true });
        return { RELAY_INSTANCE_ID: ".." };
      },
      /path step, not a name/,
    ],
    [
      "`instances` is a regular FILE and there is no marker (bash: the flat DB)",
      () => {
        fs.writeFileSync(path.join(RH, "instances"), "corrupt");
        return {};
      },
      /not a directory/,
    ],
  ];
  for (const [label, setup, reason] of rows) {
    it(label, () => {
      seedDb(path.join(RH, "relay.db"), true);
      const env = setup();
      const r = runHook("check-relay.sh", env);
      expect(r.status, r.out).toBe(0);
      expect(r.out, "no read of the DB the resolver refused").not.toContain(TASK_TITLE);
      expect(r.verdict, r.out).toMatch(/VERDICT=DEGRADED/);
      expect(r.out).toMatch(reason);
      // The resolver's reason holds double quotes (".."): the one-line verdict
      // stays well-formed (every field one quoted value, nothing after the agent).
      expect(r.stdout, "the verdict line is well-formed").toMatch(/^\[RELAY\] VERDICT=DEGRADED reason="[^"]*" agent="[^"]*"$/m);
      expect(r.curls, "zero HTTP in local mode").toEqual([]);
    });
  }
  it("the AMBIGUOUS state (instances, none selected): the AGENT reads the resolver's reason and the fix on stdout; DEGRADED, not the flat DB", () => {
    seedDb(path.join(RH, "relay.db"), true);
    fs.mkdirSync(path.join(RH, "instances", "a"), { recursive: true });
    fs.mkdirSync(path.join(RH, "instances", "b"), { recursive: true });
    const r = runHook("check-relay.sh");
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/\[RELAY\] instance resolution FAILED: .*ambiguous/);
    expect(r.stdout).toMatch(/relay use-instance/);
    expect(r.out).not.toContain(TASK_TITLE);
    expect(r.out, "the legacy DB was not used, so no WRONG INSTANCE claim").not.toContain("WRONG INSTANCE");
    expect(r.verdict).toMatch(/VERDICT=DEGRADED/);
    expect(r.curls).toEqual([]);
  });
  it("the explicit legacy opt-in (RELAY_ALLOW_LEGACY_FALLBACK=1) over that state → WRONG INSTANCE + MUTE (the flat DB IS in use)", () => {
    seedDb(path.join(RH, "relay.db"), false);
    fs.mkdirSync(path.join(RH, "instances", "a"), { recursive: true });
    const r = runHook("check-relay.sh", { RELAY_ALLOW_LEGACY_FALLBACK: "1" });
    expect(r.out).toContain("WRONG INSTANCE");
    expect(r.verdict).toMatch(/VERDICT=MUTE/);
  });
  it("TWIN: a healthy instance layout → the hook reads the RESOLVED instance DB (its task is shown)", () => {
    seedDb(path.join(RH, "instances", "work", "relay.db"), true);
    fs.symlinkSync("work", path.join(RH, "active-instance"));
    const r = runHook("check-relay.sh");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(TASK_TITLE);
    expect(r.out).not.toMatch(/instance resolution failed/);
  });
  it("`relay where` runs ONCE, BEFORE the mail read (`relay pending`)", () => {
    seedDb(path.join(RH, "instances", "work", "relay.db"), false);
    fs.symlinkSync("work", path.join(RH, "active-instance"));
    const r = runHook("check-relay.sh");
    const where = r.verbs.filter((v) => v === "where");
    expect(where, r.verbs.join(",")).toHaveLength(1);
    expect(r.verbs.indexOf("where"), r.verbs.join(",")).toBeLessThan(r.verbs.indexOf("pending"));
  });
});

describe("ADR-0048 PR C — PostToolUse / Stop take pending's embedded resolution (no extra node start locally)", () => {
  for (const hook of ["post-tool-use-check.sh", "stop-check.sh"]) {
    it(`${hook}: a local read starts the relay CLI exactly ONCE (pending), never \`relay where\``, () => {
      seedDb(path.join(RH, "instances", "work", "relay.db"), false);
      fs.symlinkSync("work", path.join(RH, "active-instance"));
      const r = runHook(hook, {}, JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse" }));
      expect(r.verbs, r.out).toEqual(["pending"]);
      expect(r.curls, "zero HTTP in local mode").toEqual([]);
    });
  }
  for (const hook of ["post-tool-use-check.sh", "stop-check.sh"]) {
    it(`${hook}, remote mode: the vault token (beside the resolver's DB, via ONE relay where) is used for the remote read`, () => {
      const token = "vaulttok_" + "x".repeat(20);
      fs.mkdirSync(path.join(RH, "agents"), { recursive: true });
      fs.writeFileSync(path.join(RH, "agents", `${AGENT}.token`), token + "\n", { mode: 0o600 });
      fs.writeFileSync(HEALTH_OK, "");
      const r = runHook(hook, { RELAY_HTTP_HOST: "127.0.0.1" }, JSON.stringify({ session_id: "s1" }));
      expect(r.curls.join("\n"), r.out).toContain(`X-Agent-Token: ${token}`);
      expect(r.verbs.filter((v) => v === "where"), r.verbs.join(",")).toHaveLength(1);
    });
  }
});

describe("ADR-0048 PR C — TRIPWIRES (literal spellings only; the rows above are the guards)", () => {
  const code = (f: string) =>
    fs
      .readFileSync(path.join(HOOKS, f), "utf-8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  it("no hook spells the instance layout (active-instance, instances/): the resolver owns it", () => {
    const hits = fs.readdirSync(HOOKS).filter((f) => f.endsWith(".sh") && /active-instance|\/instances\b/.test(code(f)));
    expect(hits).toEqual([]);
  });
  it("the bash containment guard is gone (no approved-roots spelling in any hook)", () => {
    const hits = fs.readdirSync(HOOKS).filter((f) => f.endsWith(".sh") && /\/var\/folders|\/private\/tmp/.test(code(f)));
    expect(hits).toEqual([]);
  });
});

describe("ADR-0048 PR C — `relay where --fields`: the resolver's answer for bash (one line per field, fail-closed)", () => {
  const where = (env: Record<string, string>) =>
    spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "relay"), "where", "--fields"], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME, ...env },
    });
  it("an instance → kind, db_path, exists, reason, warning, vault_dir (6 lines), exit 0", () => {
    seedDb(path.join(RH, "instances", "work", "relay.db"), false);
    fs.symlinkSync("work", path.join(RH, "active-instance"));
    const r = where({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(0, 6)).toEqual([
      "instance",
      path.join(RH, "instances", "work", "relay.db"),
      "true",
      "",
      "",
      path.join(RH, "instances", "work", "agents"),
    ]);
  });
  it("an error → kind error, the reason on line 4, no path, exit 1", () => {
    const r = where({ RELAY_INSTANCE_ID: ".." });
    expect(r.status).toBe(1);
    const f = r.stdout.split("\n");
    expect(f[0]).toBe("error");
    expect(f[1]).toBe("");
    expect(f[3]).toMatch(/path step/);
  });
  it("a resolved path with a LINE BREAK is refused (kind error), never split across lines", () => {
    const weird = path.join(HOME, "a\nb", "relay.db");
    const r = where({ RELAY_DB_PATH: weird });
    expect(r.status).toBe(1);
    const f = r.stdout.split("\n");
    expect(f[0]).toBe("error");
    expect(f[3]).toMatch(/line break/);
    expect(r.stdout.split("\n").length, "exactly 6 lines + the final newline").toBe(7);
  });
});
