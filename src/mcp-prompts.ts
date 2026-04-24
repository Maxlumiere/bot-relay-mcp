// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part F.1 — MCP prompts.
 *
 * Pre-baked instruction templates for routine operator flows.
 * Exposed via MCP `prompts/list` + `prompts/get`. NOT new tools —
 * the tool count stays 30.
 *
 * Per `memory/project_federation_design.md` v2.2 roadmap:
 * "convert routine operator flows (recover lost token, invite worker,
 *  rotate compromised agent) into executable MCP prompts so advanced
 *  tools stop being first-class on the surface."
 *
 * Each prompt returns a single user-role message containing the
 * assembled instructions. The operator's MCP client (Claude Code,
 * Cursor, etc.) shows these in a prompts menu; selecting one pastes
 * the rendered text into the chat as the user's prompt.
 */

export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
  /**
   * v2.4.0 Codex MED patch — per-argument validation regex. Rejected
   * at `getPrompt()` boundary if the supplied value doesn't match.
   * Prevents prompt-injection via raw interpolation of operator-
   * supplied strings into markdown + JSON blocks (Codex repro:
   * `agent_name='victim"\n\`\`\`json\n{"pwned":true}\n\`\`\`\n...'`
   * broke the rendered prompt).
   *
   * Leave undefined only for free-text arguments that are safe to
   * surface verbatim (e.g. the `brief` body, which the operator
   * intends to be prose).
   */
  validate?: RegExp;
}

/**
 * v2.4.0 Codex MED patch — the canonical agent-name charset.
 * Mirrors RegisterAgentSchema's implicit validation (alphanumeric +
 * dash/underscore/dot, 1-64 chars) so prompt arguments can't slip
 * characters that the MCP tool layer already rejects.
 */
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Role charset — wider (letters/digits/dash/underscore/slash/space), 1-64 chars. */
const ROLE_RE = /^[A-Za-z0-9._/ -]{1,64}$/;

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
  render: (args: Record<string, string>) => string;
}

/**
 * Render a canonical recover-lost-token flow for a specific agent.
 * Keeps the surface tiny: the client hands the rendered text back to
 * the operator who then acts on it (or feeds it to their LLM).
 */
const RECOVER_LOST_TOKEN: McpPromptDefinition = {
  name: "recover-lost-token",
  description:
    "Walks the operator through the `relay recover` CLI flow for an agent whose RELAY_AGENT_TOKEN was lost. Filesystem-gated — the operator's access to the DB path IS the authority.",
  arguments: [
    {
      name: "agent_name",
      description: "The agent name whose token was lost",
      required: true,
      validate: AGENT_NAME_RE,
    },
  ],
  render: (args) => {
    const agent = args.agent_name ?? "<agent>";
    return (
      "Recover the lost `agent_token` for bot-relay agent **" + agent + "**:\n\n" +
      "1. Stop the agent's process so `register_agent` below doesn't collide with a live session.\n" +
      "2. Run `relay recover " + agent + " --dry-run` to preview what will be cleared.\n" +
      "3. If the dry-run looks right, run `relay recover " + agent + " --yes` to clear the agent row + capabilities. Messages + tasks are preserved.\n" +
      "4. Start a fresh terminal (or whatever the agent runs in). On startup it calls `register_agent` again with the original RELAY_AGENT_NAME and gets a NEW token.\n" +
      "5. Save the new token into the new terminal's RELAY_AGENT_TOKEN env var (or the agent's equivalent config).\n" +
      "6. Confirm via `discover_agents` that " + agent + " is online with a fresh session_id.\n\n" +
      "If step 3's dry-run shows unexpected rows or the agent is currently online + protected by a `force`-required re-register, pause + check `relay list-instances` in case you're on the wrong instance. See docs/multi-instance.md."
    );
  },
};

/**
 * Pre-registered recipe for spawning a sub-agent + getting them
 * onboarded. Uses the MCP `spawn_agent` tool under the hood.
 */
const INVITE_WORKER: McpPromptDefinition = {
  name: "invite-worker",
  description:
    "Walks the operator through spawning a sub-agent, getting them registered, and handing off a brief. macOS-only spawn (see spawn_agent docs); on Linux/Windows, the operator starts the new terminal manually.",
  arguments: [
    {
      name: "agent_name",
      description: "Name for the new sub-agent (alphanumeric + dash)",
      required: true,
      validate: AGENT_NAME_RE,
    },
    {
      name: "role",
      description: "Agent role (builder / reviewer / researcher / …)",
      required: true,
      validate: ROLE_RE,
    },
    {
      name: "brief",
      description: "First-message brief the sub-agent sees on arrival",
      required: false,
      // No validate — `brief` is prose body. Escaped via JSON.stringify
      // at render time (see below).
    },
  ],
  render: (args) => {
    const agent = args.agent_name ?? "<agent>";
    const role = args.role ?? "<role>";
    const brief = args.brief ?? "<brief content>";
    // v2.4.0 Codex MED — agent/role pre-validated by the arg regex.
    // `brief` is free-text prose; escape it via JSON.stringify so
    // embedded quotes/backticks/newlines can't break out of the
    // JSON block or the enclosing markdown fence. Agent + role still
    // substitute into the JSON body (safe because of the allowlist).
    const escapedBrief = JSON.stringify(brief);
    return (
      "Invite a worker agent named **" + agent + "** with role **" + role + "**:\n\n" +
      "1. Call `spawn_agent` (macOS only — on Linux/Windows, open a new terminal manually + set env vars):\n" +
      "   ```json\n" +
      "   {\n" +
      "     \"agent_name\": " + JSON.stringify(agent) + ",\n" +
      "     \"role\": " + JSON.stringify(role) + ",\n" +
      "     \"initial_message\": " + escapedBrief + "\n" +
      "   }\n" +
      "   ```\n" +
      "2. The new terminal's SessionStart hook auto-registers " + agent + " + polls for the initial message.\n" +
      "3. Confirm via `discover_agents({role: " + JSON.stringify(role) + "})` that " + agent + " is online.\n" +
      "4. Send follow-up work via `send_message(to: " + JSON.stringify(agent) + ", content: ...)` or `post_task`.\n\n" +
      "If this is the first time you're seeing the new terminal stall, check docs/hooks.md for SessionStart wiring."
    );
  },
};

