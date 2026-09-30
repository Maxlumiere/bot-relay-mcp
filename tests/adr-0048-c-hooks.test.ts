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

describe("Codex #291 R1 #3 — relay_where_load exposes a path ONLY from a successful, COMPLETE answer", () => {
  /** A fake relay CLI (a node script) that prints `out` and exits `rc`. */
  function fakeCli(name: string, out: string, rc: number): string {
    const f = path.join(ROOT, `fake-${name}.js`);
    fs.writeFileSync(f, `process.stdout.write(${JSON.stringify(out)}); process.exit(${rc});\n`);
    return f;
  }
  const load = (cli: string) =>
    spawnSync("bash", ["-c", `. "${path.join(HOOKS, "_vault-helpers.sh")}"; relay_where_load "$1"; echo "rc=$? kind=$RELAY_RES_KIND db=$RELAY_RES_DB_PATH"; resolve_relay_db_path; echo "shim=$?"`, "bash", cli], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME },
    });
  const cases: Array<[string, string, number]> = [
    ["partial output from a FAILED command (Codex's case)", "flat\n/tmp/partial.db\n", 1],
    ["a complete-looking path answer with a non-zero exit", "flat\n/tmp/p.db\ntrue\n\n\n/tmp/agents\n", 1],
    ["exit 0 but a field missing (no vault line)", "flat\n/tmp/p.db\ntrue\n\n\n", 0],
    ["exit 0 but `exists` is not true/false", "flat\n/tmp/p.db\nmaybe\n\n\n/tmp/agents\n", 0],
    ["exit 0 but an unknown kind", "bogus\n/tmp/p.db\ntrue\n\n\n/tmp/agents\n", 0],
    ["an error answer that exits 0", "error\n\n\nboom\n\n\n", 0],
  ];
  for (const [label, out, rc] of cases) {
    it(`refused: ${label}`, () => {
      const r = load(fakeCli(label.replace(/\W+/g, "-"), out, rc));
      expect(r.stdout, r.stderr).toMatch(/kind=error db=$/m);
      expect(r.stdout).toMatch(/shim=1/);
      expect(r.stdout).not.toMatch(/\/tmp\/p(artial)?\.db\n/);
      // Never the answer's own claims: the reason names what was wrong with the run.
      expect(r.stderr).not.toMatch(/instance resolution failed: boom/);
    });
  }
  it("TWIN: a complete path answer with exit 0 is accepted", () => {
    const r = load(fakeCli("ok", "flat\n/tmp/ok.db\nfalse\n\n\n/tmp/agents\n", 0));
    expect(r.stdout).toMatch(/kind=flat db=\/tmp\/ok\.db/);
    expect(r.stdout).toMatch(/^\/tmp\/ok\.db$/m);
    expect(r.stdout).toMatch(/shim=0/);
  });
  it("TWIN: a complete error answer (exit 1) is the resolver's error, with its reason", () => {
    const r = load(fakeCli("err", "error\n\n\nthe reason\n\n\n", 1));
    expect(r.stdout).toMatch(/kind=error/);
    expect(r.stderr).toMatch(/instance resolution failed: the reason/);
  });
});

