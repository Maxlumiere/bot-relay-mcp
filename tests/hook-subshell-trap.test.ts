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

/**
 * A seamed copy of the hooks where `hook` gets ONE extra line: `( ACTION )`, ACTION being the action of the
 * last `trap … EXIT` line above the anchor (the trap that is live there). Refuses (throws) when the anchor
 * is not found exactly once or no trap precedes it, so a moved line cannot leave a row vacuously green.
 */
function strayTree(tag: string, hook: string, anchor: Anchor): string {
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
  if (action === null) throw new Error(`${hook}: no \`trap … EXIT\` line above the anchor ${re}`);
  lines.splice(at, 0, `( ${action} )`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

const verdictLines = (s: string): string[] => s.split("\n").filter((l) => /\bVERDICT=/.test(l));

function run(hook: string, env: Record<string, string>, input = ""): { status: number | null; stdout: string; stderr: string } {
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
        expect(verdictLines(r.stdout + "\n" + r.stderr), shown(r)).toHaveLength(1);
      });
    }
  }
});

describe("a subshell running the finalizer does not delete the mail read's files: the mail is still delivered", () => {
  it("SessionStart (check-relay.sh): the pending message reaches the context; no 'cannot trust'", () => {
    const { env } = seed("st-ss-mail");
    const file = strayTree("ss-mail", "check-relay.sh", { before: /^\s+out=\$\(cat "\$outf" 2>\/dev\/null\)$/ });
    const r = run(file, env);
    expect(r.stdout, shown(r)).toContain("hello st-ss-mail");
    expect(r.stdout + r.stderr, shown(r)).not.toContain("cannot trust");
  });

  it("PostToolUse (post-tool-use-check.sh): the pending message is announced; not 'relay unreadable'", () => {
    const { env } = seed("st-ptu-mail");
    const file = strayTree("ptu-mail", "post-tool-use-check.sh", { before: /^\s+F1_OUT=\$\(cat "\$_f1_outf" 2>\/dev\/null\)$/ });
    const r = run(file, env, PTU_STDIN);
    expect(r.stdout, shown(r)).toContain("st-ptu-mail-from");
    expect(r.stdout + r.stderr, shown(r)).not.toMatch(/relay unreadable/);
  });

  it("Stop (stop-check.sh): the pending message blocks the stop; not 'relay unreadable'", () => {
    const { env } = seed("st-stop-mail");
    const file = strayTree("stop-mail", "stop-check.sh", { before: /^\s+F1_OUT=\$\(cat "\$_f1_outf" 2>\/dev\/null\)$/ });
    const r = run(file, env, STOP_STDIN);
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
    expect(verdictLines(r.stdout + "\n" + r.stderr), shown(r)).toHaveLength(1);
  });
  it("post-tool-use-check.sh announces the message and prints exactly one verdict", () => {
    const { env } = seed("st-twin-ptu");
    const r = run(twin("ptu", "post-tool-use-check.sh"), env, PTU_STDIN);
    expect(r.stdout, shown(r)).toContain("st-twin-ptu-from");
    expect(verdictLines(r.stdout + "\n" + r.stderr), shown(r)).toHaveLength(1);
  });
  it("stop-check.sh blocks on the message and prints exactly one verdict", () => {
    const { env } = seed("st-twin-stop");
    const r = run(twin("stop", "stop-check.sh"), env, STOP_STDIN);
    expect(r.stdout, shown(r)).toMatch(/"decision":\s*"block"/);
    expect(verdictLines(r.stdout + "\n" + r.stderr), shown(r)).toHaveLength(1);
  });
});
