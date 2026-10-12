// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Codex #291 R2 — two findings, and the rule that keeps the first from recurring.
 *
 * #1 EVERY blocking call in a hook (curl, the relay CLI, sqlite3, the hook's own
 *    stdin read) draws its timeout from the ONE relay_budget_for in
 *    _vault-helpers.sh: never a fixed literal. With under a second left the call
 *    is skipped, LOUD, DEGRADED "no time budget left for <step>".
 *    - measured: timed stubs (a slow resolver, a slow health probe, an HTTP read
 *      that hangs) and a stdin that dribbles forever; every hook ends inside its
 *      installed budget, and every HTTP call ends inside budget minus the margin.
 *    - pinned: a TRIPWIRE over hooks/*.sh that fails on any literal timeout
 *      spelling, with planted literals proving it trips.
 * #2 A resolution field carrying NUL or any C0 control is refused BEFORE a path
 *    is emitted (bash command substitution silently drops a NUL, so an accepted
 *    one would name a different file).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = path.join(REPO_ROOT, "hooks");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048c-r2-")));
const HOME = path.join(ROOT, "home");
const RH = path.join(HOME, ".bot-relay");
const AGENT = "r2-agent";
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
});

/** Installed budgets (src/agent-cli-profiles.ts; each hook declares its own, a test holds them equal). */
const BUDGET: Record<string, number> = { "check-relay.sh": 10, "post-tool-use-check.sh": 5, "stop-check.sh": 5 };
const MARGIN = 3;

// ---------------------------------------------------------------------------
// #1 — the TRIPWIRE. Literal spellings only; the timed rows below are the guards.
// ---------------------------------------------------------------------------

/** The ONLY bodies allowed a literal: the watchdog's own KILL grace. */
const SANCTIONED = ["relay_run_bounded"];
const STEP = String.raw`"\$(?:RELAY_STEP_SECS|\{RELAY_STEP_SECS\})"`;

interface Violation { file: string; rule: string; line: string }

