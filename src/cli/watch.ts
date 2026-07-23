// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.18.0 — Sentinel: `relay watch <agent>` subcommand.
 *
 * Surface-agnostic autowake for terminal agents NOT in VS Code/Tether (iTerm2
 * personas, plain terminals, remote sessions). The poll/marker-based counterpart
 * to Tether's push-based wake: it stands watch over an agent's inbox and emits a
 * wake SIGNAL (a stdout line a harness Monitor consumes) when new mail lands.
 *
 * Design (spec-gated to fork A — in-process, local-trust):
 *   - Consumes the SANCTIONED cheap primitive `peekMailboxVersion` in-process
 *     (a single indexed COUNT query — NOT a raw sqlite scan loop). The wake
 *     signal is `total_unread_count` rising (last_seq is unreliable before the
 *     recipient's first observation — v2.3.0 Codex HIGH #2).
 *   - Event-driven when `RELAY_FILESYSTEM_MARKERS=1`: waits on the delivery
 *     marker (~/.bot-relay/marker/<agent>.touch, written by the daemon on every
 *     delivery) via fs.watch — near-zero idle cost — with a slow fallback
 *     re-check so a DROPPED fs.watch event is never a silent permanent miss
 *     (the marker is a HINT, not a queue). Falls back to bounded polling when
 *     markers are off.
 *   - Local-trust auth (filesystem authority, like `mint-token` / `recover`):
 *     the operator's read access to the per-instance DB IS the authority; no
 *     token. `--remote` (token via /mcp) is a documented forward-compat flag,
 *     NOT built here (YAGNI).
 *
 * INSTANCE-DB TRAP (hard requirement): the in-process read MUST resolve the
 * ACTIVE per-instance DB (~/.bot-relay/instances/<id>/relay.db), the SAME path
 * the daemon writes — NOT the legacy ~/.bot-relay/relay.db. Reading the wrong
 * path watches a dead DB and never sees mail (the stdio-legacy-DB-split bug).
 * We set RELAY_DB_PATH from resolveInstanceDbPath() exactly as the daemon does.
 */
import fs from "fs";
import path from "path";

interface Args {
  agent: string | null;
  intervalMs: number;
  once: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { agent: null, intervalMs: 3000, once: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--once") out.once = true;
    else if (a === "--json") out.json = true;
    else if (a === "--interval") {
      const v = argv[++i];
      const secs = Number(v);
      if (!v || !Number.isFinite(secs) || secs < 1) throw new Error("--interval requires seconds >= 1");
      out.intervalMs = Math.round(secs * 1000);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (!out.agent) {
      out.agent = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return out;
}

function usage(requested = false): void {
  // STREAM DISCIPLINE: usage is diagnostic on the ERROR path, so it goes to
  // STDERR. On stdout it poisoned command substitutions — a failed
  // $(relay mint-token ... --json) captured the help text and the agent
  // launched with a garbage token that LOOKED like a value. `requested`
  // (an explicit --help) is the one case where the text IS the data.
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay watch <agent> [--interval SECONDS] [--once] [--json]\n\n" +
      "Sentinel — autowake for a terminal agent NOT in VS Code/Tether. Watches\n" +
      "<agent>'s inbox and prints a wake line when new mail arrives, so a harness\n" +
      "Monitor (or you) can nudge the agent to read it. Event-driven when\n" +
      "RELAY_FILESYSTEM_MARKERS=1 (near-zero idle cost); bounded polling otherwise.\n\n" +
      "  <agent>            Agent name to watch (its own inbox).\n" +
      "  --interval SECONDS Poll cadence when markers are off (default 3; the\n" +
      "                     marker path is event-driven regardless).\n" +
      "  --once             Check once and exit (0). For scripts / smoke tests.\n" +
      "  --json             Emit each wake as a JSON line (machine-consumable).\n" +
      "  --help             Show this message.\n\n" +
      "Auth: local-trust — reads the ACTIVE per-instance relay DB directly\n" +
      "(operator filesystem authority, like `relay mint-token`). Runs until Ctrl-C.\n"
  );
}

/**
 * Evidence that the MARKER wake path is live — deliberately hard to satisfy.
 *
 * This exists so a degraded wake path announces itself instead of quietly
 * falling back to the 30s poll. Two ways it previously lied, both found by
 * codex on #121, both re-creating the exact silence this file is meant to end:
 *
 *   1. `!filename` was accepted as proof. fs.watch may fire with no filename;
 *      that is an unrelated directory change, or another agent's marker, or
 *      ours — indistinguishable. One anonymous event permanently suppressed
 *      the announcement.
 *   2. The flag LATCHED. One legitimate marker early in the process's life
 *      made it true forever, so if the marker writer later died, every
 *      subsequent message was found by the poll and the degraded branch could
 *      never fire. "A marker worked once" is not evidence that the wake path
 *      worked for THIS message.
 *
 * So: proof requires a POSITIVELY IDENTIFIED filename, and it is CONSUMED —
 * each window is judged on its own delivery. Exported for the negative
 * controls; the guard is only worth having if it can be shown to say no.
 */
export interface MarkerEvidence {
  /** Record an fs.watch event. Returns true iff it counts as proof. */
  record(filename: string | Buffer | null | undefined, base: string): boolean;
  /** Read AND reset. The value covers only the window since the last consume. */
  consume(): boolean;
}

export function createMarkerEvidence(): MarkerEvidence {
  let proven = false;
  return {
    record(filename, base) {
      // Buffer/null/undefined are all UNPROVEN. Only an exact string match on
      // this agent's own marker basename is evidence.
      if (typeof filename === "string" && filename === base) {
        proven = true;
        return true;
      }
      return false;
    },
    consume() {
      const seen = proven;
      proven = false;
      return seen;
    },
  };
}

/** Emit the wake signal: a single stdout line a harness Monitor can consume. */
function emitWake(
  agent: string,
  snap: { total_unread_count: number; epoch: string; last_seq: number },
  previousUnread: number,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(
      JSON.stringify({
        event: "wake",
        agent,
        total_unread_count: snap.total_unread_count,
        previous_unread: previousUnread,
        epoch: snap.epoch,
        at: new Date().toISOString(),
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `[sentinel] ${agent}: ${snap.total_unread_count} unread (was ${previousUnread}) — check your inbox\n`,
    );
  }
}

/**
 * Is there actually something that will WRITE the marker?
 *
 * Markers are written by the daemon's outbox tail (the single owner), so the
 * producer side is only live when a daemon is reachable AND that daemon has
 * markers enabled. Reachability alone is not enough — a daemon running without
 * RELAY_FILESYSTEM_MARKERS never touches the marker, which is precisely the
 * silent degradation this assertion exists to catch. `/health` reports
 * `filesystem_markers` for exactly this purpose.
 *
 * Conservative by design: any failure (no daemon, timeout, old daemon that does
 * not report the field) returns false, so we announce POLLING. Claiming the
 * slower mode when unsure is safe; claiming the faster one when unsure is the
 * bug we are fixing.
 */
type MarkerWriterProbe =
  | { live: true }
  | { live: false; reason: string };

async function probeMarkerWriter(): Promise<MarkerWriterProbe> {
  const port = process.env.RELAY_HTTP_PORT ?? "3777";
  const host = process.env.RELAY_HTTP_HOST ?? "127.0.0.1";
  const where = `${host}:${port}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    if (!res.ok) {
      return { live: false, reason: `daemon at ${where} answered /health with HTTP ${res.status}` };
    }
    const body = (await res.json()) as { filesystem_markers?: boolean };
    if (body.filesystem_markers === true) return { live: true };
    if (body.filesystem_markers === false) {
      return {
        live: false,
        reason: `daemon at ${where} is running WITHOUT RELAY_FILESYSTEM_MARKERS=1, so it never writes markers`,
      };
    }
    // Strict: an older daemon omits the field entirely, and "absent" must not
    // read as "enabled". Absence of information is not information — say
    // exactly that rather than blaming a daemon that is plainly reachable.
    return {
      live: false,
      reason: `daemon at ${where} is reachable but does not report filesystem_markers (pre-2.22 build) — cannot confirm the marker path`,
    };
  } catch {
    return { live: false, reason: `no relay daemon reachable at ${where}, so nothing will ever write the marker` };
  } finally {
    clearTimeout(timeout);
  }
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay watch: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 1;
  }
  if (args.help) {
    usage(true);
    return 0;
  }
  if (!args.agent) {
    process.stderr.write("relay watch: missing <agent> (the agent whose inbox to watch)\n");
    return 1;
  }
  const agent = args.agent;

  // INSTANCE-DB TRAP: resolve the ACTIVE per-instance DB, exactly as the daemon
  // does — never the legacy ~/.bot-relay/relay.db. The marker the daemon writes
  // (~/.bot-relay/marker/<agent>.touch) and this DB then describe the same live
  // instance.
  try {
    const { resolveInstanceDbPath } = await import("../instance.js");
    if (!process.env.RELAY_DB_PATH) process.env.RELAY_DB_PATH = resolveInstanceDbPath();
  } catch {
    /* fall back to db.ts default resolution */
  }

  const { initializeDb, peekMailboxVersion, closeDb } = await import("../db.js");
  await initializeDb();
  const { markersEnabled, markerPath } = await import("../filesystem-marker.js");

  let prevUnread: number | null = null;
  let prevEpoch: string | null = null;

  const check = (): void => {
    let snap: { total_unread_count: number; epoch: string; last_seq: number };
    try {
      snap = peekMailboxVersion(agent);
    } catch {
      return; // transient read error — a later signal/tick retries (never fatal)
    }
    // Epoch change (DB backup/restore) → the cached baseline is incomparable;
    // reset it so we don't miss or double-fire (v2.3.0 epoch semantics).
    if (prevEpoch !== null && snap.epoch !== prevEpoch) prevUnread = null;
    prevEpoch = snap.epoch;

    const unread = snap.total_unread_count;
    if (prevUnread === null) {
      // First observation: set the baseline. If there is ALREADY pending mail
      // (the "register → start your watch" flow), surface it once.
      if (unread > 0) emitWake(agent, snap, 0, args.json);
    } else if (unread > prevUnread) {
      emitWake(agent, snap, prevUnread, args.json);
    }
    prevUnread = unread;
  };

  if (args.once) {
    check();
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    return 0;
  }

  // --- Continuous watch. Bounded, no busy-spin. Runs until SIGINT/SIGTERM. ---
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    try {
      closeDb();
    } catch {
      /* ignore */
    }
  };
  const onSignal = (): void => {
    stop();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  check(); // baseline / surface existing mail

  // --- END-TO-END WAKE-PATH ASSERTION -----------------------------------
  // The old startup line reported markersEnabled(), which reads THIS process's
  // env. That attests to the wrong thing: a watcher can print "event-driven"
  // while no producer ever touches the marker, and it will simply run slow
  // forever. A status line that can confidently state the opposite of reality
  // is worse than no status line, because the operator stops looking.
  //
  // So the mode is now asserted from BEHAVIOUR, in two places:
  //   1. STARTUP — markers are written by the daemon's outbox tail (the single
  //      owner). If markers are enabled but no daemon is reachable, nothing
  //      will EVER write the marker, so event-driven is a false claim and we
  //      say polling instead. This is checkable before any mail arrives.
  //   2. RUNTIME — if new mail is first observed by the FALLBACK TIMER rather
  //      than by the marker watcher, the marker did not fire for a message
  //      that definitely landed. That is the degraded case proving itself, and
  //      it is announced once and acted on (see tightenToPolling).
  const markerEvidence = createMarkerEvidence();
  let degradedAnnounced = false;

  /** Did a real marker write reach us, or are we only being saved by the timer? */
  const announceDegraded = (reason: string): void => {
    if (degradedAnnounced) return;
    degradedAnnounced = true;
    process.stderr.write(
      `[sentinel] DEGRADED — wake is POLLING, not event-driven: ${reason}\n` +
        `[sentinel]   markers are enabled in THIS process, but that only controls whether we\n` +
        `[sentinel]   WATCH the marker — the daemon's outbox tail is what WRITES it.\n` +
        `[sentinel]   Latency will be up to the poll interval instead of ~10ms.\n` +
        `[sentinel]   Check: is the daemon running with RELAY_FILESYSTEM_MARKERS=1?\n`,
    );
  };

  /**
   * In marker mode the safety-net tick is deliberately slow (30s). If markers
   * are in fact dead, that is SLOWER than plain polling would have been, so a
   * degraded watcher must fall back to the real poll interval rather than sit
   * on a 30s net it no longer has a reason to trust.
   */
  const tightenToPolling = (): void => {
    if (timer) clearInterval(timer);
    timer = setInterval(check, args.intervalMs);
  };

  if (markersEnabled()) {
    // Event-driven: watch the marker's DIRECTORY (the file may not exist until
    // the first delivery) and re-check on any touch of <agent>.touch. A slow
    // fallback tick recovers dropped fs.watch events — the marker is a HINT, so
    // a missed event must never be a silent permanent miss.
    const mp = markerPath(agent);
    if (mp) {
      const dir = path.dirname(mp);
      const base = path.basename(mp);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* best-effort */
      }
      try {
        watcher = fs.watch(dir, (_event, filename) => {
          // record() returns true ONLY for a positively identified marker for
          // THIS agent — that is the sole positive evidence the wake path works
          // end to end. Anything else (no filename, another agent's marker) is
          // indistinguishable from an unrelated directory change, so it stays
          // UNPROVEN. We still check() either way: checking is free and correct,
          // and it is claiming PROOF from an unidentified event that would let
          // one anonymous callback suppress the degraded announcement forever.
          markerEvidence.record(filename, base);
          check();
        });
      } catch {
        /* fs.watch unsupported here → interval-only below still covers it */
      }
    }
    const FALLBACK_MS = 30_000; // marker-miss safety net
    timer = setInterval(() => {
      // PER-WINDOW, NOT PER-PROCESS. `sawMarkerEvent` used to latch: one
      // legitimate marker early in the watcher's life made it true forever, so
      // if the marker writer later died, every subsequent message was found by
      // this poll and the degraded branch could never fire again. "A marker
      // worked once" is not evidence that the wake path worked for THIS
      // message. Consume the evidence and reset, so each window is judged on
      // its own delivery.
      const sawMarkerThisWindow = markerEvidence.consume();
      const before = prevUnread;
      check();
      // New mail that the marker watcher never told us about: the marker did
      // not fire for a message that definitely landed. Prove-by-behaviour that
      // we are degraded, then stop pretending the 30s net is a wake path.
      if (!sawMarkerThisWindow && before !== null && prevUnread !== null && prevUnread > before) {
        announceDegraded("new mail was detected by the fallback poll, not by a marker event");
        tightenToPolling();
      }
    }, FALLBACK_MS);
  } else {
    // No markers → bounded polling of the cheap primitive.
    timer = setInterval(check, args.intervalMs);
  }

  // STARTUP ASSERTION — markers are daemon-written, so a marker-mode watcher
  // with no reachable daemon is claiming an event path that cannot exist.
  // Checked before any mail arrives so the operator is not told "event-driven"
  // and then left to discover otherwise.
  let modeLabel: string;
  if (!markersEnabled()) {
    modeLabel = `polling every ${Math.round(args.intervalMs / 1000)}s`;
  } else {
    const probe = await probeMarkerWriter();
    if (probe.live) {
      modeLabel = "event-driven; marker writer confirmed live";
    } else {
      modeLabel = `polling every ${Math.round(args.intervalMs / 1000)}s (markers enabled but marker writer NOT confirmed)`;
      announceDegraded(probe.reason);
      tightenToPolling();
    }
  }

  process.stderr.write(
    `[sentinel] watching "${agent}" (${modeLabel}) — marker=${markerPath(agent) ?? "n/a"} — Ctrl-C to stop.\n`,
  );

  // Hold the process open (the timer + watcher keep the event loop alive) until
  // a signal calls process.exit. This promise never resolves by design.
  return await new Promise<number>(() => {});
}
