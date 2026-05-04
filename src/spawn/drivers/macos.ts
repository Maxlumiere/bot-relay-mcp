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
    return {
      exec: SPAWN_SCRIPT,
      args,
      env: buildChildEnv(input.name, input.role, input.capabilities, "darwin", process.env),
      detached: true,
      platform: "darwin",
      driverName: "macos",
    };
  },
};
