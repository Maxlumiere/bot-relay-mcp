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

/** The VS Code configuration scope an effective setting value currently lives
 *  at. v0.2.3 R1 (codex): Switch Agent must write `agentName` to the scope
 *  that's actually effective — a Workspace (or WorkspaceFolder) override
 *  silently shadows a Global write, leaving the live re-subscribe on the OLD
 *  agent while the toast claims success. Given
 *  `vscode.WorkspaceConfiguration.inspect(key)`'s result, return the narrowest
 *  scope that already holds a value (so writing there changes the effective
 *  value); default to Global when nothing is set yet. Pure for unit testing. */
export type ConfigScope = "workspaceFolder" | "workspace" | "global";
export function effectiveScope(
  inspected: { workspaceFolderValue?: unknown; workspaceValue?: unknown } | undefined,
): ConfigScope {
  if (inspected?.workspaceFolderValue !== undefined) return "workspaceFolder";
  if (inspected?.workspaceValue !== undefined) return "workspace";
  return "global";
}