/**
 * Recipe for the tokens-leaked scenario: revoke + re-register +
 * confirm.
 */
const ROTATE_COMPROMISED_AGENT: McpPromptDefinition = {
  name: "rotate-compromised-agent",
  description:
    "Walks the operator through rotating an agent whose `agent_token` has leaked. Revokes the old token, issues a recovery_token for one-shot reclaim, and registers the agent fresh.",
  arguments: [
    {
      name: "agent_name",
      description: "Compromised agent whose token must be rotated",
      required: true,
      validate: AGENT_NAME_RE,
    },
    {
      name: "revoker_name",
      description: "Your own agent name (must hold admin capability)",
      required: true,
      validate: AGENT_NAME_RE,
    },
  ],
  render: (args) => {
    const agent = args.agent_name ?? "<compromised>";
    const revoker = args.revoker_name ?? "<you>";
    return (
      "Rotate the compromised agent **" + agent + "** (revoker: " + revoker + "):\n\n" +
      "1. As " + revoker + ", call `revoke_token` with `issue_recovery: true`:\n" +
      "   ```json\n" +
      "   {\n" +
      "     \"target_agent_name\": \"" + agent + "\",\n" +
      "     \"revoker_name\": \"" + revoker + "\",\n" +
      "     \"issue_recovery\": true\n" +
      "   }\n" +
      "   ```\n" +
      "2. The response returns a one-shot `recovery_token`. Hand it to the operator of " + agent + " OUT-OF-BAND (Signal, Slack DM, not via the relay itself).\n" +
      "3. " + agent + "'s operator stops the old terminal (which now fails AUTH on any tool call).\n" +
      "4. In a fresh terminal, " + agent + " calls `register_agent` with the `recovery_token` they received:\n" +
      "   ```json\n" +
      "   {\n" +
      "     \"name\": \"" + agent + "\",\n" +
      "     \"role\": \"<role>\",\n" +
      "     \"capabilities\": [],\n" +
      "     \"recovery_token\": \"<one-shot from step 2>\"\n" +
      "   }\n" +
      "   ```\n" +
      "5. The relay transitions " + agent + " recovery_pending → active + returns a fresh `agent_token`. Save into RELAY_AGENT_TOKEN.\n" +
      "6. Old token + old recovery_token are now both rejected. Confirm via a `health_check` call from " + agent + "'s new terminal.\n\n" +
      "If step 1 fails with CAP_DENIED, you (the revoker) don't hold the admin capability. Use `expand_capabilities` as a holder of admin first, or ask an existing admin to rotate."
    );
  },
};

export const ALL_PROMPTS: readonly McpPromptDefinition[] = [
  RECOVER_LOST_TOKEN,
  INVITE_WORKER,
  ROTATE_COMPROMISED_AGENT,
];

export function listPrompts(): Array<{
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}> {
  return ALL_PROMPTS.map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  }));
}

export function getPrompt(
  name: string,
  args: Record<string, string> | undefined,
): { description: string; messages: Array<{ role: "user"; content: { type: "text"; text: string } }> } {
  const prompt = ALL_PROMPTS.find((p) => p.name === name);
  if (!prompt) {
    throw new Error(
      `MCP prompt "${name}" not found. Available: ${ALL_PROMPTS.map((p) => p.name).join(", ")}`,
    );
  }
  const provided = args ?? {};
  for (const arg of prompt.arguments) {
    const value = provided[arg.name];
    if (arg.required && (value === undefined || value === "")) {
      throw new Error(
        `MCP prompt "${name}" requires argument "${arg.name}" (${arg.description}).`,
      );
    }
    // v2.4.0 Codex MED — reject values that fail the arg's validation
    // regex. Prevents prompt-injection via raw interpolation into
    // markdown + JSON blocks.
    if (arg.validate && typeof value === "string" && value.length > 0 && !arg.validate.test(value)) {
      throw new Error(
        `MCP prompt "${name}" argument "${arg.name}" has an invalid value. ` +
        `Must match ${arg.validate.toString()}.`,
      );
    }
  }
  const text = prompt.render(provided);
  return {
    description: prompt.description,
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}
