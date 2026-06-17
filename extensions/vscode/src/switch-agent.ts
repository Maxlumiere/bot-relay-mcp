// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 (B) — Switch Agent command: pure helper.
//
// The command itself (QuickPick + showInputBox + config write) lives in
// extension.ts because it needs the vscode API. This module is the pure,
// VSCode-free part: turn a `discover_agents` tool result into the candidate
// name list for the QuickPick. Kept separate so it's unit-testable without a
// VSCode test host (same pattern as terminal-targeting.ts / catch-up-wake.ts).

/**
 * Extract candidate agent names from a parsed `discover_agents` tool result.
 *
 * Tolerant of either surfaced shape — `{ agents: [{ name, ... }] }` or a bare
 * array — and of stray non-string / empty entries, so a relay-shape tweak
 * can't crash the picker. De-duplicates and (optionally) drops the currently
 * subscribed agent so "switch" never offers the agent you're already on.
 */
export function parseAgentNames(raw: unknown, exclude?: string): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { agents?: unknown }).agents)) {
    list = (raw as { agents: unknown[] }).agents;
  }
  const names = list
    .map((entry) =>
      entry && typeof entry === "object"
        ? (entry as { name?: unknown }).name
        : entry,
    )
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  const deduped = Array.from(new Set(names));
  return exclude ? deduped.filter((n) => n !== exclude) : deduped;
}

// v0.2.3 R2 (codex) — Switch Agent operates at GLOBAL + WORKSPACE scope only.
// "Which inbox this editor watches" is not a per-file/per-folder concept, and
// an unscoped `getConfiguration("bot-relay.tether")` cannot safely do a
// resource-scoped WorkspaceFolder update/readback anyway (it throws — see
// @types/vscode WorkspaceConfiguration.update). A folder-level override is
// therefore NOT something Switch Agent writes; it must be surfaced honestly,
// never silently shadowed behind a success toast.

export interface InspectedSetting {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
}

export type SwitchScopeDecision =
  | { kind: "write"; target: "workspace" | "global" }
  | { kind: "folder-override" };

/** Decide where (or whether) Switch Agent may write, given inspect()'s result.
 *  A folder-level override short-circuits to an honest warning; otherwise write
 *  to Workspace when a workspace value already exists, else Global. Pure. */
export function decideSwitchScope(inspected: InspectedSetting | undefined): SwitchScopeDecision {
  if (inspected?.workspaceFolderValue !== undefined) return { kind: "folder-override" };
  if (inspected?.workspaceValue !== undefined) return { kind: "write", target: "workspace" };
  return { kind: "write", target: "global" };
}

/** VSCode-free port over the bits of WorkspaceConfiguration + UI that
 *  applyAgentSwitch touches — so the obtain→write→readback→toast flow is
 *  unit-testable for real (not just decideSwitchScope's logic). */
export interface AgentSwitchPort {
  inspect: () => InspectedSetting | undefined;
  update: (target: "workspace" | "global", value: string) => Promise<void>;
  /** The EFFECTIVE agentName after the write (highest-precedence wins). */
  readEffective: () => string | undefined;
  info: (message: string) => void;
  warn: (message: string) => void;
}

export type AgentSwitchOutcome = "switched" | "folder-override" | "shadowed";

/**
 * Perform the agent switch honestly: pick the writable scope, write there, read
 * the EFFECTIVE value back, and only claim success if it actually moved to
 * `picked`. A folder-level override is surfaced as a warning (we don't write a
 * folder scope from an unscoped config). Returns the outcome for tests.
 */
export async function applyAgentSwitch(
  picked: string,
  port: AgentSwitchPort,
): Promise<AgentSwitchOutcome> {
  const decision = decideSwitchScope(port.inspect());
  if (decision.kind === "folder-override") {
    port.warn(
      `Tether: a folder-level "agentName" override is set; Switch Agent operates at workspace/global scope. Clear the folder override (or change it manually) to switch to "${picked}".`,
    );
    return "folder-override";
  }
  await port.update(decision.target, picked);
  const effective = port.readEffective();
  if (effective === picked) {
    port.info(`Tether: switched to agent "${picked}".`);
    return "switched";
  }
  port.warn(
    `Tether: could not switch to "${picked}" — effective agentName is "${effective ?? ""}" (a higher-precedence setting is overriding it).`,
  );
  return "shadowed";
}
