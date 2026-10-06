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
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, hook: false, dbPath: null, help: false };
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === "help") return { ...a, help: true };
  if (sub !== "status") throw new Error(sub ? `unknown subcommand ${JSON.stringify(sub)} (only: status)` : "a subcommand is required (status)");
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
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
    "Usage: relay doorbell status [--json | --hook] [--db-path P]\n\n" +
    "Is the doorbell job alive (healthy / stale / not-installed / disabled), on which build\n" +
    "(CURRENT / STALE / UNKNOWN / INSTALL INCONSISTENT), in what condition (ok /\n" +
    "waiting-for-writer / log-full / failing), and with which OPEN escalations (metadata\n" +
    "only). Read-only.\n\n" +
    "  --json   Emit JSON.\n" +
    "  --hook   Print exactly what the SessionStart hook shows (nothing when all is well).\n\n" +
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
export function hookLines(st: DoorbellStatus): string[] {
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

/** Read the status for a resolved DB path. Throws on anything unreadable (the caller exits 1). */
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

  if (hb.kind === "absent") {
    return { ok: true, state: "not-installed", why: `no heartbeat in ${stateDir}`, build: null, condition: null, heartbeat: null, escalations: { open: items.length, items }, holder, state_dir: stateDir, db_path: dbPath, resolution };
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
    process.stdout.write(`[RELAY] doorbell: ${st.state} (${st.why})${st.build ? `, build ${st.build.verdict}` : ""}${st.condition ? `, ${st.condition}` : ""}, ${st.escalations.open} open escalation(s)\n`);
  }
  return 0;
}
