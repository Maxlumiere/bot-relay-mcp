// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A hook's EXIT trap belongs to the hook's MAIN shell, never to a subshell.
 *
 * relay_run_bounded (hooks/_vault-helpers.sh) starts a watchdog `( … ) >/dev/null 2>&1 &` and, when the
 * watched command ends, ends it with SIGTERM. A TERM that lands in the moment right after the fork, before
 * the child has reset the inherited traps and applied its redirect, makes bash run the MAIN shell's EXIT
 * trap in the child, on the hook's real stdout/stderr. MEASURED on Linux bash 5.2 (a throwaway CI probe):
 * a running subshell TERMed never ran it (0 of 2 shapes), the fork window did (16 of 2000 sequential,
 * 3238 of 4000 with 8 loops in parallel, every one in a subshell). In the hooks that gave:
 *   - a SECOND, stale `VERDICT=` line, printed BEFORE the real one (hook-mute-diagnostics' flake: 27–29 of
 *     1000 concurrent hook runs, 0 of 2000 sequential, every stray line from BASH_SUBSHELL=1);
 *   - the finalizer's `rm -f` of the mail read's temp files, run by the child while the main shell had
 *     not yet read them.
 *
 * The race itself cannot be scheduled from a test. What the child does in it can: it runs the trap's
 * action. So each row injects, into a TEST COPY of the hooks (the live hooks are never edited), one line
 * `( <the hook's current EXIT trap action> )` at a chosen point, taken from the hook's own `trap … EXIT`
 * line, and asserts what the hook prints and delivers. On the unfixed hooks every row is red, for the
 * reason it names.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { budgetTree } from "./_helpers/hook-budget-tree.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hook-subshell-trap-"));
const DB = path.join(ROOT, "relay.db");
process.env.RELAY_DB_PATH = DB;
for (const k of ["RELAY_AGENT_TOKEN", "RELAY_AGENT_NAME", "RELAY_ENCRYPTION_KEY", "RELAY_ENCRYPTION_KEYRING", "RELAY_ENCRYPTION_KEYRING_PATH"]) delete process.env[k];
const db = await import("../src/db.js");

