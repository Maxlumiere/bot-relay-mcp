// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { sendMessage, getAgentAuthData, registerAgent, unregisterAgent, markAgentOffline, markEstablished } from "../db.js";
import { fireWebhooks } from "../webhooks.js";
import { log } from "../logger.js";
import type { SpawnAgentInput } from "../types.js";
import { spawnAgent } from "../spawn/dispatcher.js";
import { validateBriefPath } from "../spawn/validation.js";
import { defaultTokenStore } from "../token-store.js";
import { ERROR_CODES } from "../error-codes.js";

/**
 * v2.1 Phase 4j: pre-register the child agent PARENT-SIDE and persist the
 * plaintext token via the FileTokenStore vault so the spawned terminal's
 * SessionStart hook can resolve identity from disk. Removes the operator-
 * paste step that violated `feedback_spawn_must_carry_token`.
 *
 * v2.6.1: token no longer flows through the env-var spawn-arg channel — it
 * flows through the per-instance file vault at `<instanceDir>/agents/<name>
 * .token`. The hook reads the vault first; on miss it falls back to
 * `register_agent` + capture + write. Eliminates the "spawn-agent.sh
 * directly without pre-mint" failure mode (3-min broken state) hit
 * 2026-05-04 during a builder spawn.
 *
 * Rollback: if the platform driver fails to launch, unregister the agent
 * row AND delete the vault entry so we don't leak a registered-but-not-
 * running phantom or a stale vault file blocking the next spawn.
 *
 * Name-collision: refuses cleanly if an agent with the requested name already
 * exists. Re-spawning on top would either silently rotate caps or force a
 * legacy-migration path we don't want to conflate with new-agent creation —
 * operator must unregister the existing one first.
 */
export async function handleSpawnAgent(input: SpawnAgentInput) {
  // v2.1.4 (I10): validate brief_file_path BEFORE any side effect. Zod has
  // already done the regex/char check; this adds the filesystem-side
  // invariants (exists, readable, size cap) that can't live in the schema.
  // Validation failure returns a structured VALIDATION error and stops here
  // — no pre-register, no driver dispatch.
  let validatedBriefPath: string | undefined;
  if (typeof input.brief_file_path === "string" && input.brief_file_path.length > 0) {
    try {
      validatedBriefPath = validateBriefPath(input.brief_file_path).path;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: msg,
                error_code: ERROR_CODES.VALIDATION,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

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

  // v2.6.1: persist the plaintext token to the per-instance file vault so
  // the spawned terminal's SessionStart hook resolves identity from disk
  // without an env-var passthrough. Vault writes are atomic (tmp + rename)
  // so concurrent spawns never observe a half-written file. If the write
  // fails, treat it as a spawn failure and roll back — silently dropping
  // the token would leave the row registered without a way for the child
  // to authenticate.
  if (plaintextToken) {
    try {
      await defaultTokenStore().write(input.name, plaintextToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        if (registeredSessionId) {
          unregisterAgent(input.name, registeredSessionId);
        } else {
          unregisterAgent(input.name);
        }
      } catch (rollbackErr) {
        log.warn(`[spawn] rollback after vault-write failure for "${input.name}":`, rollbackErr);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: `Token vault write failed for spawn_agent: ${msg}`,
                error_code: ERROR_CODES.INTERNAL,
                rolled_back: true,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  // v1.9: dispatch to the platform-appropriate driver. macOS still shells
  // out to bin/spawn-agent.sh (preserving v1.6.x hardening). Linux and
  // Windows use native TS drivers.
  // v2.6.1: the token no longer flows through the dispatcher — it lives in
  // the vault file. Drivers take undefined for the legacy `token` slot.
  // v2.1.4 (I10): validatedBriefPath flows through (macOS only today).
  const result = spawnAgent(
    input,
    undefined,
    undefined,
    process.platform,
    validatedBriefPath
  );

  if (!result.ok) {
    // v2.1 Phase 4j (3/3): rollback the pre-register — don't leak phantoms.
    // v2.6.1: ALSO scrub the vault entry so a future spawn can succeed
    // cleanly without operator intervention.
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
    try {
      await defaultTokenStore().delete(input.name);
    } catch (vaultErr) {
      log.warn(`[spawn] rollback vault delete failed for "${input.name}":`, vaultErr);
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

  // ADR-0005 (codex #115 path #7): spawn provisioning IS establishment. The driver
  // launched AND the child's usable token is committed to the vault — a delivered
  // credential to a process we LAUNCHED, a stronger commitment than a bare
  // register. Stamp established_at HERE (provisioning success) — crucially BEFORE
  // the markAgentOffline below nulls the session — so the orphan-GC can never reap
  // the child while its (slow) startup hasn't made its first MCP call yet. Silence
  // is startup, not abandonment: else we delete children we ourselves just spawned.
  markEstablished(input.name);

  // v2.14.1 — NOW that the driver launched successfully, clear the just-minted
  // session so the pre-registered row is OFFLINE/reserved. Done AFTER the driver
  // (not before) so the driver-failure + vault-failure rollbacks above can still
  // find the live session for their session-scoped unregister. The child process
  // doesn't exist yet — the parent is not its live session. Offline means the
  // child's own SessionStart hook re-registers freely (the name-collision guard
  // only fires on an actively-held row), capturing its live PID handshake
  // (host_shell_pids + agent_pid); the presence derivation resets offline→idle so it comes up
  // idle+alive. The token stays valid and mail still delivers to an offline row.
  if (registeredSessionId) {
    try {
      markAgentOffline(input.name, registeredSessionId);
    } catch (err) {
      log.warn("[spawn] Failed to mark the pre-registered row offline (child may hit a name-collision on its first register):", err);
    }
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
              ? "Parent-issued agent_token has been written to the per-instance file vault (v2.6.1). The spawned terminal's SessionStart hook resolves identity from disk on first turn — no operator paste required. Shown once; the server stores only a bcrypt hash."
              : null,
            note: `Spawning agent "${input.name}" (role: ${input.role}) via ${result.driverName} on ${result.platform}. Pre-registered parent-side with token passthrough.`,
            has_initial_message: !!input.initial_message,
            brief_file_path: validatedBriefPath ?? null,
          },
          null,
          2
        ),
      },
    ],
  };
}
