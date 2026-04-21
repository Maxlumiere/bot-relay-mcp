// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures (MIT)

/**
 * v2.2.0 — Linux focus driver.
 *
 * Uses `wmctrl -a "<title>"` which asks the X11/Wayland-compat window
 * manager to raise the first window whose title matches. `wmctrl` is a
 * package dependency: if it isn't installed, `canHandle` returns false and
 * the dispatcher emits a graceful-degrade `{raised: false, reason:
 * "wmctrl not installed — apt install wmctrl (Debian/Ubuntu) or dnf install
 * wmctrl (Fedora)"}` so the operator knows how to fix it without digging
 * through logs.
 *
 * Wayland caveat: wmctrl only works under X11 or XWayland. Pure Wayland
 * compositors (GNOME's Mutter in pure mode, sway) don't expose the
 * window-activation protocol wmctrl needs. Documented in docs/dashboard.md.
 */
import type { FocusCommand, FocusDriver, FocusDriverContext } from "../types.js";

export const linuxDriver: FocusDriver = {
  name: "wmctrl",
  platform: "linux",

  canHandle(ctx: FocusDriverContext): boolean {
    return ctx.hasBinary("wmctrl");
  },

  buildCommand(title: string, _ctx: FocusDriverContext): FocusCommand {
    // Pass the title as a discrete argv entry — Node's child_process.spawn
    // with shell:false hands it verbatim to wmctrl's argv[]. No shell
    // parsing involved, so no quote-escaping required. The Zod boundary
    // has already rejected anything outside [A-Za-z0-9_.- ].
    return {
      exec: "wmctrl",
      args: ["-a", title],
    };
  },
};
