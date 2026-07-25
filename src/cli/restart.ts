// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay restart` (audit HIGH #3) — bounce the local launchd daemon so a
 * freshly-installed package version takes effect.
 *
 * OPERATOR-INVOKED ONLY. `relay init` deliberately never restarts a running
 * daemon on its own: the daemon is the process every agent on this host depends
 * on, and an automatic bounce mid-session would cut the whole fleet. init
 * detects a stale daemon and prints the remedy; THIS command is that remedy,
 * run by a human who chose the moment (ADR-0005: report drift, let a human act).
 *
 * The target-selection is the pure chooseRestartTarget(); this module only
 * shells out to launchctl once the target is decided.
 */
import fs from "fs";
import { execFileSync } from "child_process";
import { CANONICAL_LABEL, plistPathFor, parseLoadedRelayLabels, chooseRestartTarget } from "./launchd.js";
import { VERSION } from "../version.js";

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: relay restart\n\n" +
        "Restart the local bot-relay launchd daemon so a newly-installed package\n" +
        "version takes effect. Operator-invoked only — `relay init` never bounces a\n" +
        "running daemon automatically (every agent on this host depends on it).\n",
    );
    return 0;
  }

  if (process.platform !== "darwin") {
    // Stream discipline: this is an error path, so guidance goes to stderr.
    process.stderr.write(
      "relay restart: the launchd supervisor is macOS-only.\n" +
        "On Linux/Windows the relay HTTP daemon runs unsupervised — stop the existing\n" +
        "`node dist/index.js` process and start it again to apply an upgrade.\n",
    );
    return 1;
  }

  const uid = process.getuid?.() ?? 0;
  let loadedRelayLabels: string[] = [];
  try {
    loadedRelayLabels = parseLoadedRelayLabels(
      execFileSync("launchctl", ["list"], { encoding: "utf-8" }),
    );
  } catch {
    /* launchctl unavailable → treat as nothing loaded */
  }

  const plistPath = plistPathFor(CANONICAL_LABEL);
  const target = chooseRestartTarget({
    loadedRelayLabels,
    canonicalPlistExists: fs.existsSync(plistPath),
  });

  if (!target.label) {
    process.stderr.write(`relay restart: ${target.reason}\n`);
    return 1;
  }

  // If the canonical plist exists but isn't loaded yet, bootstrap before kick.
  if (target.needsBootstrap) {
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" });
    } catch {
      /* may already be bootstrapped; kickstart below still applies */
    }
  }

  try {
    // kickstart -k: kill the running instance and restart it under KeepAlive,
    // so it re-execs the (now-updated) dist the plist points at.
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${target.label}`], { stdio: "ignore" });
  } catch (err) {
    process.stderr.write(
      `relay restart: launchctl kickstart failed for ${target.label}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(`✓ restarted ${target.label} — the daemon now serves bot-relay-mcp ${VERSION}.\n`);
  return 0;
}
