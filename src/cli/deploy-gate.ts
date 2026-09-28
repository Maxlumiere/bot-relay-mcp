// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay deploy-gate [--label L] [--port N]` — run with the NEW build BEFORE
 * restarting the daemon onto it (ADR-0048; the logic is src/deploy-gate.ts).
 * Read-only: it queries launchd, the plist, lsof and the new resolver.
 *
 * Exit: 0 = PASS · 1 = FAIL · 3 = CANNOT-VERIFY · 2 = usage error.
 */
import { runGate, formatGate, DEFAULT_LABEL, DEFAULT_PORT } from "../deploy-gate.js";

function usage(requested = false): void {
  const text =
    "Usage: relay deploy-gate [--label L] [--port N]\n\n" +
    "Run with the NEW build before restarting the daemon onto it. PASS only when the\n" +
    "new instance resolver, fed the environment the restarted daemon will get, names\n" +
    `the DB the running daemon holds open. macOS: the loaded launchd job (default\n` +
    `label ${DEFAULT_LABEL}) and its :PORT listener (default ${DEFAULT_PORT}).\n` +
    "Linux: the listener's /proc/PID/environ (a match is CANNOT-VERIFY: no service\n" +
    "manager is modelled). Only the resolver's own variables are printed\n" +
    "(`relay where --env-keys`).\n\n" +
    "Exit: 0 = PASS · 1 = FAIL · 3 = CANNOT-VERIFY · 2 = usage.\n";
  if (requested) process.stdout.write(text);
  else process.stderr.write(text);
}

export async function run(argv: string[]): Promise<number> {
  let label = DEFAULT_LABEL;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      usage(true);
      return 0;
    }
    if (a === "--label" && argv[i + 1]) label = argv[++i];
    else if (a === "--port" && /^\d+$/.test(argv[i + 1] ?? "")) port = Number(argv[++i]);
    else {
      process.stderr.write(`relay deploy-gate: bad argument: ${a}\n\n`);
      usage();
      return 2;
    }
  }
  const out = formatGate(runGate({ label, port }));
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  return out.exit;
}