describe("Codex #291 R1 #2 — PostToolUse / Stop trust a pending answer only with a VALID embedded resolution", () => {
  const SQLITE_LOG = path.join(ROOT, "sqlite.log");
  /** A copy of the hooks whose bin/relay prints `envelope` (exit 0); sqlite3 logs every DB it is handed. */
  function hookTree(tag: string, envelope: unknown): string {
    const base = path.join(ROOT, `tree-${tag}`, "bot-relay-mcp");
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
    fs.cpSync(HOOKS, path.join(base, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(base, "bin"), { recursive: true });
    fs.writeFileSync(path.join(base, "bin", "relay"), `process.stdout.write(${JSON.stringify(JSON.stringify(envelope) + "\n")}); process.exit(0);\n`);
    fs.writeFileSync(path.join(STUBS, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\nexit 1\n`, { mode: 0o755 });
    return path.join(base, "hooks");
  }
  const envelope = (resolution: unknown) => ({ ok: true, agent: AGENT, db_path: "/x/relay.db", resolution, session_bound: false, count: 0, top_priority: null, messages: [] });
  const run = (hooksDir: string, hook: string) => {
    fs.rmSync(SQLITE_LOG, { force: true });
    const r = spawnSync("bash", [path.join(hooksDir, hook)], {
      encoding: "utf-8",
      timeout: 30_000,
      input: JSON.stringify({ session_id: "s1" }),
      env: { PATH: `${STUBS}:${process.env.PATH ?? ""}`, HOME, RELAY_AGENT_NAME: AGENT, RELAY_AGENT_TOKEN: "tok_" + "y".repeat(20), RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json") },
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    return { out, verdict: (/VERDICT=([A-Z-]+)/.exec(out) ?? [])[1], sqlite: fs.existsSync(SQLITE_LOG) ? fs.readFileSync(SQLITE_LOG, "utf-8") : "" };
  };
  const bad: Array<[string, unknown]> = [
    ["a MISSING resolution", undefined],
    ["the ERROR kind", { kind: "error", reason: "x" }],
    ["an unknown kind with a wrong path", { kind: "bogus", db_path: "/wrong/database", exists: true }],
    ["`exists` not a boolean", { kind: "instance", id: "a", db_path: "/wrong/database", exists: "yes", basis: "active-instance" }],
  ];
  for (const hook of ["post-tool-use-check.sh", "stop-check.sh"]) {
    for (const [label, res] of bad) {
      it(`${hook}: ${label} → DEGRADED, never HEALTHY, and the path is never read`, () => {
        const r = run(hookTree(`${hook}-${label.replace(/\W+/g, "-")}`, envelope(res)), hook);
        expect(r.verdict, r.out).toBe("DEGRADED");
        expect(r.sqlite, "the invalid path was never handed to a reader").not.toContain("/wrong/database");
      });
    }
    it(`${hook}: TWIN — a valid resolution → HEALTHY`, () => {
      const r = run(hookTree(`${hook}-ok`, envelope({ kind: "instance", id: "a", db_path: path.join(RH, "instances", "a", "relay.db"), exists: true, basis: "active-instance" })), hook);
      expect(r.verdict, r.out).toBe("HEALTHY");
    });
  }
});

describe("Codex #291 R1 #1 — SessionStart: the pre-mail steps can never eat the mail read's time or pass the installed budget", () => {
  const SLOW = path.join(ROOT, "slow-stubs");
  const SLOW_NODE_LOG = path.join(ROOT, "slow-node.log");
  const CURL_CAPS = path.join(ROOT, "curl-caps.log");
  /** node: `relay where` takes WHERE_SECS; curl: honours -m/--max-time, each call takes its own time. */
  function slowStubs(whereSecs: number): void {
    fs.rmSync(SLOW, { recursive: true, force: true });
    fs.mkdirSync(SLOW, { recursive: true });
    fs.writeFileSync(
      path.join(SLOW, "node"),
      `#!/bin/sh\ncase "$1" in */bin/relay) printf '%s\\n' "$2" >> "${SLOW_NODE_LOG}"; [ "$2" = where ] && sleep ${whereSecs} ;; esac\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(SLOW, "curl"),
      [
        "#!/bin/sh",
        'm=""; prev=""; for a in "$@"; do case "$prev" in -m|--max-time) m="$a" ;; esac; prev="$a"; done',
        'd=1; case "$*" in *health_check*) d=2 ;; *register_agent*) d=4 ;; esac',
        `k=other; case "$*" in *health_check*) k=health ;; *register_agent*) k=register ;; esac; printf '%s %s\\n' "$k" "$m" >> "${CURL_CAPS}"`,
        '[ -n "$m" ] && [ "$m" -lt "$d" ] && d="$m"',
        'sleep "$d"; exit 28',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  function timedRun(whereSecs: number) {
    slowStubs(whereSecs);
    fs.rmSync(SLOW_NODE_LOG, { force: true });
    fs.rmSync(CURL_CAPS, { force: true });
    seedDb(path.join(RH, "instances", "work", "relay.db"), false);
    fs.symlinkSync("work", path.join(RH, "active-instance"));
    const t0 = Date.now();
    const r = spawnSync("bash", [path.join(HOOKS, "check-relay.sh")], {
      encoding: "utf-8",
      timeout: 30_000,
      input: "",
      env: {
        PATH: `${SLOW}:${process.env.PATH ?? ""}`,
        HOME,
        RELAY_AGENT_NAME: AGENT,
        RELAY_AGENT_TOKEN: "tok_" + "z".repeat(20),
        RELAY_HTTP_PORT: "1",
        RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json"),
      },
    });
    const secs = (Date.now() - t0) / 1000;
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const verbs = fs.existsSync(SLOW_NODE_LOG) ? fs.readFileSync(SLOW_NODE_LOG, "utf-8").split("\n").filter(Boolean) : [];
    const caps = fs.existsSync(CURL_CAPS) ? fs.readFileSync(CURL_CAPS, "utf-8").split("\n").filter(Boolean).map((l) => l.split(" ")) : [];
    return { secs, out, verbs, caps, verdict: (/\[RELAY\] VERDICT=[^\n]*/.exec(out) ?? [""])[0] };
  }
  it("a slow resolver (3s) + a 2s health check + a 4s registration: done inside the 10s budget, the mail read still ran, the skip is DEGRADED", () => {
    const r = timedRun(3);
    expect(r.secs, r.out).toBeLessThan(9.5);
    expect(r.verbs, "the mail read ran").toContain("pending");
    expect(r.verdict, r.out).toMatch(/VERDICT=DEGRADED[^\n]*no time budget left for/);
    // Each step's own cap never exceeds what is left before the mail read's
    // reserve: after a 3s resolver, 10 - 3 - 3 (margin) - 2 (reserve) = 2s.
    const health = r.caps.find(([k]) => k === "health");
    expect(health, JSON.stringify(r.caps)).toBeDefined();
    expect(Number(health![1]), "the health check's cap is within the budget left").toBeLessThanOrEqual(2);
  }, 40_000);
  it("a resolver that would take 6s is stopped at its share: inside the budget, the mail read still ran, DEGRADED", () => {
    const r = timedRun(6);
    expect(r.secs, r.out).toBeLessThan(9.5);
    expect(r.verbs, "the mail read ran").toContain("pending");
    expect(r.verdict, r.out).toMatch(/VERDICT=DEGRADED/);
  }, 40_000);
});
