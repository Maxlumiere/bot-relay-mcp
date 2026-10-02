// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The doorbell job (ADR-0038; plan v3 PR 1): a SEPARATE local process, started as
 * `node <install>/dist/doorbell.js`, never `dist/index.js` (plan v3: the connector
 * classifier would read that as a connector with no row, and the deploy check would
 * fail forever). Nothing installs it yet: the launchd installer lands in PR 5b with the
 * heartbeat line that judges its build (invariant I1, src/entrypoints.ts).
 *
 * What it does, every cycle: read F1's canonical pending set for each local candidate
 * and WRITE-AHEAD an intent per agent with new mail (src/doorbell-core.ts). There is no
 * driver yet, so nothing is rung: the intents only land in the log.
 *
 *   - V1: NO write handle to the relay DB. It is opened READ-ONLY at the driver
 *     (openPendingDb), so a write through it throws; the job writes only its own state
 *     dir, beside the resolved DB (plan v3 Q5).
 *   - ADR-0048: the DB comes from the ONE strict resolver. A fault, or a DB that does not
 *     exist, refuses the start (exit 1); it never picks another DB.
 *   - No listener: it opens no socket of any kind, and no tool or HTTP route accepts an
 *     intent (A1 §A2).
 *   - A2.1 (never on a hub): there is no hub mode setting to read today, so the guarantee
 *     is STRUCTURAL: a candidate must be on THIS host (host_id equal to our own; unknown
 *     own host = no candidate), so no other machine's window is ever a target. An explicit
 *     hub refusal waits for a hub mode to exist (recorded in the plan, not invented here).
 *
 * Exit: 0 = stopped cleanly (--once done, or SIGTERM/SIGINT) · 1 = cannot run (resolver
 * fault, DB unreadable, log refused) · 2 = usage.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { LOADED_BUILD } from "./loaded-build.js";
import { resolveInstance, serializeResolution } from "./instance.js";
import { getOwnHostId } from "./liveness.js";
import { planCycle, type PendingRead } from "./doorbell-core.js";
import { appendRecord, prepareLog, readRungMemory, rungKey, stateDirFor } from "./doorbell-log.js";

export const DEFAULT_INTERVAL_MS = 5000;
export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 600_000;

interface Args {
  once: boolean;
  intervalMs: number;
}

function usage(out: NodeJS.WriteStream): void {
  out.write(
    "Usage: node dist/doorbell.js [--once] [--interval-ms N]\n" +
      "  The doorbell job: logs a content-free intent per agent with new pending mail.\n" +
      `  --once           run one cycle and exit\n` +
      `  --interval-ms N  cycle period, ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS} (default ${DEFAULT_INTERVAL_MS})\n`,
  );
}

function parseArgs(argv: string[]): Args | { error: string } | "help" {
  const a: Args = { once: false, intervalMs: DEFAULT_INTERVAL_MS };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") return "help";
    else if (t === "--once") a.once = true;
    else if (t === "--interval-ms") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < MIN_INTERVAL_MS || v > MAX_INTERVAL_MS) {
        return { error: `--interval-ms must be an integer in ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS}` };
      }
      a.intervalMs = v;
    } else return { error: `unknown argument ${JSON.stringify(t)}` };
  }
  return a;
}

const fail = (reason: string): number => {
  process.stderr.write(`DOORBELL_FAILED: ${reason}\n`);
  return 1;
};

/** The install this process was loaded from (the parent of its dist/). */
function ownInstallDir(): string {
  const dist = path.dirname(fileURLToPath(import.meta.url));
  try {
    return fs.realpathSync(path.dirname(dist));
  } catch {
    return path.dirname(dist);
  }
}

export async function runDoorbell(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === "help") {
    usage(process.stderr); // stderr: src/ keeps stdout for the MCP channel (tests/no-stdout-writes.test.ts)
    return 0;
  }
  if ("error" in args) {
    process.stderr.write(`doorbell: ${args.error}\n`);
    usage(process.stderr);
    return 2;
  }

  const resolution = resolveInstance();
  if (resolution.kind === "error") return fail(`the relay DB cannot be resolved (${resolution.reason})`);
  if (!resolution.exists) return fail(`no relay DB at ${resolution.dbPath}: nothing to watch (a missing DB is never "no mail")`);

  const { openPendingDb } = await import("./cli/pending.js");
  const { pendingMetadata, pendingSchemaGap, listAgentBindings } = await import("./db.js");
  let db: import("./sqlite-compat.js").CompatDatabase;
  try {
    db = await openPendingDb(resolution.dbPath);
  } catch (err) {
    return fail(`cannot open ${resolution.dbPath} read-only (${err instanceof Error ? err.message : String(err)})`);
  }

  let logPath: string;
  let rung: Set<string>;
  try {
    const gap = pendingSchemaGap(db);
    if (gap) throw new Error(`${resolution.dbPath} ${gap}`);
    const prepared = prepareLog(stateDirFor(resolution.dbPath));
    logPath = prepared.logPath;
    if (prepared.recoveredBytes > 0) process.stderr.write(`doorbell: recovered a torn log tail (${prepared.recoveredBytes} bytes, never acted on)\n`);
    rung = readRungMemory(logPath).rung;
    appendRecord(logPath, {
      v: 1,
      type: "header",
      at: new Date().toISOString(),
      pid: process.pid,
      build: { ...LOADED_BUILD },
      install_dir: ownInstallDir(),
      resolution: serializeResolution(resolution),
    });
  } catch (err) {
    db.close();
    return fail(err instanceof Error ? err.message : String(err));
  }

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const cycle = (): void => {
    const plan = planCycle({
      bindings: listAgentBindings(db),
      ownHostId: getOwnHostId(),
      pending: (name): PendingRead => {
        const m = pendingMetadata(db, name);
        return { registered: m.registered, reading_session: m.reading_session, ids: m.messages.map((x) => x.id) };
      },
      rung,
      newIntentId: () => randomUUID(),
      now: () => new Date().toISOString(),
    });
    for (const rec of plan.intents) {
      appendRecord(logPath, rec); // write-ahead: durable before it counts as rung
      for (const id of rec.covers.message_ids) rung.add(rungKey(rec.covers.reading_session, id));
    }
  };

  let code = 0;
  try {
    while (!stopping) {
      try {
        cycle();
      } catch (err) {
        process.stderr.write(`doorbell: cycle failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (args.once) {
          code = 1;
          break;
        }
      }
      if (args.once) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, args.intervalMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    db.close();
  }
  return code;
}