afterAll(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

type Anchor = { after: RegExp } | { before: RegExp };

/** The marker every injection prints (on stderr) when the hook REACHES it: a row whose hook exits earlier fails. */
const REACHED = "[HST-REACHED]";

/**
 * A seamed copy of the hooks where `hook` gets extra lines at ONE anchor (refused unless it matches exactly one
 * line, so a moved line cannot leave a row vacuously green). `inject` receives the action of the last
 * `trap … EXIT` line above the anchor (the trap live there; null when there is none) and returns the lines.
 */
function injectTree(tag: string, hook: string, anchor: Anchor, inject: (trapAction: string | null) => string[]): string {
  const hooksDir = budgetTree(path.join(ROOT, `tree-${tag}`), path.join(REPO, "hooks"), path.join(REPO, "bin"));
  const file = path.join(hooksDir, hook);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const re = "after" in anchor ? anchor.after : anchor.before;
  const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  if (hits.length !== 1) throw new Error(`${hook}: anchor ${re} matched ${hits.length} lines, expected exactly 1`);
  const at = "after" in anchor ? hits[0] + 1 : hits[0];
  let action: string | null = null;
  for (let i = at - 1; i >= 0 && action === null; i--) {
    const m = lines[i].match(/^\s*trap (?:'([^']*)'|(\S+)) EXIT\s*$/);
    if (m) action = m[1] ?? m[2];
  }
  lines.splice(at, 0, ...inject(action));
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

/** `( <the live EXIT trap action> )` at the anchor, after the REACHED marker: what bash does in the fork window. */
function strayTree(tag: string, hook: string, anchor: Anchor): string {
  return injectTree(tag, hook, anchor, (action) => {
    if (action === null) throw new Error(`${hook}: no \`trap … EXIT\` line above the anchor`);
    return [`echo '${REACHED}' >&2`, `( ${action} )`];
  });
}

const verdictLines = (s: string): string[] => s.split("\n").filter((l) => /\bVERDICT=/.test(l));

type Run = { status: number | null; stdout: string; stderr: string };
/** check-relay.sh prints its verdict on stdout (the agent's context); the other hooks on stderr. */
const streamOf = (hook: string): "stdout" | "stderr" => (hook === "check-relay.sh" ? "stdout" : "stderr");
/** Exactly one verdict, on the hook's own stream, none on the other; and the injection was reached. */
function expectOneVerdict(r: Run, hook: string, injected = true): void {
  const own = streamOf(hook);
  const other = own === "stdout" ? "stderr" : "stdout";
  if (injected) expect(r.stderr, `the injection was not reached\n${shown(r)}`).toContain(REACHED);
  expect(verdictLines(r[own]), `${own}\n${shown(r)}`).toHaveLength(1);
  expect(verdictLines(r[other]), `${other}\n${shown(r)}`).toHaveLength(0);
}

function run(hook: string, env: Record<string, string>, input = ""): Run {
  const r = spawnSync("bash", [hook], {
    encoding: "utf8",
    timeout: 30_000,
    input,
    env: { PATH: process.env.PATH ?? "", RELAY_HTTP_PORT: "1", RELAY_TEST_CLOCK: "0", ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) =>
  `exit ${r.status}\n== stdout\n${r.stdout}\n== stderr\n${r.stderr}`;

/** A HOME with a real relay DB where `name` is registered and has ONE pending message. */
function seed(name: string): { home: string; env: Record<string, string> } {
  const home = path.join(ROOT, `home-${name}`);
  fs.mkdirSync(home, { recursive: true });
  db.registerAgent(`${name}-from`, "s", []);
  const token = db.registerAgent(name, "r", []).plaintext_token as string;
  db.sendMessage(`${name}-from`, name, `hello ${name}`, "normal");
  return { home, env: { HOME: home, RELAY_HOME: home, RELAY_AGENT_NAME: name, RELAY_AGENT_TOKEN: token, RELAY_DB_PATH: DB } };
}

beforeAll(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  db.getDb();
});

const PTU_STDIN = JSON.stringify({ session_id: "5b5b5b5b-0000-0000-0000-000000000001", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: {} });
const STOP_STDIN = JSON.stringify({ session_id: "5b5b5b5b-0000-0000-0000-000000000002", stop_hook_active: false });

// Every hook that installs an EXIT finalizer, and the line after which the trap live there is the
// self-contained FALLBACK (before the shared helper loads) and the LOADED one (after it).
const HOOKS: Array<{ hook: string; stdin: string; fallback: RegExp; loaded: RegExp }> = [
  { hook: "check-relay.sh", stdin: "", fallback: /^trap relay_emit_verdict EXIT$/, loaded: /^trap relay_finalize_verdict EXIT$/ },
  { hook: "post-tool-use-check.sh", stdin: PTU_STDIN, fallback: /^trap relay_emit_verdict EXIT$/, loaded: /^AGENT_NAME="\$\{RELAY_AGENT_NAME:-\}"$/ },
  { hook: "stop-check.sh", stdin: STOP_STDIN, fallback: /^trap relay_emit_verdict EXIT$/, loaded: /^AGENT_NAME="\$\{RELAY_AGENT_NAME:-\}"$/ },
  { hook: "codex/codex-session-start.sh", stdin: "", fallback: /^trap relay_emit_verdict EXIT$/, loaded: /^AGENT_NAME="\$\{RELAY_AGENT_NAME:-\}"$/ },
];

describe("a hook's EXIT trap run in a SUBSHELL prints no verdict (one verdict line per run, from the main shell)", () => {
  for (const h of HOOKS) {
    for (const where of ["fallback", "loaded"] as const) {
      it(`${h.hook}: the ${where} trap, run in a subshell, adds NO verdict line`, () => {
        const { env } = seed(`st-${h.hook.replace(/\W/g, "")}-${where}`);
        const file = strayTree(`${h.hook.replace(/\W/g, "")}-${where}`, h.hook, { after: h[where] });
        const r = run(file, env, h.stdin);
        expectOneVerdict(r, h.hook);
      });
    }
  }
});

describe("a subshell running the finalizer does not delete the mail read's files: the mail is still delivered", () => {
  it("SessionStart (check-relay.sh): the pending message reaches the context; no 'cannot trust'", () => {
    const { env } = seed("st-ss-mail");
    const file = strayTree("ss-mail", "check-relay.sh", { before: /^\s+out=\$\(cat "\$outf" 2>\/dev\/null\)$/ });
    const r = run(file, env);
    expect(r.stderr, shown(r)).toContain(REACHED);
    expect(r.stdout, shown(r)).toContain("hello st-ss-mail");
    expect(r.stdout + r.stderr, shown(r)).not.toContain("cannot trust");
  });

  it("PostToolUse (post-tool-use-check.sh): the pending message is announced; not 'relay unreadable'", () => {
    const { env } = seed("st-ptu-mail");
    const file = strayTree("ptu-mail", "post-tool-use-check.sh", { before: /^\s+F1_OUT=\$\(cat "\$_f1_outf" 2>\/dev\/null\)$/ });
    const r = run(file, env, PTU_STDIN);
    expect(r.stderr, shown(r)).toContain(REACHED);
    expect(r.stdout, shown(r)).toContain("st-ptu-mail-from");
    expect(r.stdout + r.stderr, shown(r)).not.toMatch(/relay unreadable/);
  });

  it("Stop (stop-check.sh): the pending message blocks the stop; not 'relay unreadable'", () => {
    const { env } = seed("st-stop-mail");
    const file = strayTree("stop-mail", "stop-check.sh", { before: /^\s+F1_OUT=\$\(cat "\$_f1_outf" 2>\/dev\/null\)$/ });
    const r = run(file, env, STOP_STDIN);
    expect(r.stderr, shown(r)).toContain(REACHED);
    expect(r.stdout, shown(r)).toMatch(/"decision":\s*"block"/);
    expect(r.stdout + r.stderr, shown(r)).not.toMatch(/relay unreadable/);
  });
});

describe("TWIN: the same copies WITHOUT the injected line deliver and print one verdict (the harness reaches the target)", () => {
  const twin = (tag: string, hook: string) => path.join(budgetTree(path.join(ROOT, `tree-twin-${tag}`), path.join(REPO, "hooks"), path.join(REPO, "bin")), hook);
  it("check-relay.sh delivers the message and prints exactly one verdict", () => {
    const { env } = seed("st-twin-ss");
    const r = run(twin("ss", "check-relay.sh"), env);
    expect(r.stdout, shown(r)).toContain("hello st-twin-ss");
    expectOneVerdict(r, "check-relay.sh", false);
  });
  it("post-tool-use-check.sh announces the message and prints exactly one verdict", () => {
    const { env } = seed("st-twin-ptu");
    const r = run(twin("ptu", "post-tool-use-check.sh"), env, PTU_STDIN);
    expect(r.stdout, shown(r)).toContain("st-twin-ptu-from");
    expectOneVerdict(r, "post-tool-use-check.sh", false);
  });
  it("stop-check.sh blocks on the message and prints exactly one verdict", () => {
    const { env } = seed("st-twin-stop");
    const r = run(twin("stop", "stop-check.sh"), env, STOP_STDIN);
    expect(r.stdout, shown(r)).toMatch(/"decision":\s*"block"/);
    expectOneVerdict(r, "stop-check.sh", false);
  });
});

describe("META: the reached marker is what keeps an injection row honest", () => {
  it("a copy that exits BEFORE the injection prints no marker, and the row's check FAILS on it (not vacuously green)", () => {
    const { env } = seed("st-meta-early");
    const file = injectTree("meta-early", "stop-check.sh", { after: /^AGENT_NAME="\$\{RELAY_AGENT_NAME:-\}"$/ }, (action) => [
      "exit 0",
      `echo '${REACHED}' >&2`,
      `( ${action} )`,
    ]);
    const r = run(file, env, STOP_STDIN);
    expect(r.stderr, shown(r)).not.toContain(REACHED);
    expect(() => expectOneVerdict(r, "stop-check.sh")).toThrow(/not reached/);
  });
});

describe("the shared helper FAILS CLOSED: _verdict.sh sourced without relay_in_main_shell emits nothing", () => {
  it("sourced alone, its emitter prints no verdict, in a subshell or in the main shell", () => {
    const helper = path.join(REPO, "hooks", "_verdict.sh");
    const r = spawnSync("bash", ["-c", `. "${helper}"; echo '${REACHED}' >&2; ( relay_emit_verdict ); relay_emit_verdict`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    const out: Run = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    expect(out.stderr, shown(out)).toContain(REACHED);
    expect(verdictLines(out.stdout + "\n" + out.stderr), shown(out)).toEqual([]);
  });
});

// The FIRST mktemp of a pair succeeding and the SECOND failing must not leak the first. The fault is injected
// into a test copy: a `mktemp` function that creates the first file (recording its path) and fails after.
// The record lives in a file because each `$(mktemp)` runs in a command-substitution subshell.
const MKTEMP_FAULT = (record: string) =>
  `mktemp() { if [ ! -s '${record}' ]; then command mktemp "$@" | tee '${record}'; else return 1; fi; }`;

describe("a second mktemp failing never leaks the first one's file (each file is cleaned up the moment it exists)", () => {
  const CASES: Array<{ name: string; hook: string; stdin: string; anchor: RegExp }> = [
    { name: "SessionStart mail read", hook: "check-relay.sh", stdin: "", anchor: /^\s+outf="\$\(mktemp 2>\/dev\/null \|\| printf ''\)"$/ },
    { name: "PostToolUse mail read", hook: "post-tool-use-check.sh", stdin: PTU_STDIN, anchor: /^\s+_f1_outf="\$\(mktemp 2>\/dev\/null \|\| printf ''\)"$/ },
    { name: "Stop mail read", hook: "stop-check.sh", stdin: STOP_STDIN, anchor: /^\s+_f1_outf="\$\(mktemp 2>\/dev\/null \|\| printf ''\)"$/ },
    { name: "SessionStart window bind", hook: "check-relay.sh", stdin: '{"session_id":"5b5b5b5b-0000-0000-0000-000000000003"}', anchor: /^\s+RELAY_BIND_ERRFILE="\$\(mktemp 2>\/dev\/null \|\| printf ''\)"$/ },
  ];
  for (const c of CASES) {
    it(`${c.name} (${c.hook}): the first file is gone after the hook exits`, () => {
      const tag = c.name.replace(/\W/g, "");
      const { env } = seed(`st-mk-${tag}`.slice(0, 60));
      const record = path.join(ROOT, `mk-record-${tag}`);
      const file = injectTree(`mk-${tag}`, c.hook, { before: c.anchor }, () => [`echo '${REACHED}' >&2`, MKTEMP_FAULT(record)]);
      const r = run(file, env, c.stdin);
      expect(r.stderr, shown(r)).toContain(REACHED);
      const first = fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim() : "";
      const leaked = first !== "" && fs.existsSync(first);
      if (leaked) fs.rmSync(first, { force: true }); // never leave the leak behind on the machine running the test
      expect(first, `the fault never created the first file\n${shown(r)}`).not.toBe("");
      expect(leaked, `leaked: ${first}\n${shown(r)}`).toBe(false);
    });
  }

  it("the window bind with NO runnable relay CLI: none of its three files is left behind", () => {
    const { env } = seed("st-mk-bind-nocli");
    // Every file mktemp creates from here on is recorded (macOS mktemp ignores TMPDIR, so a directory listing
    // would be vacuous there): all of them must be gone after the hook exits.
    const record = path.join(ROOT, "mk-record-bind-nocli");
    const file = injectTree("mk-bind-nocli", "check-relay.sh", { before: /^\s+RELAY_BIND_ERRFILE="\$\(mktemp 2>\/dev\/null \|\| printf ''\)"$/ }, () => [
      `echo '${REACHED}' >&2`,
      `mktemp() { command mktemp "$@" | tee -a '${record}'; }`,
      // The CLI the bind looks for is missing (the else branch: "no runnable relay CLI beside this hook").
      `RELAY_BIND_BIN='${path.join(ROOT, "no-such-relay-cli")}'`,
    ]);
    const r = run(file, env, '{"session_id":"5b5b5b5b-0000-0000-0000-000000000004"}');
    expect(r.stderr, shown(r)).toContain(REACHED);
    const made = fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n").filter(Boolean) : [];
    const left = made.filter((f) => fs.existsSync(f));
    for (const f of left) fs.rmSync(f, { force: true }); // never leave the leak behind on the machine running the test
    expect(made.length, `the bind created fewer than its three files\n${shown(r)}`).toBeGreaterThanOrEqual(3);
    expect(left, shown(r)).toEqual([]);
  });
});

/**
 * SOURCE SCAN (not a runtime check). On bash 3.2 a process-substitution child (`<( … )`, `>( … )`) reports
 * BASH_SUBSHELL=0 and has no BASHPID, so relay_in_main_shell cannot tell it from the main shell (measured in
 * review). The hooks therefore must not contain one, nor a coprocess. Comments, single-quoted strings, $'…'
 * strings and quoted-delimiter heredoc bodies are skipped; everything else (including double-quoted text) is
 * scanned, so the scan fails CLOSED on a doubtful form.
 */
function procSubstHits(src: string): string[] {
  const hits: string[] = [];
  const lines = src.split("\n");
  let quote: "'" | '"' | "$'" | null = null;
  let heredoc: { end: string; literal: boolean } | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (heredoc) {
      if (line.replace(/^\t+/, "") === heredoc.end) heredoc = null;
      else if (!heredoc.literal && /[<>]\(/.test(line)) hits.push(`${n + 1}: ${line.trim()}`);
      continue;
    }
    let code = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote === "'") { if (ch === "'") quote = null; continue; }
      if (quote === "$'") { if (ch === "\\") i++; else if (ch === "'") quote = null; continue; }
      if (ch === "\\") { code += line.slice(i, i + 2); i++; continue; }
      if (quote === '"') { if (ch === '"') quote = null; code += ch; continue; }
      if (ch === "$" && line[i + 1] === "'") { quote = "$'"; i++; continue; }
      if (ch === "'") { quote = "'"; continue; }
      if (ch === '"') { quote = '"'; code += ch; continue; }
      if (ch === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) break;
      code += ch;
    }
    // The delimiter is read from the RAW line (its quotes were stripped from `code`), when `<<` is code.
    const hd = code.includes("<<") ? line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/) : null;
    if (hd) heredoc = { end: hd[2], literal: hd[1] !== "" };
    if (/(^|[^<>0-9])[<>]\(/.test(code) || /(^|[\s;&|(])coproc(\s|$)/.test(code)) hits.push(`${n + 1}: ${line.trim()}`);
  }
  return hits;
}

describe("SOURCE SCAN: no process substitution or coprocess in any hook (bash 3.2 cannot tell their child from the main shell)", () => {
  it("the scanner FINDS the forms it bans (absent from the repo, so tested on fixtures)", () => {
    for (const form of [
      "diff <(a) <(b)",
      "cmd | tee >(cat >&2)",
      'x="$(cat <(echo y))"',
      "echo 'quoted' <(z)",
      "coproc worker { :; }",
      "a; coproc b",
      "cat <<EOF\nbody <(x)\nEOF",
    ]) expect(procSubstHits(form), form).not.toEqual([]);
  });
  it("the scanner IGNORES the same text in comments, single-quoted and $'…' strings, and quoted heredocs", () => {
    for (const form of [
      "# diff <(a) <(b)",
      "echo hi # tee >(x)",
      "node -e 'const f = x=>(x + 1); /<(/.test(s)'",
      "printf $'<(not code)\\n'",
      "cat <<'EOF'\nbody <(x) coproc y\nEOF",
      "echo 2> /dev/null",
      "echo coprocess",
    ]) expect(procSubstHits(form), form).toEqual([]);
  });
  it("hooks/*.sh, hooks/codex/*.sh and the sourced helpers contain none", () => {
    const files = [
      ...fs.readdirSync(path.join(REPO, "hooks")).filter((f) => f.endsWith(".sh")).map((f) => path.join(REPO, "hooks", f)),
      ...fs.readdirSync(path.join(REPO, "hooks", "codex")).filter((f) => f.endsWith(".sh")).map((f) => path.join(REPO, "hooks", "codex", f)),
    ];
    expect(files.map((f) => path.basename(f))).toEqual(expect.arrayContaining(["_verdict.sh", "_vault-helpers.sh", "check-relay.sh", "codex-session-start.sh"]));
    const found = files.flatMap((f) => procSubstHits(fs.readFileSync(f, "utf8")).map((h) => `${path.relative(REPO, f)}:${h}`));
    expect(found).toEqual([]);
  });
});
