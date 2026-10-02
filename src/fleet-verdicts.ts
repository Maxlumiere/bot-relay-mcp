// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 3 — the verdict engine: does every relay connector on this host run
 * the build that is installed? ONE engine, shared by `relay fleet --connectors`
 * and (PR 4) `relay fleet --deploy-check` (ruling fd6b7757, D8).
 *
 * THE PIVOT IS CONNECTOR PROCESSES (coverage ruling 37529ef6): the set is every
 * relay connector PROCESS on the host (one process-table snapshot, classified)
 * UNION every live `connectors` row. A window binding only adds a name; a
 * connector with none is labelled UNBOUND and is judged like any other.
 *
 * ONE SNAPSHOT, THEN PURE FUNCTIONS. `observeFleet` reads each source once
 * (every read is injectable, in the deploy-gate style); `judgeFleet` is a pure
 * function of that snapshot. Nothing here writes anything.
 *
 * Verdicts, per connector (verdictForBuild):
 *   INSTALL INCONSISTENT  the install it came from fails checkInstall (rebuild);
 *   UNKNOWN               no row (it predates the stamp or writes elsewhere), an
 *                         unstamped build, dependencies not identified, or a node
 *                         process that cannot be classified;
 *   STALE                 its loaded code or dependencies differ from the install;
 *   CURRENT               both equal: the ONLY passing verdict.
 * Per live BOUND window with no connector at all: NO CONNECTOR, only on POSITIVE
 * absence (every descendant enumerated and classified); otherwise UNKNOWN.
 */
import fs from "fs";
import path from "path";
import { checkInstall, parseStamp, UNBUILT, type InstallCheck } from "./build-id.js";
import { isUtcStartToken, type ProcEntry } from "./liveness.js";
import { NODE_FLAGS, NODE_NO_SCRIPT, NODE_OPTIONS_WITH_VALUE } from "./node-options.js";

export type ConnectorVerdict = "CURRENT" | "STALE" | "UNKNOWN" | "INSTALL INCONSISTENT";
export type WindowVerdict = ConnectorVerdict | "NO CONNECTOR";

/** Display / worst-wins order: a higher number is worse. Every non-CURRENT verdict fails the deploy check. */
export const VERDICT_SEVERITY: Record<WindowVerdict, number> = {
  CURRENT: 0,
  STALE: 1,
  "NO CONNECTOR": 2,
  UNKNOWN: 3,
  "INSTALL INCONSISTENT": 4,
};

export function worstVerdict(verdicts: WindowVerdict[]): WindowVerdict {
  return verdicts.reduce<WindowVerdict>((w, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[w] ? v : w), "CURRENT");
}

/** ADR-0047 D7 (ruling fd6b7757): the honest NO CONNECTOR text names BOTH causes. */
export const NO_CONNECTOR_REASON =
  "no relay connector process (MCP-mute, OR HTTP-configured: VIA DAEMON not yet supported, known gap)";

// ---------------------------------------------------------------------------
// Classifying a process (D3 + D9)
// ---------------------------------------------------------------------------

export type Classification =
  | { kind: "not-relay"; why: string }
  | { kind: "connector"; script: string; installDir: string }
  | { kind: "unknown"; reason: string };

/** The file-system reads a classification needs (injectable). */
export interface ClassifyFs {
  isFile(p: string): boolean;
  realpath(p: string): string | null;
  /** The `name` in DIR/package.json; null when there is none; {error} when it cannot be read. */
  packageName(dir: string): string | null | { error: string };
}

export const realClassifyFs: ClassifyFs = {
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  realpath: (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return null;
    }
  },
  packageName: (dir) => {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? null : { error: `cannot read ${path.join(dir, "package.json")} (${code ?? String(err)})` };
    }
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string" ? (v as { name: string }).name : null;
    } catch {
      return { error: `${path.join(dir, "package.json")} is not valid JSON` };
    }
  },
};

const NODE_EXECUTABLES = /^node(js)?(\.exe)?$/i;
export { NODE_OPTIONS_WITH_VALUE, NODE_FLAGS, NODE_NO_SCRIPT };