/** Logical lines of a hook: full-line comments dropped, `\` continuations joined, sanctioned bodies cut. */
function logicalLines(src: string): string[] {
  const out: string[] = [];
  let skip = false;
  for (const raw of src.replace(/\\\n\s*/g, " ").split("\n")) {
    if (!skip && SANCTIONED.some((f) => new RegExp(`^${f}\\(\\)\\s*\\{`).test(raw))) { skip = true; continue; }
    if (skip) { if (/^\}/.test(raw)) skip = false; continue; }
    if (/^\s*#/.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

const LITERALS: Array<[string, RegExp]> = [
  ["--max-time N", /--max-time[\s=]*['"]?\d/],
  ["--connect-timeout N", /--connect-timeout[\s=]*['"]?\d/],
  ["timeout/gtimeout N", /(^|[\s;|&(!])g?timeout\s+['"]?\d/],
  ["read -t N", /\bread\b[^;|&]*\s-t\s*['"]?\d/],
  // `alarm 0` CANCELS the alarm: the one allowed literal.
  ["perl alarm N", /\balarm\s*\(?\s*(?!0\b)\d/],
  ["python timeout=N", /\btimeout\s*=\s*\d/],
  ["select() with a literal timeout", /select\.select\([^)]*,\s*\d[\d.]*\s*\)/],
  ["sleep N", /(^|[\s;|&(!])sleep\s+['"]?\d/],
  ["relay_run_* with a literal", /relay_run_(?:pending|bounded|capture)\s+['"]?\d/],
];

function scan(file: string, src: string): Violation[] {
  const v: Violation[] = [];
  for (const line of logicalLines(src)) {
    for (const [rule, re] of LITERALS) if (re.test(line)) v.push({ file, rule, line: line.trim() });
    // curl: `-m` is its timeout (grep -m is not); every call carries the budget.
    if (/(^|[\s;|&(!])curl\s+[-"'$h]/.test(line)) {
      if (/\s-m\s*['"]?\d/.test(line)) v.push({ file, rule: "curl -m N", line: line.trim() });
      if (!new RegExp(String.raw`(?:\s-m|--max-time)\s+${STEP}`).test(line)) v.push({ file, rule: "curl without the budget timeout", line: line.trim() });
    }
    // sqlite3 CLI and the relay CLI run only under the watchdog, at the budget.
    if (/(^|[\s;|&(!])sqlite3\s+[-"'$]/.test(line) && !new RegExp(String.raw`relay_run_capture\s+${STEP}\s+/dev/stdin\s+sqlite3\s`).test(line)) {
      v.push({ file, rule: "sqlite3 outside relay_run_capture", line: line.trim() });
    }
    if (/sqlite3\.connect\(/.test(line) && !/timeout=float\(os\.environ\["RELAY_STEP_SECS"\]\)/.test(line)) {
      v.push({ file, rule: "sqlite3.connect without the budget timeout", line: line.trim() });
    }
    if (/(^|[\s;|&(!])node\s+"\$[A-Za-z_]+"/.test(line) && !/relay_run_(?:pending|bounded)\s+"\$[A-Za-z0-9_{}]+"/.test(line)) {
      v.push({ file, rule: "relay CLI outside the watchdog", line: line.trim() });
    }
  }
  // S1: RELAY_STEP_SECS is set ONLY by relay_budget_for (a hand-set value is a
  // fixed timeout under another name). The one allowed spelling passes it on.
  const owner = file === "_vault-helpers.sh" ? cutBody(src, "relay_budget_for") : src;
  for (const line of logicalLines(owner)) {
    if (/(^|[\s;|&(!])RELAY_STEP_SECS=(?!"\$RELAY_STEP_SECS"(\s|$))/.test(line)) v.push({ file, rule: "RELAY_STEP_SECS set outside relay_budget_for", line: line.trim() });
  }
  // S2 (the hooks): every blocking call has its OWN relay_budget_for since the
  // previous one (a stale RELAY_STEP_SECS is another step's time).
  if (file !== "_vault-helpers.sh") {
    let budgeted = false;
    for (const line of logicalLines(src)) {
      const b = line.search(/relay_budget_for\s+"/);
      const blk = line.search(BLOCKING);
      if (b >= 0 && (blk < 0 || b < blk)) budgeted = true;
      if (blk >= 0) {
        if (!budgeted) v.push({ file, rule: "blocking call without its own relay_budget_for", line: line.trim() });
        budgeted = false;
      }
    }
  }
  return v;
}

/** A blocking call (S2): curl, the watchdog runners, the resolver at a budget, an interpreter handed the budget. */
const BLOCKING = /(?:^|[\s;|&(!])curl\s+[-"'$h]|relay_run_(?:pending|bounded|capture)\s|relay_where_load\s+"[^"]*"\s+"\$RELAY_STEP_SECS"|RELAY_STEP_SECS="\$RELAY_STEP_SECS"\s+(?:python3|perl)\b/;

/** `src` without the body of function `name`. */
function cutBody(src: string, name: string): string {
  const out: string[] = [];
  let skip = false;
  for (const raw of src.split("\n")) {
    if (!skip && new RegExp(`^${name}\\(\\)\\s*\\{`).test(raw)) { skip = true; continue; }
    if (skip) { if (/^\}/.test(raw)) skip = false; continue; }
    out.push(raw);
  }
  return out.join("\n");
}

const hookFiles = () => fs.readdirSync(HOOKS).filter((f) => f.endsWith(".sh"));

describe("Codex #291 R2 #1 — TRIPWIRE: no literal timeout in any hook; every blocking call takes the ONE budget", () => {
  it("hooks/*.sh: zero literal timeout spellings, every curl/sqlite3/relay-CLI call on the budget", () => {
    const all = hookFiles().flatMap((f) => scan(f, fs.readFileSync(path.join(HOOKS, f), "utf-8")));
    expect(all).toEqual([]);
  });

  it("relay_budget_for is defined ONCE, in _vault-helpers.sh (no hook keeps a private copy)", () => {
    const defs = hookFiles().filter((f) => /^relay_budget_for\(\)/m.test(fs.readFileSync(path.join(HOOKS, f), "utf-8")));
    expect(defs).toEqual(["_vault-helpers.sh"]);
  });

  // It must TRIP: each planted spelling is caught; the allowed spellings are not.
  const planted: Array<[string, string]> = [
    ['curl -fsS --max-time 2 "http://x/health"', "--max-time N"],
    ['curl -s -m 4 -X POST "http://x/mcp"', "curl -m N"],
    ['curl -fsS "http://x/health"', "curl without the budget timeout"],
    ['curl --connect-timeout 1 -m "$RELAY_STEP_SECS" "http://x"', "--connect-timeout N"],
    ["X=$(timeout 2 head -c 10)", "timeout/gtimeout N"],
    ["X=$(gtimeout 3 cat)", "timeout/gtimeout N"],
    ["while IFS= read -r -t 1 line; do :; done", "read -t N"],
    ["perl -e 'alarm 2; <STDIN>'", "perl alarm N"],
    ["perl -e 'alarm 10; <STDIN>'", "perl alarm N"],
    ['python3 -c "import sqlite3; sqlite3.connect(p, timeout=1)"', "python timeout=N"],
    ["python3 -c 'select.select([0], [], [], 1.0)'", "select() with a literal timeout"],
    ["sleep 3", "sleep N"],
    ['X=$(sqlite3 "$DB_PATH" "select 1")', "sqlite3 outside relay_run_capture"],
    ['relay_run_pending 4 "$o" "$e" node "$RELAY_CLI" pending', "relay_run_* with a literal"],
    ['node "$RELAY_CLI" pending "$AGENT_NAME" --json', "relay CLI outside the watchdog"],
    ["RELAY_STEP_SECS=2", "RELAY_STEP_SECS set outside relay_budget_for"],
    ['if RELAY_STEP_SECS=60; then :; fi', "RELAY_STEP_SECS set outside relay_budget_for"],
    ['curl -fsS -m "$RELAY_STEP_SECS" "http://x/a"\ncurl -fsS -m "$RELAY_STEP_SECS" "http://x/b"', "blocking call without its own relay_budget_for"],
  ];
  for (const [line, rule] of planted) {
    it(`TRIPS on a planted \`${line}\` (${rule})`, () => {
      const base = fs.readFileSync(path.join(HOOKS, "post-tool-use-check.sh"), "utf-8");
      const v = scan("planted", `${base}\n${line}\n`);
      expect(v.map((x) => x.rule), JSON.stringify(v)).toContain(rule);
    });
  }
  const allowed = [
    'curl -fsS -m "$RELAY_STEP_SECS" "http://x/health"',
    'curl -s --max-time "$RELAY_STEP_SECS" -X POST "http://x/mcp"',
    "why=$(grep -m 1 'PENDING_' \"$errf\")",
    'X=$(relay_run_capture "$RELAY_STEP_SECS" /dev/stdin sqlite3 "$DB_PATH" <<SQL',
    'relay_run_pending "$RELAY_STEP_SECS" "$o" "$e" node "$RELAY_CLI" pending',
    "# a comment may say sleep 3 or --max-time 4",
    "alarm 0;",
    'RELAY_STEP_SECS="$RELAY_STEP_SECS" perl -e 1',
    'relay_budget_for "y" 1 margin && curl -fsS -m "$RELAY_STEP_SECS" "http://x/c"',
  ];
  for (const line of allowed) {
    it(`does not trip on the allowed \`${line}\``, () => {
      const base = fs.readFileSync(path.join(HOOKS, "post-tool-use-check.sh"), "utf-8");
      // Each allowed spelling as it ships: after its own relay_budget_for.
      expect(scan("x", `${base}\nrelay_budget_for "t" 1 margin\n${line}\n`)).toEqual(scan("x", base));
    });
  }

  // The Codex CLI hook (hooks/codex/) has no installed-budget declaration yet: its
  // literals are PINNED, so the set can only shrink. A new one fails here.
  it("hooks/codex/*.sh: the pinned known literals only (a ratchet, not an allowance to grow)", () => {
    const dir = path.join(HOOKS, "codex");
    const v = fs.readdirSync(dir).filter((f) => f.endsWith(".sh")).flatMap((f) => scan(`codex/${f}`, fs.readFileSync(path.join(dir, f), "utf-8")));
    expect(v.map((x) => `${x.file}: ${x.rule}`).sort()).toEqual([
      "codex/codex-session-start.sh: --connect-timeout N",
      "codex/codex-session-start.sh: --max-time N",
      "codex/codex-session-start.sh: blocking call without its own relay_budget_for",
      "codex/codex-session-start.sh: blocking call without its own relay_budget_for",
      "codex/codex-session-start.sh: curl -m N",
      "codex/codex-session-start.sh: curl without the budget timeout",
      "codex/codex-session-start.sh: curl without the budget timeout",
    ]);
  });
});

describe("Codex #291 R2 #1 — relay_budget_for: the ONE arithmetic (own cap vs what is left; skip below 1s, LOUD)", () => {
  const run = (script: string) =>
    spawnSync("bash", ["-c", `. "${path.join(HOOKS, "_vault-helpers.sh")}"; ${script}`], { encoding: "utf-8" });
  const rows: Array<[string, string, string]> = [
    // [label, script, expected stdout]
    ["premail: 10s budget, 0 spent → min(own 4, 10-3-2=5) = 4", "RELAY_HOOK_BUDGET_SECS=10; SECONDS=0; relay_budget_for s 4; echo \"$?:$RELAY_STEP_SECS\"", "0:4"],
    ["premail: 10s budget, 3 spent → min(own 4, 10-3-3-2=2) = 2", "RELAY_HOOK_BUDGET_SECS=10; SECONDS=3; relay_budget_for s 4; echo \"$?:$RELAY_STEP_SECS\"", "0:2"],
    ["margin: 10s budget, 3 spent → min(own 9, 10-3-3=4) = 4 (no mail reserve)", "RELAY_HOOK_BUDGET_SECS=10; SECONDS=3; relay_budget_for s 9 margin; echo \"$?:$RELAY_STEP_SECS\"", "0:4"],
    ["margin: 5s budget, 1 spent → min(own 2, 5-1-3=1) = 1", "RELAY_HOOK_BUDGET_SECS=5; SECONDS=1; relay_budget_for s 2 margin; echo \"$?:$RELAY_STEP_SECS\"", "0:1"],
    ["margin: 5s budget, 2 spent → 0 left → SKIPPED (return 1), the step named", "RELAY_HOOK_BUDGET_SECS=5; SECONDS=2; relay_budget_for \"the x step\" 2 margin; echo \"$?:$RELAY_STEP_SECS:$RELAY_BUDGET_SKIPPED\"", "1:0:the x step"],
    ["premail: 10s budget, 5 spent → 0 left → SKIPPED", "RELAY_HOOK_BUDGET_SECS=10; SECONDS=5; relay_budget_for s 2; echo \"$?:$RELAY_STEP_SECS\"", "1:0"],
    ["the FIRST skipped step is kept", "RELAY_HOOK_BUDGET_SECS=5; SECONDS=4; relay_budget_for a 1 margin; relay_budget_for b 1 margin; echo \"$RELAY_BUDGET_SKIPPED\"", "a"],
    ["a skip calls the hook's relay_budget_skipped with the step", "relay_budget_skipped(){ echo \"CB:$1\"; }; RELAY_HOOK_BUDGET_SECS=5; SECONDS=4; relay_budget_for \"the y step\" 1 margin", "CB:the y step"],
    ["the mail read through the budget: 5s, 2 spent → skipped, never floored to 1", "RELAY_HOOK_BUDGET_SECS=5; SECONDS=2; relay_budget_for m \"$(relay_pending_deadline 5)\" margin; echo \"$?:$RELAY_STEP_SECS\"", "1:0"],
    ["the mail read keeps its override: RELAY_PENDING_TIMEOUT_SECS=1 shortens it", "RELAY_HOOK_BUDGET_SECS=10; SECONDS=0; RELAY_PENDING_TIMEOUT_SECS=1 relay_budget_for m \"$(RELAY_PENDING_TIMEOUT_SECS=1 relay_pending_deadline 10)\" margin; echo \"$?:$RELAY_STEP_SECS\"", "0:1"],
  ];
  for (const [label, script, want] of rows) {
    it(label, () => {
      const r = run(script);
      expect(r.stdout.trim(), r.stderr).toBe(want);
    });
  }
  it("a skip is LOUD on stderr: 'no time budget left for STEP'", () => {
    const r = run('RELAY_HOOK_BUDGET_SECS=5; SECONDS=4; relay_budget_for "the z step" 1 margin');
    expect(r.stderr).toMatch(/\[bot-relay\] no time budget left for the z step \(4s of 5s spent\): skipped\./);
  });
});

// ---------------------------------------------------------------------------
// #1 — MEASURED: timed stubs on PATH, the remote path of all three hooks.
// ---------------------------------------------------------------------------

/**
 * curl: honours -m/--max-time; each kind of call (read from argv and any `-K -` config) takes STUB_D_<kind> seconds and
 * answers only when it fits its cap. Logs "kind cap elapsed" (elapsed from T0,
 * sub-second). node: `relay where` takes STUB_WHERE seconds, then the real node.
 */
function stubs(dir: string): { curlLog: string; nodeLog: string } {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const curlLog = path.join(dir, "curl.log");
  const nodeLog = path.join(dir, "node.log");
  fs.writeFileSync(
    path.join(dir, "curl"),
    [
      "#!/bin/sh",
      'm=""; prev=""; for a in "$@"; do case "$prev" in -m|--max-time) m="$a" ;; esac; prev="$a"; done',
      // A body can ride curl's config on STDIN (`-K -`, how the hooks send a token): classify on argv AND config.
      'cfg=""; case " $* " in *" -K - "*) cfg=$(cat) ;; esac',
      'k=other; case "$* $cfg" in *get_messages*) k=mail ;; *health_check*) k=hcheck ;; *register_agent*) k=register ;; *report_liveness*) k=liveness ;; */health*) k=health ;; esac',
      "now=$(perl -MTime::HiRes=time -e 'printf \"%.3f\", time')",
      `printf '%s %s %s\\n' "$k" "$m" "$(awk -v a="$now" -v b="$T0" 'BEGIN{printf "%.3f", a-b}')" >> "${curlLog}"`,
      'eval d=\\${STUB_D_$k:-0.1}',
      `if [ -n "$m" ] && awk -v d="$d" -v m="$m" 'BEGIN{exit !(d > m)}'; then sleep "$m"; exit 28; fi`,
      'sleep "$d"',
      'eval ok=\\${STUB_OK_$k:-0}',
      '[ "$ok" = 1 ] && { echo ok; exit 0; }',
      "exit 28",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, "node"),
    `#!/bin/sh\ncase "$1" in */bin/relay) printf '%s\\n' "$2" >> "${nodeLog}"; [ "$2" = where ] && sleep "\${STUB_WHERE:-0}" ;; esac\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  return { curlLog, nodeLog };
}

function timed(hook: string, tag: string, env: Record<string, string>, input = "", hooksDir = HOOKS) {
  const dir = path.join(ROOT, `stubs-${tag}`);
  const { curlLog, nodeLog } = stubs(dir);
  const t0 = Date.now() / 1000;
  const r = spawnSync("bash", [path.join(hooksDir, hook)], {
    encoding: "utf-8",
    timeout: 30_000,
    input,
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      HOME,
      RELAY_AGENT_NAME: AGENT,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: "1",
      RELAY_HOOK_NOTICE_REMIND_SECS: "0",
      RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json"),
      T0: t0.toFixed(3),
      ...env,
    },
  });
  const secs = Date.now() / 1000 - t0;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean) : []);
  const curls = lines(curlLog).map((l) => { const [kind, cap, at] = l.split(" "); return { kind, cap: cap ? Number(cap) : NaN, at: Number(at) }; });
  return { secs, out, curls, verbs: lines(nodeLog), verdict: (/\[RELAY\] VERDICT=[^\n]*/.exec(out) ?? [""])[0] };
}

/**
 * The property, for every HTTP call a hook made: it had a cap, and its cap ends
 * inside the budget minus the report margin. Slack: SECONDS truncates (up to 1s
 * unseen by the hook) and the process start (0.5s).
 */
function expectEveryCallInsideTheBudget(r: ReturnType<typeof timed>, budget: number): void {
  for (const c of r.curls) {
    expect(Number.isFinite(c.cap) && c.cap >= 1, `a ${c.kind} call without a budget cap: ${JSON.stringify(r.curls)}\n${r.out}`).toBe(true);
    expect(c.at + c.cap, `the ${c.kind} call (at ${c.at}s, cap ${c.cap}s) runs past ${budget}s - ${MARGIN}s margin: ${JSON.stringify(r.curls)}`).toBeLessThanOrEqual(budget - MARGIN + 1.5);
  }
}

function vaultToken(): string {
  const token = "vaulttok_" + "r".repeat(20);
  fs.mkdirSync(path.join(RH, "agents"), { recursive: true });
  fs.writeFileSync(path.join(RH, "agents", `${AGENT}.token`), token + "\n", { mode: 0o600 });
  return token;
}

describe("Codex #291 R2 #1 — REMOTE path: after the resolver, every HTTP call draws on what is LEFT", () => {
  for (const hook of ["post-tool-use-check.sh", "stop-check.sh"]) {
    // Codex's measurement (5.218s against 5s). Load decides WHICH step runs out
    // (the probe may even fail first), so this row holds only what must hold in
    // every case; the skip verdict is pinned by the deterministic row below.
    it(`${hook}: a slow resolver + a slow health probe + a hanging read → inside the ${BUDGET[hook]}s budget, the late read never started`, () => {
      vaultToken();
      const r = timed(hook, `a-${hook}`, { STUB_WHERE: "1.4", STUB_D_health: "0.9", STUB_OK_health: "1", STUB_D_mail: "8" }, JSON.stringify({ session_id: "s1" }));
      expect(r.verbs, r.out).toContain("where");
      expect(r.secs, r.out).toBeLessThan(BUDGET[hook]);
      expectEveryCallInsideTheBudget(r, BUDGET[hook]);
      expect(r.curls.map((c) => c.kind), "the read that no longer fits is never started").not.toContain("mail");
      expect(r.verdict, r.out).not.toMatch(/VERDICT=HEALTHY/);
    }, 40_000);

    it(`${hook}: TWIN — a fast resolver and a healthy remote: the read runs, capped by what is left`, () => {
      vaultToken();
      const r = timed(hook, `b-${hook}`, { STUB_D_health: "0.1", STUB_OK_health: "1", STUB_D_mail: "8" }, JSON.stringify({ session_id: "s1" }));
      expect(r.curls.map((c) => c.kind), r.out).toEqual(["health", "mail"]);
      expectEveryCallInsideTheBudget(r, BUDGET[hook]);
      expect(r.secs, r.out).toBeLessThan(BUDGET[hook]);
    }, 40_000);
  }

  it("check-relay.sh: a resolver that would take 7.5s is cut at its pre-mail share, so the mail read still runs", () => {
    const r = timed("check-relay.sh", "w", { RELAY_AGENT_TOKEN: "tok_" + "w".repeat(20), STUB_WHERE: "7.5", STUB_D_mail: "8" });
    expect(r.out).toMatch(/relay where timed out after [1-5]s/);
    expect(r.verbs, r.out).toContain("pending");
    expectEveryCallInsideTheBudget(r, 10);
    expect(r.secs, r.out).toBeLessThan(10);
  }, 40_000);

  it("check-relay.sh: a slow resolver (4.5s) + a remote mail read that hangs → the read's cap is what is LEFT (never a fixed 4s); inside the 10s budget", () => {
    const r = timed("check-relay.sh", "c", { RELAY_AGENT_TOKEN: "tok_" + "s".repeat(20), STUB_WHERE: "4.5", STUB_D_mail: "8" });
    expect(r.verbs, r.out).toEqual(expect.arrayContaining(["where", "pending"]));
    expect(r.curls.map((c) => c.kind), r.out).toContain("mail");
    expectEveryCallInsideTheBudget(r, 10);
    expect(r.secs, r.out).toBeLessThan(10);
  }, 40_000);
});

/**
 * A copy of the hooks whose relay_budget_for grants NO time to the steps matching
 * RELAY_TEST_STARVE (a case pattern), and passes every other step through
 * unchanged. The REAL relay_budget_for then takes its skip path, so the hooks'
 * own skip handling runs deterministically: no wall-clock race (bash's SECONDS
 * ticks on whole wall-clock seconds, so a timed row can never pin "no time left").
 */
function starvedTree(tag: string): string {
  const base = path.join(ROOT, `starved-${tag}`, "bot-relay-mcp");
  fs.rmSync(path.dirname(base), { recursive: true, force: true });
  fs.cpSync(HOOKS, path.join(base, "hooks"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, "bin"), path.join(base, "bin"));
  fs.appendFileSync(
    path.join(base, "hooks", "_vault-helpers.sh"),
    [
      "",
      "# TEST ONLY (starvedTree): starve the steps matching RELAY_TEST_STARVE.",
      `eval "$(declare -f relay_budget_for | sed '1s/^relay_budget_for/relay_budget_for_real/')"`,
      'relay_budget_for() { case "$1" in $RELAY_TEST_STARVE) relay_budget_for_real "$1" 0 "${3:-}" ;; *) relay_budget_for_real "$@" ;; esac; }',
      "",
    ].join("\n"),
  );
  return path.join(base, "hooks");
}

describe("Codex #291 R2 #1 — a step with no time left is SKIPPED and said (the hooks' own skip handling, deterministic)", () => {
  for (const hook of ["post-tool-use-check.sh", "stop-check.sh"]) {
    it(`${hook}: no time for the remote health probe → NO HTTP call; DEGRADED "no time budget left for the remote read"`, () => {
      const r = timed(hook, `sh-${hook}`, { RELAY_AGENT_TOKEN: "tok_" + "h".repeat(20), RELAY_TEST_STARVE: "the remote health probe", STUB_D_health: "0.1", STUB_OK_health: "1" }, JSON.stringify({ session_id: "s1" }), starvedTree(`h-${hook}`));
      expect(r.curls, r.out).toEqual([]);
      expect(r.out).toMatch(/\[bot-relay\] no time budget left for the remote health probe/);
      expect(r.verdict, r.out).toMatch(/VERDICT=DEGRADED reason="no time budget left for the remote read"/);
    });
    it(`${hook}: no time for the remote mail read → the probe runs, the READ never starts; DEGRADED`, () => {
      const r = timed(hook, `sm-${hook}`, { RELAY_AGENT_TOKEN: "tok_" + "m".repeat(20), RELAY_TEST_STARVE: "the remote mail read", STUB_D_health: "0.1", STUB_OK_health: "1", STUB_D_mail: "8" }, JSON.stringify({ session_id: "s1" }), starvedTree(`m-${hook}`));
      expect(r.curls.map((c) => c.kind), r.out).toEqual(["health"]);
      expect(r.verdict, r.out).toMatch(/VERDICT=DEGRADED reason="no time budget left for the remote read"/);
    });
    it(`${hook}: TWIN — nothing starved: probe and read both run, never DEGRADED for time`, () => {
      const r = timed(hook, `sn-${hook}`, { RELAY_AGENT_TOKEN: "tok_" + "n".repeat(20), RELAY_TEST_STARVE: "no-such-step", STUB_D_health: "0.1", STUB_OK_health: "1", STUB_D_mail: "0.1" }, JSON.stringify({ session_id: "s1" }), starvedTree(`n-${hook}`));
      expect(r.curls.map((c) => c.kind), r.out).toEqual(["health", "mail"]);
      expect(r.out).not.toMatch(/no time budget left/);
    });
  }
  it("check-relay.sh: no time for the remote mail read → never started; the agent is told; DEGRADED", () => {
    const r = timed("check-relay.sh", "s-ss", { RELAY_AGENT_TOKEN: "tok_" + "q".repeat(20), RELAY_TEST_STARVE: "the remote mail read", STUB_D_mail: "0.1", STUB_OK_mail: "1" }, "", starvedTree("ss"));
    expect(r.curls.map((c) => c.kind), r.out).not.toContain("mail");
    expect(r.out).toMatch(/\[RELAY\] remote relay read failed/);
    expect(r.verdict, r.out).toMatch(/VERDICT=DEGRADED[^\n]*no time budget left for the remote mail read/);
  });
  it("check-relay.sh: no time for the resolver → it is never started; resolution FAILED is said", () => {
    const r = timed("check-relay.sh", "s-res", { RELAY_AGENT_TOKEN: "tok_" + "r".repeat(20), RELAY_TEST_STARVE: "the resolver" }, "", starvedTree("res"));
    expect(r.verbs, r.out).not.toContain("where");
    expect(r.out).toMatch(/instance resolution FAILED: no time budget left to ask the resolver/);
  });
});

describe("Codex #291 R2 #1 — SessionStart's sqlite3 reads run under the watchdog, at what is left", () => {
  it("a sqlite3 that takes 5s per call → each read is cut at its cap, the task read is TOLD, DEGRADED; inside the 10s budget", () => {
    const dbPath = path.join(RH, "relay.db");
    fs.mkdirSync(RH, { recursive: true });
    const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      process.env.RELAY_DB_PATH = ${JSON.stringify(dbPath)};
      const db = await import(${JSON.stringify(path.join(REPO_ROOT, "dist", "db.js"))});
      db.registerAgent(${JSON.stringify(AGENT)}, "r", []);
      db.closeDb();`], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME } });
    expect(seed.status, seed.stderr).toBe(0);
    const dir = path.join(ROOT, "slow-sqlite");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const real = spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf-8" }).stdout.trim();
    fs.writeFileSync(path.join(dir, "sqlite3"), `#!/bin/sh\nsleep 5\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const t0 = Date.now();
    const r = spawnSync("bash", [path.join(HOOKS, "check-relay.sh")], {
      encoding: "utf-8",
      timeout: 30_000,
      input: "",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME, RELAY_AGENT_NAME: AGENT, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json") },
    });
    const secs = (Date.now() - t0) / 1000;
    const out = `${r.stdout}\n${r.stderr}`;
    expect(secs, out).toBeLessThan(10);
    expect(r.stdout, out).toMatch(/\[RELAY\] active tasks for r2-agent were not read in this hook's time budget\. Call get_tasks/);
    expect(out).toMatch(/VERDICT=DEGRADED[^\n]*the task read timed out after \d+s/);
  }, 40_000);
});

describe("Codex #291 R2 #1 — the hook's OWN stdin read is on the budget too (a writer that dribbles and never closes)", () => {
  for (const hook of ["check-relay.sh", "post-tool-use-check.sh", "stop-check.sh"]) {
    it(`${hook}: a line every 0.4s, never closed → the hook still ends inside its ${BUDGET[hook]}s budget`, async () => {
      const child = spawn("bash", [path.join(HOOKS, hook)], {
        env: { PATH: process.env.PATH ?? "", HOME, RELAY_AGENT_NAME: AGENT, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json") },
      });
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on("error", () => {});
      const t0 = Date.now();
      const drip = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write('{"session_id":"s1"}\n'); }, 400);
      // The bound must be ABLE to fail: a hook that never ends is killed at 15s and reads as 15s.
      const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await new Promise((res) => child.on("close", res));
      clearInterval(drip);
      clearTimeout(killer);
      expect((Date.now() - t0) / 1000).toBeLessThan(BUDGET[hook]);
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// #2 — NUL / C0 controls in a resolution field: refused before any path leaves.
// ---------------------------------------------------------------------------

describe("Codex #291 R2 #2 — a resolution field with NUL or any C0 control is refused before a path is emitted", () => {
  const validate = (json: string) =>
    spawnSync("bash", ["-c", `. "${path.join(HOOKS, "_vault-helpers.sh")}"; relay_pending_resolution_db "$1"; echo "|rc=$?"`, "bash", json], { encoding: "utf-8" });
  const res = (over: Record<string, unknown>) =>
    JSON.stringify({ ok: true, resolution: { kind: "instance", id: "a", db_path: "/x/instances/a/relay.db", exists: true, basis: "active-instance", ...over } });
  const bad: Array<[string, Record<string, unknown>]> = [
    ["NUL in db_path (Codex's case: bash would drop it and name another file)", { db_path: "/x/instances/a/relay.db\u0000.evil" }],
    ["ESC in db_path", { db_path: "/x/\u001b[31m/relay.db" }],
    ["TAB in db_path", { db_path: "/x/a\tb/relay.db" }],
    ["DEL in db_path", { db_path: "/x/a\u007fb/relay.db" }],
    ["NUL in another field (id)", { id: "a\u0000b" }],
    ["a C0 control in a nested field", { detail: { note: "x\u0001y" } }],
  ];
  for (const [label, over] of bad) {
    it(`relay_pending_resolution_db refuses ${label}`, () => {
      const r = validate(res(over));
      expect(r.stdout, r.stderr).toBe("|rc=1\n");
    });
  }
  it("TWIN: a clean resolution → the path, rc 0", () => {
    expect(validate(res({})).stdout).toBe("/x/instances/a/relay.db|rc=0\n");
  });

  it("relay_where_load refuses a path line carrying a C0 control (never exported)", () => {
    const f = path.join(ROOT, "fake-c0.js");
    fs.writeFileSync(f, `process.stdout.write(${JSON.stringify("flat\n/tmp/a\u001bb.db\nfalse\n\n\n/tmp/agents\n")}); process.exit(0);\n`);
    const r = spawnSync("bash", ["-c", `. "${path.join(HOOKS, "_vault-helpers.sh")}"; RELAY_HOOK_BUDGET_SECS=10; relay_where_load "$1"; echo "rc=$? kind=$RELAY_RES_KIND db=$RELAY_RES_DB_PATH"`, "bash", f], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME } });
    expect(r.stdout, r.stderr).toMatch(/^rc=1 kind=error db=$/m);
  });

  it("`relay where --fields` refuses a resolved path with a C0 control (kind error, exit 1, exactly 6 lines)", () => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "relay"), "where", "--fields"], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME, RELAY_DB_PATH: path.join(HOME, "a\u001bb", "relay.db") },
    });
    expect(r.status).toBe(1);
    const f = r.stdout.split("\n");
    expect(f[0]).toBe("error");
    expect(f[1]).toBe("");
    expect(f[3]).toMatch(/control character/);
    expect(f.length, "exactly 6 lines + the final newline").toBe(7);
  });

  it("`relay where --fields`: a control character in the REASON becomes a space (the line stays one clean line)", () => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "relay"), "where", "--fields"], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME, RELAY_INSTANCE_ID: "a\u001bb" },
    });
    const f = r.stdout.split("\n");
    expect(f[0]).toBe("error");
    expect(f[3]).toContain('"a b"');
    expect(/[\x00-\x1f\x7f]/.test(f[3])).toBe(false);
  });

  for (const hook of ["post-tool-use-check.sh", "stop-check.sh"]) {
    it(`${hook}: a pending answer whose resolution path carries a NUL → DEGRADED, never HEALTHY`, () => {
      const base = path.join(ROOT, `tree-nul-${hook}`, "bot-relay-mcp");
      fs.rmSync(path.dirname(base), { recursive: true, force: true });
      fs.cpSync(HOOKS, path.join(base, "hooks"), { recursive: true });
      fs.mkdirSync(path.join(base, "bin"), { recursive: true });
      const env = { ok: true, agent: AGENT, db_path: "/x/relay.db", session_bound: false, count: 0, top_priority: null, messages: [], resolution: { kind: "flat", db_path: path.join(RH, "relay.db") + "\u0000x", exists: true, basis: "no-instances" } };
      fs.writeFileSync(path.join(base, "bin", "relay"), `process.stdout.write(${JSON.stringify(JSON.stringify(env) + "\n")}); process.exit(0);\n`);
      const r = spawnSync("bash", [path.join(base, "hooks", hook)], {
        encoding: "utf-8",
        timeout: 30_000,
        input: JSON.stringify({ session_id: "s1" }),
        env: { PATH: process.env.PATH ?? "", HOME, RELAY_AGENT_NAME: AGENT, RELAY_AGENT_TOKEN: "tok_" + "y".repeat(20), RELAY_HTTP_PORT: "1" },
      });
      const out = `${r.stdout}\n${r.stderr}`;
      expect((/VERDICT=([A-Z-]+)/.exec(out) ?? [])[1], out).toBe("DEGRADED");
    });
  }
});
