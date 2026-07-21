// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * macOS spawn driver (v1.9).
 *
 * Shells out to bin/spawn-agent.sh — preserves the full v1.6.x hardening
 * suite (osascript escaping, 19+ adversarial payload tests in
 * tests/spawn-integration.test.ts). Do NOT reimplement in TS; the shell
 * script is the proven path.
 */
import path from "path";
import { fileURLToPath } from "url";
import type { SpawnAgentInput } from "../../types.js";
import type { SpawnCommand, SpawnDriver, DriverContext } from "../types.js";
import { buildChildEnv, normalizeCwd } from "../validation.js";
import { getAgentCliProfile } from "../../agent-cli-profiles.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/spawn/drivers/macos.js → dist/spawn/drivers → dist/spawn → dist → project root
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const SPAWN_SCRIPT = path.join(PROJECT_ROOT, "bin", "spawn-agent.sh");

export const macosDriver: SpawnDriver = {
  name: "macos",
  platform: "darwin",

  canHandle(_ctx: DriverContext): boolean {
    // On darwin the shell script always runs — it has its own fallback chain
    // (iTerm2 → Terminal.app) and will error if neither is available.
    return true;
  },

  buildCommand(
    input: SpawnAgentInput,
    _ctx: DriverContext,
    briefFilePath?: string
  ): SpawnCommand {
    const capsStr = input.capabilities.join(",");
    const cwd = normalizeCwd(input.cwd || process.env.HOME || "/", "darwin");
    // v2.6.1: token CLI arg removed. Identity now flows through the file
    // vault at <instanceDir>/agents/<name>.token (written by handleSpawnAgent
    // before driver dispatch); the SessionStart hook reads it on first turn.
    // bin/spawn-agent.sh dropped its 5th-arg-token slot in v2.6.1; brief
    // moved from arg 6 to arg 5.
    const args = [input.name, input.role, capsStr, cwd];
    const hasBrief = typeof briefFilePath === "string" && briefFilePath.length > 0;
    if (hasBrief) args.push(briefFilePath as string);

    const env = buildChildEnv(input.name, input.role, input.capabilities, "darwin", process.env);

    // v2.17.0 (P2): resolve the launch strategy from the profile registry — no
    // per-CLI branch. `binary` → spawn-agent.sh runs `claude` (unchanged,
    // byte-identical). `launcher` → spawn-agent.sh runs the repo launcher
    // (bin/codex-relay), which pre-registers the cold-start handshake then
    // execs the CLI. The launcher path is validated inside spawn-agent.sh
    // (absolute, within repo bin/, executable) before it is embedded.
    const profile = getAgentCliProfile(input.cli ?? "claude");
    if (!profile) {
      throw new Error(
        `spawn: unknown cli "${input.cli}" — no agent-CLI profile. See \`relay cli-profiles\`.`
      );
    }
    env.RELAY_SPAWN_CLI = profile.id;
    if (profile.launch.strategy === "launcher" && profile.launch.launcherScript) {
      env.RELAY_SPAWN_LAUNCHER = path.join(PROJECT_ROOT, profile.launch.launcherScript);
    }

    return {
      exec: SPAWN_SCRIPT,
      args,
      env,
      detached: true,
      platform: "darwin",
      driverName: "macos",
    };
  },
};
