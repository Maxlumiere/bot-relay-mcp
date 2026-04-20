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
import { buildChildEnv, normalizeCwd, isValidTokenShape } from "../validation.js";

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

  buildCommand(input: SpawnAgentInput, _ctx: DriverContext, token?: string): SpawnCommand {
    const capsStr = input.capabilities.join(",");
    const cwd = normalizeCwd(input.cwd || process.env.HOME || "/", "darwin");
    // v2.1 Phase 4j: only pass the token through the CLI-arg channel when its
    // shape is valid. The shell script re-validates, but dropping bad tokens
    // here keeps the argv clean + the script's CLI signature stable.
    const args = [input.name, input.role, capsStr, cwd];
    if (isValidTokenShape(token)) args.push(token);
    return {
      exec: SPAWN_SCRIPT,
      args,
      env: buildChildEnv(input.name, input.role, input.capabilities, "darwin", process.env, token),
      detached: true,
      platform: "darwin",
      driverName: "macos",
    };
  },
};
