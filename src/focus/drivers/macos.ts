// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures (MIT)

/**
 * v2.2.0 — macOS focus driver.
 *
 * Uses osascript to tell iTerm2 to select the first session whose name
 * matches the stored `terminal_title_ref`. If iTerm2 isn't running OR the
 * session name doesn't match anything live, the osascript invocation
 * returns a non-zero exit + stderr message; the dispatcher surfaces that
 * as `{raised: false, reason: "..."}`.
 *
 * Fallback to Terminal.app is deferred — the v2.1.x spawn chain preferred
 * iTerm2 and Maxime's machine runs iTerm2 as the primary. Terminal.app
 * focus is a v2.2.x candidate if demand surfaces.
 */
import type { FocusCommand, FocusDriver, FocusDriverContext } from "../types.js";
import { escapeAppleScript } from "../validation.js";

export const macosDriver: FocusDriver = {
  name: "osascript-iterm2",
  platform: "darwin",

  canHandle(ctx: FocusDriverContext): boolean {
    // osascript ships with every macOS install; no external deps. Still
    // ask the dispatcher so tests can inject "binary missing" scenarios.
    return ctx.hasBinary("osascript");
  },

  buildCommand(title: string, _ctx: FocusDriverContext): FocusCommand {
    const safe = escapeAppleScript(title);
    // Two-step AppleScript: activate iTerm2 to bring the app to the front,
    // then select the matching session's window. The `whose name is` filter
    // runs against each window's current tab title. If no session matches,
    // iTerm2 raises nothing and the script errors — caught + reported by
    // the dispatcher.
    const script =
      `tell application "iTerm2"\n` +
      `  activate\n` +
      `  set matched to false\n` +
      `  repeat with w in windows\n` +
      `    repeat with t in tabs of w\n` +
      `      repeat with s in sessions of t\n` +
      `        if name of s is "${safe}" then\n` +
      `          select s\n` +
      `          select t\n` +
      `          select w\n` +
      `          set matched to true\n` +
      `        end if\n` +
      `      end repeat\n` +
      `    end repeat\n` +
      `  end repeat\n` +
      `  if not matched then error "no matching session named ${safe}"\n` +
      `end tell`;
    return {
      exec: "osascript",
      args: ["-e", script],
    };
  },
};
