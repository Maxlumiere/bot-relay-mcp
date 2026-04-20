// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { sendMessage, getAgentAuthData, registerAgent, unregisterAgent } from "../db.js";
import { fireWebhooks } from "../webhooks.js";
import { log } from "../logger.js";
import type { SpawnAgentInput } from "../types.js";
import { spawnAgent } from "../spawn/dispatcher.js";
import { ERROR_CODES } from "../error-codes.js";

/**
 * v2.1 Phase 4j: pre-register the child agent PARENT-SIDE and thread the
 * plaintext token through the spawn dispatcher so the spawned terminal lands
 * with RELAY_AGENT_TOKEN already exported in its shell. Removes the operator-
 * paste step that violated `feedback_spawn_must_carry_token`.
 *
 * Rollback: if the platform driver fails to launch, unregister the agent row
 * so we don't leak a registered-but-not-running phantom.
 *
 * Name-collision: refuses cleanly if an agent with the requested name already
 * exists. Re-spawning on top would either silently rotate caps or force a
 * legacy-migration path we don't want to conflate with new-agent creation —
 * operator must unregister the existing one first.
 */
export function handleSpawnAgent(input: SpawnAgentInput) {
  // v2.1 Phase 4j (1/3): name-collision check before any side effect.
  const existing = getAgentAuthData(input.name);
  if (existing) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Agent "${input.name}" is already registered. Unregister it first (unregister_agent), or choose a different name.`,
              error_code: ERROR_CODES.NAME_COLLISION,
              name_collision: true,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // v2.1 Phase 4j (2/3): parent-side register, capture plaintext token. If
  // the register itself throws, we haven't touched the driver yet — return
  // a clean error and exit.
  let plaintextToken: string | null = null;
  let registeredSessionId: string | null = null;
  try {
    const reg = registerAgent(input.name, input.role, input.capabilities);
    plaintextToken = reg.plaintext_token;
    registeredSessionId = reg.agent.session_id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Pre-register failed for spawn_agent: ${msg}`,
              error_code: ERROR_CODES.INTERNAL,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // If an initial message was provided, queue it AFTER pre-register so the
  // child's first-session mail-delivery hook finds both the row and the mail.
  if (input.initial_message) {
    try {
      sendMessage("system", input.name, input.initial_message, "normal");
    } catch (err) {
      // Non-fatal — we can still spawn even if message queueing fails
      log.warn("[spawn] Failed to queue initial message:", err);
    }
  }

  // v1.9: dispatch to the platform-appropriate driver. macOS still shells
  // out to bin/spawn-agent.sh (preserving v1.6.x hardening). Linux and
  // Windows use native TS drivers. v2.1 Phase 4j: token flows through.
  const result = spawnAgent(input, plaintextToken ?? undefined);

  if (!result.ok) {
    // v2.1 Phase 4j (3/3): rollback the pre-register — don't leak phantoms.
    try {
      if (registeredSessionId) {
        unregisterAgent(input.name, registeredSessionId);
      } else {
        unregisterAgent(input.name);
      }
    } catch (rollbackErr) {
      // If rollback itself fails, log but still surface the original spawn
      // error to the caller — they need to know about the root cause.
      log.warn(`[spawn] rollback unregister failed for "${input.name}":`, rollbackErr);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Failed to spawn agent: ${result.error}`,
              error_code: ERROR_CODES.INTERNAL,
              platform: result.platform,
              driver: result.driverName,
              rolled_back: true,
              hint:
                result.platform === "darwin"
                  ? "Ensure bin/spawn-agent.sh is executable and iTerm2 or Terminal.app is installed."
                  : result.platform === "linux"
                  ? "Install one of: gnome-terminal, konsole, xterm, or tmux. Or set RELAY_TERMINAL_APP."
                  : result.platform === "win32"
                  ? "Install Windows Terminal (winget install Microsoft.WindowsTerminal) or ensure powershell.exe is on PATH."
                  : "See docs/cross-platform-spawn.md for per-platform requirements.",
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  fireWebhooks("agent.spawned", "system", input.name, {});

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            name: input.name,
            role: input.role,
            capabilities: input.capabilities,
            platform: result.platform,
            driver: result.driverName,
            agent_token: plaintextToken,
            auth_note: plaintextToken
              ? "Parent-issued agent_token has been exported into the spawned child's RELAY_AGENT_TOKEN env. The spawned agent is authenticated from its first tool call. Shown once; the server stores only a bcrypt hash."
              : null,
            note: `Spawning agent "${input.name}" (role: ${input.role}) via ${result.driverName} on ${result.platform}. Pre-registered parent-side with token passthrough.`,
            has_initial_message: !!input.initial_message,
          },
          null,
          2
        ),
      },
    ],
  };
}
