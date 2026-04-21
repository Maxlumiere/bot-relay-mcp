// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures (MIT)

/**
 * v2.2.0 — focus-driver validation helpers.
 *
 * Title strings reach platform shells (osascript, wmctrl, PowerShell). Even
 * though the Zod boundary (src/types.ts TERMINAL_TITLE_REF_PATTERN) already
 * rejects shell metacharacters, the defense-in-depth rule from spawn-agent
 * land holds: quote-escape before interpolation. If a future schema
 * relaxation ever lets a `'` or `"` through, the driver still does the right
 * thing without opening an injection vector.
 *
 * Mirrors the patterns in src/spawn/validation.ts.
 */

/** POSIX single-quote-safe escape: `'` → `'\''`. */
export function escapeSingleQuotesPosix(raw: string): string {
  return raw.replace(/'/g, "'\\''");
}

/** PowerShell single-quote escape: `'` → `''`. */
export function escapeSingleQuotesPowershell(raw: string): string {
  return raw.replace(/'/g, "''");
}

/** AppleScript double-quote + backslash escape. Same rule as bin/spawn-agent.sh. */
export function escapeAppleScript(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