/** A process, as the snapshot holds it. `argv` is the EXACT argv when the platform gives one (Linux /proc); else null. */
export interface ProcessView {
  pid: number;
  ppid: number;
  /** The start token (the UTC form with its suffix), from the same producer as the connector rows. */
  start: string;
  command: string;
  comm?: string;
  cwd: string | null;
  argv: string[] | null;
}

/** Where the script could start, under ONE reading of the node options: an argv index, or no script at all. */
type Reading = { index: number } | { none: string };

/**
 * Every plausible reading of the node options (D3; #297 Codex R1 P1). A listed option
 * has node's own arity (src/node-options.ts); `--opt=value` is one argument whatever
 * the option; an option node's table does not know may take a value or not, so it is
 * read BOTH ways. Memoised on the argv index: linear in practice, quadratic at worst.
 */
function readNodeOptions(args: string[]): { readings: Reading[]; unknownOptions: string[]; spaceValue: boolean } {
  const memo = new Map<number, Reading[]>();
  const unknownOptions: string[] = [];
  let spaceValue = false;
  const at = (i: number): Reading[] => {
    const hit = memo.get(i);
    if (hit) return hit;
    let r: Reading[];
    const a = args[i];
    if (i >= args.length) r = [{ none: "node with no script" }];
    else if (a === "--") r = i + 1 < args.length ? [{ index: i + 1 }] : [{ none: "node with no script" }];
    else if (!a.startsWith("-") || a === "-") r = [{ index: i }];
    else {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (NODE_NO_SCRIPT.has(name)) r = [{ none: `node ${name}: no script` }];
      else if (eq > 0) r = at(i + 1);
      else if (NODE_OPTIONS_WITH_VALUE.has(a)) {
        spaceValue = true;
        r = at(i + 2);
      } else if (NODE_FLAGS.has(a) || a.startsWith("--no-")) r = at(i + 1);
      else {
        unknownOptions.push(a);
        r = [...at(i + 1), ...at(i + 2)];
      }
    }
    memo.set(i, r);
    return r;
  };
  const seen = new Set<string>();
  const readings = at(0).filter((r) => {
    const k = JSON.stringify(r);
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { readings, unknownOptions: [...new Set(unknownOptions)], spaceValue };
}

/** A relay connector entrypoint: `<dir>/dist/index.js`. */
const relayShaped = (real: string): boolean => path.basename(real) === "index.js" && path.basename(path.dirname(real)) === "dist";

/** Is the script that starts at argv[index] a relay connector? (D3 + D9, P2: unidentifiable → UNKNOWN). */
function classifyScript(args: string[], index: number, exact: boolean, absolute: (c: string) => string | null, fsx: ClassifyFs): Classification {
  let script: string;
  if (exact) {
    const abs = absolute(args[index]);
    if (!abs) return { kind: "unknown", reason: `the script ${args[index]} is relative and the process's working directory is unreadable` };
    script = abs;
  } else {
    const found: string[] = [];
    let unresolvable = false;
    for (let k = index; k < args.length; k++) {
      const candidate = args.slice(index, k + 1).join(" ");
      const abs = absolute(candidate);
      if (!abs) {
        unresolvable = true;
        continue;
      }
      if (fsx.isFile(abs)) found.push(abs);
    }
    if (found.length > 1) {
      return { kind: "unknown", reason: `the script is ambiguous: ${found.length} space-joined prefixes of its argv are existing files` };
    }
    if (found.length === 0) {
      return {
        kind: "unknown",
        reason: unresolvable
          ? "the script is relative and the process's working directory is unreadable"
          : "no prefix of its argv is an existing file (the script was moved or deleted, or ps truncated it)",
      };
    }
    script = found[0];
  }

  const real = fsx.realpath(script);
  if (!real) return { kind: "unknown", reason: `the script ${script} cannot be resolved` };
  if (!relayShaped(real)) return { kind: "not-relay", why: `runs ${real}` };
  const installDir = path.dirname(path.dirname(real));
  const name = fsx.packageName(installDir);
  if (name !== null && typeof name === "object") return { kind: "unknown", reason: name.error };
  // #297 Codex R1 P2: a MISSING (or nameless) package.json identifies nothing, so it cannot
  // positively exclude a running connector (its install may be mid-update).
  if (name === null) return { kind: "unknown", reason: `${path.join(installDir, "package.json")} is missing or has no name: the install of ${real} cannot be identified` };
  if (name !== "bot-relay-mcp") return { kind: "not-relay", why: `runs ${real} (package ${name})` };
  return { kind: "connector", script: real, installDir };
}

/**
 * The relay entrypoint named ANYWHERE in argv (any space-joined span, an `--opt=value`
 * value included), or null. The guard behind an uncertain "not relay": a connector's
 * script is always such a span, so when none exists the uncertainty cannot matter.
 */
function relayEntrypointInArgv(args: string[], exact: boolean, absolute: (c: string) => string | null, fsx: ClassifyFs): string | null {
  for (let s = 0; s < args.length; s++) {
    let head = args[s];
    if (head.startsWith("-")) {
      const eq = head.indexOf("=");
      if (eq < 0) continue;
      head = head.slice(eq + 1);
    }
    let candidate = head;
    for (let e = s; e < (exact ? s + 1 : args.length); e++) {
      if (e > s) candidate += " " + args[e];
      const abs = absolute(candidate);
      if (!abs || !fsx.isFile(abs)) continue;
      const real = fsx.realpath(abs);
      if (real && relayShaped(real) && fsx.packageName(path.dirname(path.dirname(real))) === "bot-relay-mcp") return real;
    }
  }
  return null;
}

/**
 * Is this process a relay stdio connector, and from which install?
 *
 *   - A TCP listener is never a connector (ruling fd6b7757 D9.2: a stdio connector
 *     never listens; this excludes the daemon without reading its environment).
 *   - Not node → not a relay process.
 *   - The script is the first NON-OPTION argument (D3), found with node's own option
 *     table (src/node-options.ts). With an exact argv (Linux) it is read directly.
 *     macOS `ps` joins argv with spaces, and paths contain spaces ("Claude AI"), so it
 *     is resolved by EXISTENCE: the space-joined token prefixes that are existing
 *     files. Exactly one → the script; none, or more than one → UNKNOWN, never NO
 *     CONNECTOR (D9.1).
 *   - A connector = the script's realpath is `<dir>/dist/index.js` and
 *     `<dir>/package.json` names "bot-relay-mcp"; installDir = `<dir>`. A missing or
 *     unreadable package.json → UNKNOWN.
 *   - UNCERTAINTY NEVER HIDES A CONNECTOR (#297 Codex R1 P1): every plausible reading
 *     of the options is classified. A connector only when every reading is the same
 *     connector; "not relay" only when every reading is, AND (when a reading was
 *     uncertain: an unknown option, or a space-form value that ps may have split)
 *     no span of argv names a relay entrypoint at all. Anything else → UNKNOWN.
 */
export function classifyProcess(p: ProcessView, listeners: ReadonlySet<number>, fsx: ClassifyFs = realClassifyFs): Classification {
  if (listeners.has(p.pid)) return { kind: "not-relay", why: "it holds a TCP listen socket (the daemon or another server)" };
  const exe = p.comm ?? (p.argv ? p.argv[0] : p.command.split(" ")[0]);
  if (!NODE_EXECUTABLES.test(path.basename(exe ?? ""))) return { kind: "not-relay", why: "not a node process" };

  let args: string[];
  let exact: boolean;
  if (p.argv) {
    args = p.argv.slice(1);
    exact = true;
  } else {
    // The command starts with the executable as ps prints it (comm when it is the
    // full path, else the first token).
    const rest =
      p.comm && p.command.startsWith(p.comm + " ")
        ? p.command.slice(p.comm.length + 1)
        : p.command.slice(p.command.split(" ")[0].length + 1);
    args = rest.length > 0 ? rest.split(" ") : [];
    exact = false;
  }

  const absolute = (candidate: string): string | null =>
    path.isAbsolute(candidate) ? candidate : p.cwd ? path.resolve(p.cwd, candidate) : null;

  const { readings, unknownOptions, spaceValue } = readNodeOptions(args);
  const results = readings.map((r): Classification => ("none" in r ? { kind: "not-relay", why: r.none } : classifyScript(args, r.index, exact, absolute, fsx)));
  const uncertainty =
    unknownOptions.length > 0
      ? `the node option${unknownOptions.length > 1 ? "s" : ""} ${unknownOptions.join(", ")} ${unknownOptions.length > 1 ? "are" : "is"} not in node's option table (it may take a value)`
      : !exact && spaceValue
        ? "ps joins argv with spaces, so a space-form option value may hold a space"
        : null;

  const first = results[0];
  if (results.length === 1 && first.kind === "unknown") return first;
  if (results.every((c) => c.kind === "connector" && first.kind === "connector" && c.installDir === first.installDir && c.script === first.script)) return first;
  if (results.every((c) => c.kind === "not-relay")) {
    if (uncertainty) {
      const named = relayEntrypointInArgv(args, exact, absolute, fsx);
      if (named) return { kind: "unknown", reason: `its argv names the relay entrypoint ${named}, but ${uncertainty}: which argument is the script is uncertain` };
    }
    return first;
  }
  const inner = results.find((c) => c.kind === "unknown") as { reason: string } | undefined;
  return {
    kind: "unknown",
    reason: `${uncertainty ?? "its node options"}: ${results.length} readings of its argv disagree${inner ? ` (${inner.reason})` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// The build comparison (one table for connectors AND the daemon)
// ---------------------------------------------------------------------------

/** What a process LOADED: a connectors row, or the daemon's /health.build. */
export interface LoadedFacts {
  build_id: string;
  deps_id: string | null;
  deps_state: string | null;
  commit: string | null;
  dirty: boolean | null;
  built_at: string | null;
  node: string | null;
}

export interface BuildVerdict {
  verdict: ConnectorVerdict;
  reason: string;
}

const short = (id: string | null): string => (id ? id.slice(0, 12) : "none");
export function describeBuild(b: { commit: string | null; dirty: boolean | null; built_at: string | null; build_id: string | null }): string {
  const commit = b.commit ? `${b.commit.slice(0, 7)}${b.dirty ? "+dirty" : ""}` : "no commit";
  return `${commit} ${b.built_at ?? "no build time"} (code ${short(b.build_id)})`;
}

/** The installed side's stamp details, for humans (the comparison uses checkInstall only). */
export interface InstalledFacts {
  check: InstallCheck;
  stamp: { commit: string | null; dirty: boolean | null; built_at: string | null } | null;
}

/** THE comparison. Pure. Only CURRENT passes. */
export function verdictForBuild(loaded: LoadedFacts, installed: InstalledFacts): BuildVerdict {
  const inst = installed.check;
  if (!inst.consistent) return { verdict: "INSTALL INCONSISTENT", reason: inst.reason };
  if (loaded.build_id === UNBUILT) return { verdict: "UNKNOWN", reason: "it runs an unstamped build (npm run build was not used)" };
  if (loaded.deps_state !== "known" || !loaded.deps_id) {
    return { verdict: "UNKNOWN", reason: `its dependencies were not identified when it started (${loaded.deps_state ?? "not recorded"})` };
  }
  if (inst.deps_state !== "known" || !inst.deps) return { verdict: "UNKNOWN", reason: inst.reason };
  const codeSame = loaded.build_id === inst.content;
  const depsSame = loaded.deps_id === inst.deps;
  if (codeSame && depsSame) return { verdict: "CURRENT", reason: "runs the installed build" };
  const what = !codeSame && !depsSame ? "code and dependencies" : !codeSame ? "code" : "dependencies";
  const installedText = describeBuild({ ...(installed.stamp ?? { commit: null, dirty: null, built_at: null }), build_id: inst.content });
  return { verdict: "STALE", reason: `its ${what} differ: running ${describeBuild(loaded)}, installed ${installedText}; restart needed` };
}

// ---------------------------------------------------------------------------
// The snapshot, and the judgement over it
// ---------------------------------------------------------------------------

/** A live `connectors` row (src/db.ts ConnectorRow), as the engine needs it. */
export interface RowView {
  pid: number;
  pid_start: string;
  parent_pid: number | null;
  parent_start: string | null;
  build_id: string;
  deps_id: string | null;
  deps_state: string | null;
  node: string | null;
  commit_sha: string | null;
  dirty: number | null;
  built_at: string | null;
  install_dir: string;
}

export interface BindingView {
  agent_name: string | null;
  window_pid: number;
  window_pid_start: string;
}

export interface DaemonView {
  port: number;
  /** Pids listening on the configured port; {error} when that cannot be read. */
  listenerPids: number[] | { error: string };
  /** /health.build, or why it could not be read. */
  health: { ok: true; build: LoadedFacts } | { ok: false; error: string };
}

export interface FleetSnapshot {
  /** The process table; {error} when it cannot be read (then nothing is judged CURRENT). */
  processes: ProcessView[] | { error: string };
  /** Every pid holding ANY TCP listen socket (D9.2); {error} when unreadable. */
  listeners: number[] | { error: string };
  rows: RowView[];
  /** LIVE bindings on this host. */
  bindings: BindingView[];
  daemon: DaemonView;
  installed: (installDir: string) => InstalledFacts;
  /** `node --version` of the node on PATH, or null when unreadable. */
  nodeOnPath: string | null;
}

/**
 * What a fleet entry IS: a classified relay connector, or a node process that could not be
 * classified. This is the CONNECTOR-classification kind, not the agent coordination class
 * (src/agent-class.ts): the two only share a word. Branch on these constants, never a literal.
 */
export const CONNECTOR_KIND = { connector: "connector", unclassified: "unclassified" } as const;
export type ConnectorKind = (typeof CONNECTOR_KIND)[keyof typeof CONNECTOR_KIND];

export interface ConnectorEntry {
  pid: number;
  start: string;
  /** The bound agent name, or null with `unbound: true`. */
  agent: string | null;
  unbound: boolean;
  /** CONNECTOR_KIND.unclassified when the process could not be classified and has no row. */
  kind: ConnectorKind;
  window_pid: number | null;
  /** The window's start token: with window_pid, the window's identity (a pid alone is reusable). */
  window_start: string | null;
  install_dir: string | null;
  has_row: boolean;
  verdict: ConnectorVerdict;
  reason: string;
  running: string | null;
  warnings: string[];
}

export interface WindowEntry {
  agent: string | null;
  window_pid: number;
  verdict: WindowVerdict;
  reason: string;
  connectors: number[];
}

export interface FleetJudgement {
  connectors: ConnectorEntry[];
  /**
   * EVERY live bound window: the worst verdict of its connectors (all listed in
   * `connectors`), or, with none, NO CONNECTOR / UNKNOWN.
   */
  windows: WindowEntry[];
  daemon: { verdict: ConnectorVerdict; reason: string; pid: number | null; install_dir: string | null; running: string | null };
  /** Every non-CURRENT verdict, connectors + windows + the daemon: what the deploy check fails on. */
  failing: number;
}

const key = (pid: number, start: string): string => `${pid}\u0000${start}`;

function rowFacts(r: RowView): LoadedFacts {
  return {
    build_id: r.build_id,
    deps_id: r.deps_id,
    deps_state: r.deps_state,
    commit: r.commit_sha,
    dirty: r.dirty === null ? null : r.dirty === 1,
    built_at: r.built_at,
    node: r.node,
  };
}

/** Judge one snapshot. PURE. */
export function judgeFleet(s: FleetSnapshot, fsx: ClassifyFs = realClassifyFs): FleetJudgement {
  // Without a process table or the listener list, no process can be classified:
  // every row still gets judged, but no live window can read NO CONNECTOR.
  const table = Array.isArray(s.processes) ? s.processes : [];
  const tableError = Array.isArray(s.processes) ? null : s.processes.error;
  const listeners = new Set(Array.isArray(s.listeners) ? s.listeners : []);
  const listenerError = Array.isArray(s.listeners) ? null : s.listeners.error;

  const byPid = new Map<number, ProcessView>(table.map((p) => [p.pid, p]));
  const bindingByAnchor = new Map<string, BindingView>(s.bindings.map((b) => [key(b.window_pid, b.window_pid_start), b]));
  /** The live binding that owns this process: itself or its nearest bound ancestor in the table. */
  const boundAncestor = (pid: number): BindingView | null => {
    let cur = byPid.get(pid);
    for (let depth = 0; cur && depth < 64; depth++) {
      const b = bindingByAnchor.get(key(cur.pid, cur.start));
      if (b) return b;
      cur = byPid.get(cur.ppid);
    }
    return null;
  };

  const classes = new Map<number, Classification>();
  for (const p of table) {
    classes.set(
      p.pid,
      listenerError ? { kind: "unknown", reason: `the TCP listeners cannot be read (${listenerError})` } : classifyProcess(p, listeners, fsx),
    );
  }

  const daemonPids = Array.isArray(s.daemon.listenerPids) ? s.daemon.listenerPids : [];
  const daemonDir = (() => {
    for (const pid of daemonPids) {
      const p = byPid.get(pid);
      if (!p) continue;
      const c = classifyProcess(p, new Set(), fsx);
      if (c.kind === "connector") return { pid, dir: c.installDir };
    }
    return null;
  })();

  const installedCache = new Map<string, InstalledFacts>();
  const installedAt = (dir: string): InstalledFacts => {
    let v = installedCache.get(dir);
    if (!v) {
      v = s.installed(dir);
      installedCache.set(dir, v);
    }
    return v;
  };

  const entries = new Map<string, ConnectorEntry>();
  const warningsFor = (facts: LoadedFacts | null, installDir: string | null): string[] => {
    const w: string[] = [];
    if (facts?.node && s.nodeOnPath && facts.node !== s.nodeOnPath) {
      w.push(`it runs node ${facts.node}; the node on PATH is ${s.nodeOnPath}`);
    }
    if (installDir && daemonDir && installDir !== daemonDir.dir) {
      w.push(`it was loaded from ${installDir}, not the daemon's install (${daemonDir.dir})`);
    }
    return w;
  };

  // 1. Every live row: a connector, judged on what it LOADED.
  for (const r of s.rows) {
    const b = r.parent_pid !== null && r.parent_start !== null ? bindingByAnchor.get(key(r.parent_pid, r.parent_start)) ?? null : boundAncestor(r.pid);
    const facts = rowFacts(r);
    const v = verdictForBuild(facts, installedAt(r.install_dir));
    entries.set(key(r.pid, r.pid_start), {
      pid: r.pid,
      start: r.pid_start,
      agent: b ? b.agent_name ?? "(unnamed)" : null,
      unbound: !b,
      kind: CONNECTOR_KIND.connector,
      window_pid: r.parent_pid ?? (b ? b.window_pid : null),
      window_start: r.parent_pid !== null ? r.parent_start : b ? b.window_pid_start : null,
      install_dir: r.install_dir,
      has_row: true,
      verdict: v.verdict,
      reason: v.reason,
      running: describeBuild(facts),
      warnings: warningsFor(facts, r.install_dir),
    });
  }

  // 2. Every classified connector PROCESS without a row, and every unclassifiable node process.
  for (const p of table) {
    const k = key(p.pid, p.start);
    if (entries.has(k)) continue;
    const c = classes.get(p.pid) as Classification;
    if (c.kind === "not-relay") continue;
    const b = boundAncestor(p.pid);
    entries.set(k, {
      pid: p.pid,
      start: p.start,
      agent: b ? b.agent_name ?? "(unnamed)" : null,
      unbound: !b,
      kind: c.kind === "connector" ? CONNECTOR_KIND.connector : CONNECTOR_KIND.unclassified,
      window_pid: b ? b.window_pid : null,
      window_start: b ? b.window_pid_start : null,
      install_dir: c.kind === "connector" ? c.installDir : null,
      has_row: false,
      verdict: "UNKNOWN",
      reason:
        c.kind === "connector"
          ? "it wrote no connectors row: it predates the build stamp, or it writes to another DB; restart needed"
          : `a node process that cannot be classified: ${c.reason}`,
      running: null,
      warnings: warningsFor(null, c.kind === "connector" ? c.installDir : null),
    });
  }

  // 3. Every live bound window: the WORST of every connector it owns (its recorded
  // parent, joined on (pid, START): a reused pid never inherits an old connector) AND
  // every connector under it in the process table (a descendant may record another
  // parent, e.g. after orphan adoption); both sources, always (#297 Codex R1 P2).
  // With none: NO CONNECTOR only on POSITIVE absence.
  const windows: WindowEntry[] = [];
  for (const b of s.bindings) {
    const found = new Map<string, ConnectorEntry>();
    for (const [k, e] of entries) if (e.window_pid === b.window_pid && e.window_start === b.window_pid_start) found.set(k, e);
    // Why the descendants cannot be enumerated, or null when they were.
    let blind: string | null = null;
    const win = byPid.get(b.window_pid);
    if (!isUtcStartToken(b.window_pid_start)) {
      blind = "its binding predates the UTC start token (the legacy form cannot be matched to the process table): restart the window";
    } else if (tableError || !win || win.start !== b.window_pid_start) {
      blind = tableError ? `the process table cannot be read (${tableError})` : "the window process is not in the process snapshot";
    } else {
      const queue = [b.window_pid];
      const seen = new Set<number>(queue);
      while (queue.length > 0) {
        const parent = queue.shift() as number;
        for (const p of table) {
          if (p.ppid === parent && !seen.has(p.pid)) {
            seen.add(p.pid);
            queue.push(p.pid);
            const k = key(p.pid, p.start);
            const e = entries.get(k);
            if (e) found.set(k, e);
          }
        }
      }
    }
    if (found.size > 0) {
      const owned = [...found.values()];
      windows.push({
        agent: b.agent_name,
        window_pid: b.window_pid,
        verdict: worstVerdict(owned.map((e) => e.verdict)),
        reason: owned.length > 1 ? `the worst of its ${owned.length} connectors` : "its connector's verdict",
        connectors: owned.map((e) => e.pid),
      });
      continue;
    }
    if (blind) {
      windows.push({ agent: b.agent_name, window_pid: b.window_pid, verdict: "UNKNOWN", reason: blind, connectors: [] });
      continue;
    }
    // POSITIVE absence: every descendant was enumerated above and classified, and an
    // unclassifiable one is itself an UNKNOWN entry this window owns, so reaching
    // here means none is a connector and none is unknown.
    windows.push({ agent: b.agent_name, window_pid: b.window_pid, verdict: "NO CONNECTOR", reason: NO_CONNECTOR_REASON, connectors: [] });
  }

  // 4. The daemon line: the same comparison, on /health.build.
  let daemon: FleetJudgement["daemon"];
  if (!Array.isArray(s.daemon.listenerPids)) {
    daemon = { verdict: "UNKNOWN", reason: `the listener on port ${s.daemon.port} cannot be read (${s.daemon.listenerPids.error})`, pid: null, install_dir: null, running: null };
  } else if (daemonPids.length === 0) {
    daemon = { verdict: "UNKNOWN", reason: `no process is listening on port ${s.daemon.port}`, pid: null, install_dir: null, running: null };
  } else if (tableError) {
    daemon = { verdict: "UNKNOWN", reason: `the process table cannot be read (${tableError})`, pid: daemonPids[0], install_dir: null, running: null };
  } else if (!daemonDir) {
    daemon = {
      verdict: "UNKNOWN",
      reason: `the listener on port ${s.daemon.port} (pid ${daemonPids.join(", ")}) is not recognisable as a relay install`,
      pid: daemonPids[0],
      install_dir: null,
      running: null,
    };
  } else if (!s.daemon.health.ok) {
    daemon = { verdict: "UNKNOWN", reason: `its /health cannot be read (${s.daemon.health.error})`, pid: daemonDir.pid, install_dir: daemonDir.dir, running: null };
  } else {
    const v = verdictForBuild(s.daemon.health.build, installedAt(daemonDir.dir));
    daemon = {
      verdict: v.verdict,
      reason: v.verdict === "STALE" ? `not restarted after the install: ${v.reason}` : v.reason,
      pid: daemonDir.pid,
      install_dir: daemonDir.dir,
      running: describeBuild(s.daemon.health.build),
    };
  }

  const connectors = [...entries.values()].sort((a, b) => VERDICT_SEVERITY[b.verdict] - VERDICT_SEVERITY[a.verdict] || a.pid - b.pid);
  // Each connector once; a window only when it has NO connector (else its connectors already count).
  const failing =
    connectors.filter((e) => e.verdict !== "CURRENT").length +
    windows.filter((w) => w.connectors.length === 0 && w.verdict !== "CURRENT").length +
    (daemon.verdict === "CURRENT" ? 0 : 1);
  return { connectors, windows, daemon, failing };
}

/** The installed side for a dir: checkInstall (observed twice) + its stamp, for humans. */
export function readInstalled(dir: string): InstalledFacts {
  const check = checkInstall(dir);
  let stamp: InstalledFacts["stamp"] = null;
  try {
    const parsed = parseStamp(fs.readFileSync(path.join(dir, "dist", "build-info.js"), "utf-8"));
    if (parsed.ok) stamp = { commit: parsed.info.commit, dirty: parsed.info.dirty, built_at: parsed.info.built_at };
  } catch {
    /* the check already says why */
  }
  return { check, stamp };
}

/** Turn liveness's ProcEntry table + cwds (+ exact argv where available) into ProcessViews. */
export function toProcessViews(
  table: Map<number, ProcEntry>,
  cwdOf: (pid: number) => string | null,
  argvOf: (pid: number) => string[] | null,
): ProcessView[] {
  return [...table.values()].map((e) => ({
    pid: e.pid,
    ppid: e.ppid,
    start: e.startedAt,
    command: e.command,
    comm: e.comm,
    cwd: cwdOf(e.pid),
    argv: argvOf(e.pid),
  }));
}

// ---------------------------------------------------------------------------
// Observing the system (every read injectable; nothing is written)
// ---------------------------------------------------------------------------

export interface SystemDeps {
  /** The process table (liveness.buildProcessTable). An EMPTY table is a failed read. */
  processTable(): Map<number, ProcEntry>;
  /** The working directory of each given pid (for relative scripts); absent = unreadable. */
  cwds(pids: number[]): Map<number, string>;
  /** The EXACT argv where the platform gives one (Linux /proc/<pid>/cmdline), else null. */
  exactArgv(pid: number): string[] | null;
  /** Every pid holding ANY TCP listen socket, or {error}. */
  allListeners(): number[] | { error: string };
  /** The pids listening on this port, or {error}. */
  portListeners(port: number): number[] | { error: string };
  /** The daemon's /health JSON, or {error}. */
  health(port: number): Promise<{ ok: true; body: unknown } | { ok: false; error: string }>;
  nodeOnPath(): string | null;
  installed(dir: string): InstalledFacts;
}

/** What the DB says, at the instant of the process snapshot (the CLI reads it on its readonly handle). */
export interface DbReads {
  liveRows(startOf: (pid: number) => string | null): RowView[];
  liveBindings(): BindingView[];
}

/** /health.build → LoadedFacts, or why not. */
export function healthBuild(body: unknown): { ok: true; build: LoadedFacts } | { ok: false; error: string } {
  const b = body && typeof body === "object" ? (body as { build?: unknown }).build : undefined;
  if (!b || typeof b !== "object") return { ok: false, error: "its /health has no build field: the daemon predates the build stamp" };
  const r = b as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  if (typeof r.build_id !== "string") return { ok: false, error: "its /health build has no build_id" };
  return {
    ok: true,
    build: {
      build_id: r.build_id,
      deps_id: str(r.deps_id),
      deps_state: str(r.deps_state),
      commit: str(r.commit),
      dirty: typeof r.dirty === "boolean" ? r.dirty : null,
      built_at: str(r.built_at),
      node: str(r.node),
    },
  };
}

/** ONE snapshot of everything the judgement needs. */
export async function observeFleet(sys: SystemDeps, db: DbReads, port: number): Promise<FleetSnapshot> {
  const table = sys.processTable();
  const processes: FleetSnapshot["processes"] =
    table.size === 0
      ? { error: "ps returned no processes" }
      : toProcessViews(
          table,
          ((cwds) => (pid: number) => cwds.get(pid) ?? null)(
            sys.cwds([...table.values()].filter((e) => NODE_EXECUTABLES.test(path.basename(e.comm ?? e.command.split(" ")[0]))).map((e) => e.pid)),
          ),
          (pid) => sys.exactArgv(pid),
        );
  // Row liveness is read from THIS table, so the rows and the processes are one instant.
  const startOf = (pid: number): string | null => table.get(pid)?.startedAt ?? null;
  const portListeners = sys.portListeners(port);
  const healthRead = await sys.health(port);
  return {
    processes,
    listeners: sys.allListeners(),
    rows: db.liveRows(startOf),
    bindings: db.liveBindings(),
    daemon: {
      port,
      listenerPids: portListeners,
      health: healthRead.ok ? healthBuild(healthRead.body) : { ok: false, error: healthRead.error },
    },
    installed: (dir) => sys.installed(dir),
    nodeOnPath: sys.nodeOnPath(),
  };
}
