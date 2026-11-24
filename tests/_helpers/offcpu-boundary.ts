// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE FAILURE BOUNDARY around the off-CPU watch (Codex #453 R2): its WHOLE lifecycle (the import, the start, the stop
 * and the report) can never change a bar. Any failure prints one "offcpu: unavailable (<reason>)" line, and the bar's
 * own result, or its own exception, comes out EXACTLY as the bar produced it (a reporting throw can never replace it).
 * The watch module is loaded only when RELAY_TIMING_OFFCPU=1; `load` and `log` are seams for the rows.
 */
type WatchModule = typeof import("./offcpu-watch.js");

export async function withOffCpuWatch<T>(
  label: string,
  bar: () => Promise<T>,
  deps: { env?: NodeJS.ProcessEnv; load?: () => Promise<WatchModule>; log?: (line: string) => void } = {},
): Promise<T> {
  const env = deps.env ?? process.env;
  if (env.RELAY_TIMING_OFFCPU !== "1") return bar();
  // ASSUMED NOT TO THROW: `log` is called inside the catches below (console.log does not throw). A logger that can throw
  // must be wrapped before it is passed here, or its throw would escape the boundary.
  const log = deps.log ?? ((line: string) => console.log(line));
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let mod: WatchModule | null = null;
  let watch: ReturnType<WatchModule["startOffCpuWatch"]> = null;
  try {
    mod = await (deps.load ?? (() => import("./offcpu-watch.js")))();
    watch = mod.startOffCpuWatch({ env });
  } catch (err) {
    log(`offcpu: unavailable (${why(err)})`);
    mod = null;
    watch = null;
  }
  let result: T | undefined;
  let failed = false;
  let error: unknown;
  try {
    result = await bar();
  } catch (err) {
    failed = true;
    error = err;
  }
  if (mod !== null && watch !== null) {
    try {
      for (const line of mod.offCpuLines(label, watch, await watch.stop())) log(line);
    } catch (err) {
      log(`offcpu: unavailable (${why(err)})`);
    }
  }
  if (failed) throw error;
  return result as T;
}
