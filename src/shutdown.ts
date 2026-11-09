// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE ONE SHUTDOWN (#423 Codex R2 P2-3). Every way a relay process ends goes through it: SIGINT, SIGTERM and SIGHUP,
 * a stdio client closing stdin (EOF), an HTTP listener that cannot bind, an uncaught exception, a failed start.
 * - Idempotent: the first call runs it; any later call (a signal during an EOF shutdown) joins it and changes nothing.
 * - Ordered: the parts register their own steps by phase, and they run in phase order:
 *   UNREGISTER (the stdio session's auto-unregister) → IN_FLIGHT (requests already received get their replies) →
 *   LISTENERS (the HTTP and owner listeners close) → DB (closeDb) → DRAIN (stdout and stderr are flushed, so a reply
 *   being written is delivered whole) → exit with the code.
 * - Bounded: a hard deadline ends the process with the code even if a step hangs (named on stderr).
 * Each step logs one "[shutdown] ..." line (stderr), so the order is observable; a failed step is logged and the next
 * one still runs.
 */
import { log } from "./logger.js";

export const SHUTDOWN_PHASE = { UNREGISTER: 10, IN_FLIGHT: 20, LISTENERS: 30, DB: 40, DRAIN: 50 } as const;
export type ShutdownPhase = (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE];
/** What triggered the shutdown: a signal name, "EOF", "listen-failure", "uncaught-exception" or "startup-failure". */
export interface ShutdownContext {
  reason: string;
  code: number;
}
type Step = { phase: ShutdownPhase; name: string; run: (ctx: ShutdownContext) => void | Promise<void> };

const steps: Step[] = [];
let running: Promise<never> | null = null;
/** The default hard deadline for the whole shutdown; RELAY_SHUTDOWN_DEADLINE_MS may only SHORTEN it. */
const DEFAULT_DEADLINE_MS = 10_000;

/** Register a step. `name` is the "[shutdown] <name>" line printed once it has run. */
export function onShutdown(phase: ShutdownPhase, name: string, run: Step["run"]): void {
  steps.push({ phase, name, run });
}

/** Has the shutdown started? (a part that would otherwise start new work can check it) */
export const shuttingDown = (): boolean => running !== null;

function deadlineMs(): number {
  const v = Number(process.env.RELAY_SHUTDOWN_DEADLINE_MS);
  return Number.isInteger(v) && v > 0 && v < DEFAULT_DEADLINE_MS ? v : DEFAULT_DEADLINE_MS;
}

/** Wait (bounded) until a writable has flushed what it holds. */
export function drained(stream: NodeJS.WriteStream | NodeJS.WritableStream, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const w = stream as NodeJS.WriteStream & { writableLength?: number; writableNeedDrain?: boolean };
    if (!w.writableLength) {
      // an empty write's callback runs after everything queued before it has been handed to the OS
      try {
        w.write("", () => resolve());
      } catch {
        resolve();
      }
      return;
    }
    const t = setTimeout(resolve, ms);
    t.unref();
    w.once("drain", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * End the process: run every registered step in phase order, then exit with `code`. Returns a promise that never
 * resolves (the process exits); a second call returns the first one's.
 */
export function shutdown(code: number, reason: string): Promise<never> {
  if (running) return running;
  const ctx: ShutdownContext = { reason, code };
  running = (async (): Promise<never> => {
    const hard = setTimeout(() => {
      process.stderr.write(`[bot-relay] [shutdown] did not finish within ${deadlineMs()}ms (${reason}): exiting ${code}.\n`);
      process.exit(code);
    }, deadlineMs());
    hard.unref();
    log.info(`[shutdown] begins (${reason}): exit ${code} when done`);
    for (const step of [...steps].sort((a, b) => a.phase - b.phase)) {
      try {
        await step.run(ctx);
        log.info(`[shutdown] ${step.name}`);
      } catch (err) {
        log.warn(`[shutdown] ${step.name}: FAILED (${err instanceof Error ? err.message : String(err)}); continuing`);
      }
    }
    await drained(process.stdout, 2_000);
    await drained(process.stderr, 1_000);
    process.exit(code);
  })();
  return running;
}

/** TEST ONLY: forget the registered steps and the running state. */
export function _resetShutdownForTests(): void {
  steps.length = 0;
  running = null;
}
