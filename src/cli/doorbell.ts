// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay doorbell status` (ADR-0038 Q3 + V2; plan v3 PR 5; architect ruling 9987c113): is the
 * doorbell job alive, on which build, in what condition, and with which OPEN escalations?
 * READ-ONLY: it reads the heartbeat and the doorbell's log, never writes either.
 *
 *   - V2's states, NEVER merged: `healthy` (a fresh heartbeat), `stale` (an old one, or one from
 *     the future), `not-installed` (no heartbeat in this instance's state dir), `disabled` (in the
 *     closed enum; nothing produces it until PR 8 adds the switch), and UNREADABLE, which is not a
 *     JSON state but a NON-ZERO EXIT with empty stdout and a loud stderr (F1's exit contract).
 *   - `build` (a SEPARATE field, ruling ab740fe3 Q2): verdictForBuild(heartbeat build, the install
 *     it names). A STALE build never changes `state`.
 *   - `condition` (Q2): the heartbeat's own, separate too.
 *   - Escalations: the OPEN ones, METADATA ONLY (agent, reason, operator, age): never message ids,
 *     never content (Q6).
 *   - `--hook`: exactly what the SessionStart hook prints (Q6): NOTHING when not-installed, or when
 *     healthy, CURRENT, condition ok or waiting-for-writer and no open escalation; otherwise one
 *     line plus at most 5 escalation lines and "+K more".
 * The DB is found by the SAME source decision as `relay pending` (the ONE resolver).
 *
 * Exit: 0 = read OK (any state) · 1 = unreadable · 2 = usage · 3 = no local relay instance here.
 */
import fs from "fs";
import path from "path";
import { EXIT_NO_LOCAL, decidePendingSource } from "./pending.js";
import { waitingGraceMs } from "../doorbell-heartbeat.js";

export const DOORBELL_STATES = ["healthy", "stale", "not-installed", "disabled"] as const;

export type DoorbellState = (typeof DOORBELL_STATES)[number];
/** Q6: at most this many escalation lines in the hook's output. */
export const HOOK_MAX_ESCALATIONS = 5;

interface Args {
  json: boolean;
  hook: boolean;
  dbPath: string | null;
  help: boolean;
  /** PR 8a: `relay doorbell policy --check` (read-only) instead of `status`. */
  policyCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, hook: false, dbPath: null, help: false, policyCheck: false };
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === "help") return { ...a, help: true };
  if (sub !== "status" && sub !== "policy") throw new Error(sub ? `unknown subcommand ${JSON.stringify(sub)} (only: status, policy --check)` : "a subcommand is required (status, policy --check)");
  if (sub === "policy") {
    a.policyCheck = true;
    if (!rest.includes("--check")) throw new Error("policy needs --check (it only reads the file; the writer is not part of this command)");
  }
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--check" && a.policyCheck) continue;
    if (t === "--json") a.json = true;
    else if (t === "--hook") a.hook = true;
    else if (t === "--db-path") {
      const v = rest[++i];
      if (!v) throw new Error("--db-path needs a path");
      a.dbPath = v;
    } else if (t === "--help" || t === "-h") a.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(t)}`);
  }
  if (a.json && a.hook) throw new Error("--json and --hook are exclusive");
  return a;
}

function usage(requested = false): void {
  const text =
    "Usage: relay doorbell status [--json | --hook] [--db-path P]\n" +
    "       relay doorbell policy --check [--db-path P]\n\n" +
    "Is the doorbell job alive (healthy / stale / not-installed / disabled), on which build\n" +
    "(CURRENT / STALE / UNKNOWN / INSTALL INCONSISTENT), in what condition (ok /\n" +
    "waiting-for-writer / log-full / failing), and with which OPEN escalations (metadata\n" +
    "only). Read-only.\n\n" +
    "  --json   Emit JSON.\n" +
    "  --hook   Print exactly what the SessionStart hook shows (nothing when all is well).\n\n" +
    "policy --check: read the wake policy (<instance dir>/doorbell-policy.json) and print whether it is\n" +
    "valid, with its counts, or policy_invalid and why (no agent can be woken then). Writes nothing.\n" +
    "Exit 0 = valid, 1 = invalid or unreadable.\n\n" +
    "Exit: 0 = read OK · 1 = unreadable (stdout empty) · 2 = usage · 3 = no local relay instance.\n";
  if (requested) process.stdout.write(text);
  else process.stderr.write(text);
}

const failed = (reason: string): number => {
  process.stderr.write(`DOORBELL_STATUS_FAILED: ${reason}\n`);
  return 1;
};

/** A short age for humans: 45s, 12m, 3h, 2d. */
export function shortAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export interface DoorbellStatus {
  ok: true;
  state: DoorbellState;
  why: string;
  build: { verdict: string; reason: string } | null;
  condition: string | null;
  heartbeat: {
    at: string;
    age_seconds: number;
    pid: number;
    proc_start: string | null;
    started_at: string;
    starts: number;
    starts_since: string;
    cycles: number;
    interval_ms: number;
    condition_since: string;
    condition_age_seconds: number;
    /** Unrounded (≥ 0): the waiting grace is compared on this, never on the rounded seconds. */
    condition_age_ms: number;
    consecutive_failures: number;
    cycle_failures: number;
    last_failure: { at: string; kind: string } | null;
    install_dir: string;
  } | null;
  escalations: { open: number; items: Array<{ agent: string; reason: string; operator: string | null; opened_at: string; age_seconds: number }> };
  /**
   * PR 6 (ruling 5dda2752): the OPEN board cases (mail this agent cannot be reached for), from the log.
   * `pending_count_at_open` is the logged snapshot; `pending_count` is read LIVE from the relay DB at
   * this read (null when it cannot be: `live` says why). Names and counts only, never a message id.
   */
  open_board_cases: Array<{ agent_name: string; case: string; since: string; age_seconds: number; binding_ids: string[]; dead_count: number; pending_count_at_open: number; pending_count: number | null; why?: string }>;
  /** Whether the LIVE pending counts could be read (and why not). */
  open_board_cases_live: { ok: true } | { ok: false; why: string };
  /** PR 7 (ruling 9becb599): DORMANT watches still alive, per agent (only agents with any). */
  dormant_watches: Record<string, number>;
  /** INV-LIVE-01: DORMANT watches whose process cannot be judged now (start unreadable or never recorded), per agent (only agents with any). Neither alive nor gone. */
  dormant_watches_unknown: Record<string, number>;
  /**
   * PR 8b (ruling 7eb82f49): the wake-coverage findings from the detector's durable sink, on this SAME surface as the
   * doorbell's own alarms: UNCOVERED is class "alarm", NEEDS_HUMAN class "report" (mail waits for a person; never
   * hidden), UNOBSERVABLE "unjudged". `generated_at` lets a reader judge staleness; an absent or invalid sink is
   * state "unknown", never an empty healthy list.
   */
  wake_coverage:
    | { state: "read"; generated_at: string; findings: Array<{ agent: string; verdict: string; class: "alarm" | "report" | "unjudged"; pending_count: number | null; oldest_age_seconds: number | null; reason?: string }> }
    | { state: "unknown" };
  /** PR 8a: the wake policy's state: valid, or policy_invalid with a content-free why (no agent can be woken then). */
  policy: { state: "valid" } | { state: "policy_invalid"; why: string };
  /**
   * PR 8a: mail HELD by the policy, per agent, never silent: for an OPTED-IN agent, its pending mail from senders
   * without standing (no_standing); while the policy is invalid, the pending mail of every agent with a LIVE watch
   * (policy_invalid). Counts and the oldest age only.
   */
  held: Record<string, { reason: "no_standing" | "policy_invalid"; count: number; oldest_age_seconds: number }>;
  /** PR 6: the agents the job's LAST cycle could not evaluate (a hold is never silent); null when it planned no cycle. */
  not_evaluated: { count: number; names: string[] } | null;
  /** Who last took the instance lock, from its NON-authoritative sidecar (display only; the lock itself is kernel-held). */
  holder: { pid: number; proc_start: string | null; host_id: string | null; since: string } | null;
  state_dir: string;
  db_path: string;
  resolution: Record<string, unknown> | null;
}

/**
 * The hook's lines (Q6), or [] when the hook must stay silent. Pure.
 * F1 (ruling b556c011): waiting-for-writer is silent only WITHIN its grace (waitingGraceMs); beyond
 * it, it is ONE line naming the likely cause, since no relay process holds the DB.
 */
/**
 * PR 8a: the policy lines. QUIET before the rollout (no file and no live watch): a missing file is the state of
 * every relay until a policy is installed. LOUD when a file exists but is invalid, or when any live watch cannot
 * wake because of it, and for held mail.
 */
export function policyLines(st: DoorbellStatus): string[] {
  const lines: string[] = [];
  const stuck = Object.entries(st.held).filter(([, h]) => h.reason === "policy_invalid");
  if (st.policy.state === "policy_invalid" && (st.policy.why !== "missing" || stuck.length > 0)) {
    lines.push(`[RELAY] doorbell policy: policy_invalid (${st.policy.why}): no agent can be woken${stuck.length ? `; live watches that cannot wake: ${stuck.map(([a, h]) => `${a} (${h.count} pending, oldest ${shortAge(h.oldest_age_seconds)})`).join(", ")}` : ""}`);
  }
  const noStanding = Object.entries(st.held).filter(([, h]) => h.reason === "no_standing");
  if (noStanding.length) lines.push(`[RELAY] doorbell policy: mail held (no standing to wake): ${noStanding.map(([a, h]) => `${a} ${h.count}, oldest ${shortAge(h.oldest_age_seconds)}`).join("; ")}`);
  return lines;
}

export function hookLines(st: DoorbellStatus): string[] {
  return [...policyLines(st), ...supervisorLines(st)];
}

function supervisorLines(st: DoorbellStatus): string[] {
  if (st.state === "not-installed") return [];
  const hb = st.heartbeat;
  const waitingTooLong = st.condition === "waiting-for-writer" && !!hb && hb.condition_age_ms > waitingGraceMs(hb.interval_ms);
  const quietCondition = st.condition === "ok" || (st.condition === "waiting-for-writer" && !waitingTooLong);
  const allWellOtherwise = st.state === "healthy" && st.build?.verdict === "CURRENT" && st.escalations.open === 0;
  if (allWellOtherwise && quietCondition) return [];
  if (allWellOtherwise && waitingTooLong && hb) {
    return [`[RELAY] doorbell: waiting for a writer for ${shortAge(hb.condition_age_seconds)}: no relay process holds the DB (daemon down? journal mode?)`];
  }
  const n = st.escalations.open;
  const lines = [`[RELAY] doorbell: ${st.state}, build ${st.build?.verdict ?? "unknown"}, ${st.condition ?? "no condition"}: ${n} open escalation${n === 1 ? "" : "s"}`];
  for (const e of st.escalations.items.slice(0, HOOK_MAX_ESCALATIONS)) lines.push(`[RELAY]   - ${e.agent}: ${e.reason}, open ${shortAge(e.age_seconds)}`);
  if (n > HOOK_MAX_ESCALATIONS) lines.push(`[RELAY]   +${n - HOOK_MAX_ESCALATIONS} more`);
  return lines;
}

/**
 * PR 6: each named agent's pending count, LIVE, through the job's own read-only open
 * (openRelayDbIfWritten: never a sidecar created) and the canonical pendingMetadata. An unopenable DB
 * is reported, never guessed: the board items then carry pending_count null.
 */
async function liveCounts(dbPath: string, agents: string[]): Promise<{ ok: true; counts: Map<string, number> } | { ok: false; why: string }> {
  if (agents.length === 0) return { ok: true, counts: new Map() };
  const { openRelayDbIfWritten } = await import("../doorbell-run.js");
  const { pendingMetadata } = await import("../db.js");
  let opened: Awaited<ReturnType<typeof openRelayDbIfWritten>>;
  try {
    opened = await openRelayDbIfWritten(dbPath);
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  if ("waiting" in opened) return { ok: false, why: opened.waiting };
  try {
    return { ok: true, counts: new Map(agents.map((a) => [a, pendingMetadata(opened.db, a).count])) };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  } finally {
    opened.db.close();
  }
}

/** PR 8b: the wake-coverage sink's findings, classed (read-only; an absent or invalid sink is "unknown"). */
async function readWakeCoverage(): Promise<DoorbellStatus["wake_coverage"]> {
  const { readWakeCoverageStatus } = await import("../wake-coverage-status.js");
  const st = readWakeCoverageStatus();
  if (st === null) return { state: "unknown" };
  const cls = (v: string): "alarm" | "report" | "unjudged" => (v === "uncovered" ? "alarm" : v === "needs_human" ? "report" : "unjudged");
  return {
    state: "read",
    generated_at: st.generatedAt,
    findings: st.findings.map((f) => {
      const x = f as unknown as { agent: string; verdict: string; pendingCount?: unknown; oldestAgeMs?: unknown; reason?: unknown };
      return {
        agent: x.agent,
        verdict: x.verdict,
        class: cls(x.verdict),
        pending_count: typeof x.pendingCount === "number" ? x.pendingCount : null,
        oldest_age_seconds: typeof x.oldestAgeMs === "number" ? Math.round(x.oldestAgeMs / 1000) : null,
        ...(typeof x.reason === "string" ? { reason: x.reason } : {}),
      };
    }),
  };
}

/**
 * PR 8a: the policy's state and the HELD mail (read-only; the job's own no-sidecar open). Valid: each opted-in
 * agent's pending mail from senders without standing. Invalid: the pending mail of each agent whose watch is LIVE
 * (it is armed and cannot wake). An unopenable DB holds nothing back: held is then empty, the policy state stands.
 */
async function readPolicyAndHeld(dbPath: string): Promise<{ policy: DoorbellStatus["policy"]; held: DoorbellStatus["held"] }> {
  const { readWakePolicy, policyStanding } = await import("../wake-policy.js");
  // A NULL-PROTOTYPE dictionary (Codex #447 R1 P2): "__proto__" is a valid agent name, and a plain {} would turn its
  // record into a prototype change that vanishes from the JSON (its held mail silent).
  const held = Object.create(null) as DoorbellStatus["held"];
  const unbound = (): { policy: DoorbellStatus["policy"]; held: DoorbellStatus["held"] } => {
    const r = readWakePolicy(path.dirname(dbPath));
    return { policy: r.ok ? { state: "valid" } : { state: "policy_invalid", why: r.why }, held };
  };
  const { openRelayDbBound } = await import("./watch-until-wake.js");
  const { pendingMetadata, agentRegistered } = await import("../db.js");
  let opened: Awaited<ReturnType<typeof openRelayDbBound>>;
  try {
    opened = await openRelayDbBound(dbPath);
  } catch {
    return unbound();
  }
  if (!opened) return unbound();
  const db = opened.db;
  // The policy read is BOUND to the file this handle opened (Codex #447 R1 P1 / R2 P1-b), as the watch binds its own.
  const read = readWakePolicy(path.dirname(dbPath), { bound: { dbPath, identity: opened.identity } });
  const policy: DoorbellStatus["policy"] = read.ok ? { state: "valid" } : { state: "policy_invalid", why: read.why };
  try {
    if (read.ok) {
      const standing = policyStanding(read.file, (n) => agentRegistered(db, n));
      for (const agent of [...new Set(read.file.optIn)].sort()) {
        const refused = pendingMetadata(db, agent).messages.filter((m) => standing({ sender: m.from, recipient: agent, kind: "direct", id: m.id }) !== "allowed");
        if (refused.length) held[agent] = { reason: "no_standing", count: refused.length, oldest_age_seconds: Math.max(...refused.map((m) => m.age_seconds)) };
      }
    } else {
      const { agentWatchStatus } = await import("./watch-until-wake.js");
      const W = await import("../watch-wake.js");
      const root = path.join(path.dirname(dbPath), "watch");
      let names: string[] = [];
      try {
        names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && W.watchableName(e.name)).map((e) => e.name).sort();
      } catch {
        /* no watch dir: no watch was ever armed here */
      }
      for (const agent of names) {
        if ((await agentWatchStatus(db, dbPath, agent)) !== "live") continue;
        const msgs = pendingMetadata(db, agent).messages;
        if (msgs.length) held[agent] = { reason: "policy_invalid", count: msgs.length, oldest_age_seconds: Math.max(...msgs.map((m) => m.age_seconds)) };
      }
    }
  } catch {
    /* a read fault holds nothing back here; the policy state stands */
  } finally {
    db.close();
  }
  return { policy, held };
}

/** `relay doorbell policy --check`: read the policy, print its verdict. Writes nothing. */
async function runPolicyCheck(dbPath: string): Promise<number> {
  const { readWakePolicy } = await import("../wake-policy.js");
  const r = readWakePolicy(path.dirname(dbPath));
  if (!r.ok) {
    process.stdout.write(`[RELAY] doorbell policy: policy_invalid (${r.why}): no agent can be woken\n`);
    return 1;
  }
  process.stdout.write(`[RELAY] doorbell policy: valid (${r.file.optIn.length} agent(s) opted in, ${r.file.wake.length} wake pair(s), ${r.file.pairWakesPerHour} wake(s) per pair per hour)\n`);
  return 0;
}

/** Read the status for a resolved DB path. Throws on anything unreadable (the caller exits 1). */
/**
 * PR 7: how many DORMANT watches are still alive, per agent (read-only): every record under
 * <instance>/watch/<agent>/ whose process (pid + start) still runs. Real directories only.
 * INV-LIVE-01: one whose process cannot be judged (its start unreadable now, or never recorded, and the
 * pid not gone) is counted apart as unknown, never as alive or gone.
 */
async function countDormantWatches(dbPath: string): Promise<{ live: Record<string, number>; unknown: Record<string, number> }> {
  const { countLiveDormant } = await import("../watch-wake.js");
  const { processStartedAt, anchorState } = await import("../liveness.js");
  const root = path.join(path.dirname(dbPath), "watch");
  const out = { live: {} as Record<string, number>, unknown: {} as Record<string, number> };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const n = countLiveDormant(path.join(root, e.name), (pid, start) => {
      const r = processStartedAt(pid);
      if (r.kind === "gone") return "gone";
      if (start === null) return "unknown"; // no recorded start: the pid alone is not an identity
      const s = anchorState(r, start);
      return s === "same" ? "live" : s;
    });
    if (n.live > 0) out.live[e.name] = n.live;
    if (n.unknown > 0) out.unknown[e.name] = n.unknown;
  }
  return out;
}

export async function readDoorbellStatus(dbPath: string, resolution: Record<string, unknown> | null, nowWall = Date.now()): Promise<DoorbellStatus> {
  const { stateDirFor, readLogState, LOG_FILENAME } = await import("../doorbell-log.js");
  const { readHeartbeat, judgeHeartbeat } = await import("../doorbell-heartbeat.js");
  const stateDir = stateDirFor(dbPath);
  const hb = readHeartbeat(stateDir);
  const { readHolderInfo } = await import("../doorbell-lock.js");
  const holder = readHolderInfo(stateDir);
  if (hb.kind === "unreadable") throw new Error(hb.reason);

  // OPEN escalations, from the log (read-only, no-follow, validated; an invalid log is unreadable).
  const items: DoorbellStatus["escalations"]["items"] = [];
  const logPath = path.join(stateDir, LOG_FILENAME);
  if (fs.existsSync(logPath)) {
    const last = new Map<string, { agent: string; reason: string; operator: string | null; state: string; opened_at: string }>();
    for (const r of readLogState(logPath).records) {
      if (r.type !== "escalation") continue;
      const prior = last.get(r.escalation_id);
      last.set(r.escalation_id, { agent: r.agent_name, reason: r.reason, operator: r.operator, state: r.state, opened_at: prior?.opened_at ?? r.at });
    }
    for (const e of last.values()) {
      if (e.state !== "open") continue;
      items.push({ agent: e.agent, reason: e.reason, operator: e.operator, opened_at: e.opened_at, age_seconds: Math.max(0, Math.round((nowWall - Date.parse(e.opened_at)) / 1000)) });
    }
    items.sort((a, b) => (a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : a.agent < b.agent ? -1 : 1));
  }

  // PR 6: OPEN board cases, from the same validated log; each pending count read LIVE (read-only, and
  // only when a writer's sidecars exist: this verb never creates one, exactly like the job).
  const boardOpen = fs.existsSync(logPath) ? [...readLogState(logPath).boardOpen.values()] : [];
  const live = await liveCounts(dbPath, boardOpen.map((r) => r.agent_name));
  const openBoardCases: DoorbellStatus["open_board_cases"] = boardOpen
    .map((r) => ({
      agent_name: r.agent_name,
      case: r.case,
      since: r.at,
      age_seconds: Math.max(0, Math.round((nowWall - Date.parse(r.at)) / 1000)),
      binding_ids: r.binding_ids,
      dead_count: r.dead_count,
      pending_count_at_open: r.pending_count,
      pending_count: live.ok ? (live.counts.get(r.agent_name) ?? 0) : null,
      ...(r.why ? { why: r.why } : {}), // PR 7: only on no_driver (watch_absent | watch_stale)
    }))
    .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.agent_name < b.agent_name ? -1 : 1));
  const openBoardCasesLive: DoorbellStatus["open_board_cases_live"] = live.ok ? { ok: true } : { ok: false, why: live.why };
  const dormantWatches = await countDormantWatches(dbPath);
  const wakeCoverage = await readWakeCoverage();
  const { policy, held } = await readPolicyAndHeld(dbPath);

  if (hb.kind === "absent") {
    return { ok: true, state: "not-installed", why: `no heartbeat in ${stateDir}`, build: null, condition: null, heartbeat: null, escalations: { open: items.length, items }, open_board_cases: openBoardCases, open_board_cases_live: openBoardCasesLive, dormant_watches: dormantWatches.live, dormant_watches_unknown: dormantWatches.unknown, wake_coverage: wakeCoverage, policy, held, not_evaluated: null, holder, state_dir: stateDir, db_path: dbPath, resolution };
  }
  const h = hb.heartbeat;
  const judged = judgeHeartbeat(h, nowWall);
  // A condition_since in the future (the clock went back) reads as age 0: the writer resets it.
  const conditionAgeMs = Math.max(0, nowWall - Date.parse(h.condition_since));
  const { verdictForBuild, readInstalled } = await import("../fleet-verdicts.js");
  const b = verdictForBuild(h.build as unknown as import("../fleet-verdicts.js").LoadedFacts, readInstalled(h.install_dir));
  return {
    ok: true,
    state: judged.state,
    why: judged.why,
    build: { verdict: b.verdict, reason: b.reason },
    condition: h.condition,
    heartbeat: {
      at: h.at,
      age_seconds: Math.round(judged.age_ms / 1000),
      pid: h.pid,
      proc_start: h.proc_start,
      started_at: h.started_at,
      starts: h.starts,
      starts_since: h.starts_since,
      cycles: h.cycles,
      interval_ms: h.interval_ms,
      condition_since: h.condition_since,
      condition_age_seconds: Math.round(conditionAgeMs / 1000),
      condition_age_ms: conditionAgeMs,
      consecutive_failures: h.consecutive_failures,
      cycle_failures: h.cycle_failures,
      last_failure: h.last_failure,
      install_dir: h.install_dir,
    },
    escalations: { open: items.length, items },
    open_board_cases: openBoardCases,
    open_board_cases_live: openBoardCasesLive,
    dormant_watches: dormantWatches.live,
    dormant_watches_unknown: dormantWatches.unknown,
    wake_coverage: wakeCoverage,
    policy,
    held,
    not_evaluated: h.not_evaluated,
    holder,
    state_dir: stateDir,
    db_path: dbPath,
    resolution,
  };
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay doorbell: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 2;
  }
  if (args.help) {
    usage(true);
    return 0;
  }
  let source: Awaited<ReturnType<typeof decidePendingSource>>["source"];
  let resolution: import("../instance.js").ResolvedInstance | null = null;
  try {
    ({ source, resolution } = await decidePendingSource(args.dbPath));
  } catch (err) {
    return failed(`could not resolve the relay DB path: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (source.kind === "no-local") {
    process.stderr.write(`DOORBELL_NO_LOCAL: ${source.reason}\n`);
    return EXIT_NO_LOCAL;
  }
  if (source.kind === "ambiguous" || source.kind === "unreadable") return failed(source.reason);
  if (args.policyCheck) return await runPolicyCheck(source.dbPath);
  let st: DoorbellStatus;
  try {
    const { serializeResolution } = await import("../instance.js");
    st = await readDoorbellStatus(source.dbPath, resolution ? serializeResolution(resolution) : null);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  if (args.json) process.stdout.write(JSON.stringify(st) + "\n");
  else if (args.hook) {
    const lines = hookLines(st);
    if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");
  } else {
    process.stdout.write(`[RELAY] doorbell: ${st.state} (${st.why})${st.build ? `, build ${st.build.verdict}` : ""}${st.condition ? `, ${st.condition}` : ""}, ${st.escalations.open} open escalation(s), ${st.open_board_cases.length} open board case(s)${Object.keys(st.dormant_watches).length ? `, dormant watches: ${Object.entries(st.dormant_watches).map(([a, n]) => `${a}=${n}`).join(" ")}` : ""}${Object.keys(st.dormant_watches_unknown).length ? `, dormant watches that cannot be judged now: ${Object.entries(st.dormant_watches_unknown).map(([a, n]) => `${a}=${n}`).join(" ")}` : ""}${st.wake_coverage.state === "read" && st.wake_coverage.findings.length ? `, wake-coverage: ${st.wake_coverage.findings.map((f) => `${f.agent}=${f.verdict}${f.reason ? `(${f.reason})` : ""}`).join(" ")}` : ""}, policy ${st.policy.state === "valid" ? "valid" : `policy_invalid (${st.policy.why})`}${Object.keys(st.held).length ? `, held: ${Object.entries(st.held).map(([a, h]) => `${a}=${h.count} (${h.reason})`).join(" ")}` : ""}\n`);
  }
  return 0;
}
