// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures (MIT)

/**
 * v2.2.0 — Windows focus driver.
 *
 * Uses the PowerShell `WScript.Shell.AppActivate(title)` COM call. Native
 * to every Windows install since Win2000 — no extra package needed. Works
 * for Windows Terminal, PowerShell console, and legacy cmd.exe windows.
 *
 * `AppActivate` returns $true when it found AND focused the window, $false
 * otherwise. We exit 0 on true, 1 on false so the dispatcher can surface
 * the "no matching window" case as a graceful-degrade reason.
 */
import type { FocusCommand, FocusDriver, FocusDriverContext } from "../types.js";
import { escapeSingleQuotesPowershell } from "../validation.js";

export const windowsDriver: FocusDriver = {
  name: "appactivate",
  platform: "win32",

  canHandle(ctx: FocusDriverContext): boolean {
    return ctx.hasBinary("powershell.exe");
  },

  buildCommand(title: string, _ctx: FocusDriverContext): FocusCommand {
    const safe = escapeSingleQuotesPowershell(title);
    // -NoProfile keeps PowerShell startup < 200ms (skips user profile
    // script). -NonInteractive prevents prompts. -Command lets us embed
    // the whole focus script inline.
    const script =
      `$w = New-Object -ComObject WScript.Shell; ` +
      `$ok = $w.AppActivate('${safe}'); ` +
      `if ($ok) { exit 0 } else { Write-Error "no matching window titled ${safe}"; exit 1 }`;
    return {
      exec: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    };
  },
};
