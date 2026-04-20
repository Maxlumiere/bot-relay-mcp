// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Linux spawn driver (v1.9).
 *
 * Fallback chain (per agent spawn):
 *   1. gnome-terminal  — GNOME default, Ubuntu/Fedora desktop
 *   2. konsole         — KDE default
 *   3. xterm           — universal fallback when a GUI is available
 *   4. tmux            — headless-server fallback (detached session)
 *
 * RELAY_TERMINAL_APP may force a specific sub-driver. If the forced driver's
 * binary is not on PATH, the dispatcher treats it as "driver unavailable"
 * and walks the chain (with a stderr warning recorded in validation.ts).
 *
 * ALL emulator invocations funnel through `bash -lc '<command>'` so that
 * users' shell init (PATH additions, nvm, pyenv, etc.) is available to the
 * spawned claude process. That bash -lc is the ONLY shell involvement in
 * the Linux driver — command-line construction is done in JS array form,
 * so there is no shell interpolation of the agent identity.
 */
import type { SpawnAgentInput } from "../../types.js";
import type { SpawnCommand, SpawnDriver, DriverContext } from "../types.js";
import {
  buildChildEnv,
  normalizeCwd,
  escapeSingleQuotesPosix,
  tmuxSessionSuffix,
} from "../validation.js";
import { log } from "../../logger.js";

const LINUX_SUB_DRIVERS = ["gnome-terminal", "konsole", "xterm", "tmux"] as const;
type LinuxSubDriver = (typeof LINUX_SUB_DRIVERS)[number];

/**
 * Pick the first available sub-driver, honoring terminalOverride when set.
 * Returns null if nothing is available.
 */
function pickSubDriver(ctx: DriverContext): LinuxSubDriver | null {
  if (ctx.terminalOverride && (LINUX_SUB_DRIVERS as readonly string[]).includes(ctx.terminalOverride)) {
    // Override specified AND it's a known Linux sub-driver.
    if (ctx.hasBinary(ctx.terminalOverride)) {
      return ctx.terminalOverride as LinuxSubDriver;
    }
    // Override name is known but binary is missing — fall through the chain.
  }
  for (const sub of LINUX_SUB_DRIVERS) {
    if (ctx.hasBinary(sub)) return sub;
  }
  return null;
}

/**
 * Assemble the claude launcher command in a shell-safe string form.
 * The agent name/role/caps are propagated via env (NOT interpolated into the
 * command string), matching the principle-of-least-injection rule.
 *
 * v1.9.1 defense-in-depth: even though zod blocks `'` in cwd today, we
 * escape it using the standard POSIX idiom (close quote, escaped literal,
 * reopen quote). If a future feature ever relaxes the zod cwd rule, the
 * tmux / gnome-terminal / konsole / xterm paths stay safe. Mirrors the
 * printf %q pattern used by bin/spawn-agent.sh.
 */
function buildLaunchCommand(cwd: string): string {
  const safeCwd = escapeSingleQuotesPosix(cwd);
  return `cd '${safeCwd}' && exec claude`;
}

export const linuxDriver: SpawnDriver = {
  name: "linux",
  platform: "linux",

  canHandle(ctx: DriverContext): boolean {
    return pickSubDriver(ctx) !== null;
  },

  buildCommand(input: SpawnAgentInput, ctx: DriverContext, token?: string): SpawnCommand {
    const sub = pickSubDriver(ctx);
    if (!sub) {
      // Dispatcher should have called canHandle first; this path is defensive.
      throw new Error(
        "Linux spawn: no terminal emulator found. Install one of: gnome-terminal, konsole, xterm, tmux. Or set RELAY_TERMINAL_APP."
      );
    }

    const cwd = normalizeCwd(input.cwd || process.env.HOME || "/", "linux");
    const launch = buildLaunchCommand(cwd);
    // v2.1 Phase 4j: token flows into the child via process env — Linux
    // terminals (gnome-terminal, konsole, xterm, tmux) spawn bash as a child
    // process whose inherited env comes straight from child_process.spawn's
    // env field, so adding RELAY_AGENT_TOKEN here reaches the target claude.
    const env = buildChildEnv(input.name, input.role, input.capabilities, "linux", process.env, token);

    let exec: string;
    let args: string[];

    switch (sub) {
      case "gnome-terminal":
        // gnome-terminal -- bash -lc "cd '...' && exec claude"
        exec = "gnome-terminal";
        args = ["--", "bash", "-lc", launch];
        break;
      case "konsole":
        // konsole -e bash -lc "..."
        exec = "konsole";
        args = ["-e", "bash", "-lc", launch];
        break;
      case "xterm":
        // xterm -e bash -lc "..."
        exec = "xterm";
        args = ["-e", "bash", "-lc", launch];
        break;
      case "tmux": {
        // v1.9.1: append a 4-hex random suffix to the tmux session name to
        // prevent silent collision when two agents share the same relay name.
        // The agent's registered relay identity stays "<name>"; only the tmux
        // session binding is "<name>-<4hex>". Logged to stderr so operators
        // know what to `tmux attach -t`.
        const sessionName = `${input.name}-${tmuxSessionSuffix()}`;
        log.info(`[spawn] tmux session "${sessionName}" launched for agent "${input.name}". Attach with: tmux attach -t ${sessionName}`);
        exec = "tmux";
        args = ["new-session", "-d", "-s", sessionName, `bash -lc "${launch.replace(/"/g, '\\"')}"`];
        break;
      }
    }

    return {
      exec,
      args,
      env,
      detached: true,
      platform: "linux",
      driverName: sub,
    };
  },
};
