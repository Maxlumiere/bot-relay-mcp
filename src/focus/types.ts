// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 — dashboard click-to-focus driver types.
 *
 * The dashboard POSTs to /api/focus-terminal with an agent name. The HTTP
 * handler looks up the agent's `terminal_title_ref`, then delegates to the
 * platform focus driver to raise the matching OS window.
 *
 * Parity with the spawn driver pattern (src/spawn/types.ts): one dispatcher,
 * one driver per platform, shared validation helpers. Each driver returns
 * a FocusResult describing what it attempted and whether it succeeded.
 */

export type FocusPlatform = "darwin" | "linux" | "win32";

export interface FocusResult {
  raised: boolean;
  platform: FocusPlatform;
  title: string;
  /** Human-readable reason populated on `raised: false`. Stable for incident replay. */
  reason?: string;
  /** The driver sub-name (e.g. `osascript-iterm2`, `wmctrl`, `appactivate`) for diagnostics. */
  driver_name?: string;
}

export interface FocusCommand {
  exec: string;
  args: string[];
  /** The child's env. Inherited by default but we pin explicit PATH for Linux + Windows so wmctrl / powershell are resolvable. */
  env?: Record<string, string>;
}

export interface FocusDriverContext {
  /** Returns true when `binary` is on the current PATH. Mocked in tests. */
  hasBinary(binary: string): boolean;
  /** Injects a platform override for testing; in production this matches process.platform. */
  platform: FocusPlatform;
}

export interface FocusDriver {
  name: string;
  platform: FocusPlatform;
  /**
   * Returns true when the driver's required external tools are available on
   * this host (e.g. `wmctrl` on Linux). Dispatcher uses this to decide whether
   * to attempt the raise or return a graceful-degrade FocusResult.
   */
  canHandle(ctx: FocusDriverContext): boolean;
  /**
   * Construct the command that will raise the window with the given title.
   * Pure function — no side effects. The dispatcher is the only layer that
   * actually shells out.
   */
  buildCommand(title: string, ctx: FocusDriverContext): FocusCommand;
}
