// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part E.3 — `relay list-instances` CLI subcommand.
 *
 * Lists every entry under `~/.bot-relay/instances/` with metadata.
 * Prints a table showing instance_id, label, created_at,
 * daemon_version_first_seen, and a marker for the currently-active
 * instance (via `~/.bot-relay/active-instance`).
 */
import { listInstances, resolveActiveInstanceId } from "../instance.js";

function printUsage(requested = false): void {
  // STREAM DISCIPLINE: usage is diagnostic on the ERROR path, so it goes to
  // STDERR. On stdout it poisoned command substitutions — a failed
  // $(relay mint-token ... --json) captured the help text and the agent
  // launched with a garbage token that LOOKED like a value. `requested`
  // (an explicit --help) is the one case where the text IS the data.
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay list-instances [--json]\n\n" +
      "Lists every bot-relay instance on this machine with its metadata.\n" +
      "An asterisk marks the currently-active instance (set via\n" +
      "`relay use-instance <id>` or `RELAY_INSTANCE_ID`).\n\n" +
      "Options:\n" +
      "  --json   Emit machine-readable JSON instead of the text table.\n" +
      "  --help   Show this message.\n"
  );
}

export async function run(argv: string[]): Promise<number> {
  let asJson = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage(true);
      return 0;
    }
    if (arg === "--json") asJson = true;
    else {
      process.stderr.write(`relay list-instances: unknown argument "${arg}"\n\n`);
      printUsage();
      return 1;
    }
  }
  const instances = listInstances();
  // ADR-0048: the resolver may report a fault (e.g. instances but none selected).
  // This verb is how that is FIXED, so it still lists and names the fault, but a
  // fault is never a success: the exit is non-zero (1) whenever one was caught.
  let active: string | null = null;
  let resolutionError: string | null = null;
  try {
    active = resolveActiveInstanceId();
  } catch (err) {
    resolutionError = err instanceof Error ? err.message : String(err);
  }
  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          active_instance_id: active,
          ...(resolutionError ? { resolution_error: resolutionError } : {}),
          instances: instances.map((m) => ({
            ...m,
            active: m.instance_id === active,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return resolutionError ? 1 : 0;
  }
  if (instances.length === 0) {
    if (resolutionError) {
      // No instance directories, yet the resolution FAILED (for example an invalid
      // RELAY_INSTANCE_ID): the legacy flat DB is NOT what is active.
      process.stdout.write(
        `No instances registered, and instance resolution FAILED: ${resolutionError}\n` +
          "Fix the cause (unset or correct RELAY_INSTANCE_ID, or check ~/.bot-relay), then run `relay doctor`.\n",
      );
      return 1;
    }
    process.stdout.write(
      "No instances registered. Single-instance legacy mode is active.\n" +
      "Run `relay init --instance-id=<uuid>` to create a per-instance setup.\n",
    );
    return 0;
  }
  // Text table.
  const colId = 36;
  const colLabel = 16;
  const colVersion = 10;
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
  process.stdout.write(
    pad("   INSTANCE_ID", colId + 3) +
    pad("LABEL", colLabel) +
    pad("VERSION", colVersion) +
    "CREATED\n",
  );
  for (const m of instances) {
    const marker = m.instance_id === active ? " * " : "   ";
    process.stdout.write(
      marker +
      pad(m.instance_id, colId) +
      pad(m.label ?? "", colLabel) +
      pad(m.daemon_version_first_seen, colVersion) +
      m.created_at + "\n",
    );
  }
  if (resolutionError) {
    process.stdout.write(
      `\nNo instance is resolved: ${resolutionError}\n` +
        "Fix: relay use-instance <INSTANCE_ID> (or set RELAY_INSTANCE_ID).\n",
    );
    return 1;
  }
  return 0;
}
