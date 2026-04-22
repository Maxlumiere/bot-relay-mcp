// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 C1 — `relay open` subcommand.
 *
 * Tests cover `pickDriver` platform routing (no process spawned — we
 * just validate the driver selection matrix) plus the --help + --url
 * argument parsing. Actual browser launch is exercised only on the
 * operator's machine; the test process must not spawn `open` /
 * `xdg-open` / `cmd.exe /c start`.
 *
 * C1.1  pickDriver('darwin')  → open <url>
 * C1.2  pickDriver('linux')   → xdg-open <url> (or $BROWSER when set)
 * C1.3  pickDriver('win32')   → cmd.exe /c start "" <url>
 * C1.4  --url rejects invalid URLs.
 * C1.5  --help returns 0 + prints usage.
 */
import { describe, it, expect } from "vitest";

const { pickDriver, run: runOpen } = await import("../src/cli/open.js");

describe("v2.2.2 C1 — relay open driver selection", () => {
  it("(C1.1) darwin → open <url>", () => {
    const d = pickDriver("darwin", "http://127.0.0.1:3777/");
    expect(d.command).toBe("open");
    expect(d.args).toEqual(["http://127.0.0.1:3777/"]);
  });

  it("(C1.2) linux defaults to xdg-open", () => {
    const d = pickDriver("linux", "http://127.0.0.1:3777/", {});
    expect(d.command).toBe("xdg-open");
    expect(d.args).toEqual(["http://127.0.0.1:3777/"]);
  });

  it("(C1.2b) linux honors $BROWSER when set", () => {
    const d = pickDriver("linux", "http://127.0.0.1:3777/", { BROWSER: "firefox" });
    expect(d.command).toBe("firefox");
    expect(d.args).toEqual(["http://127.0.0.1:3777/"]);
  });

  it("(C1.3) win32 → cmd.exe /c start \"\" <url>", () => {
    const d = pickDriver("win32", "http://127.0.0.1:3777/");
    expect(d.command).toBe("cmd.exe");
    expect(d.args).toEqual(["/c", "start", "", "http://127.0.0.1:3777/"]);
  });

  it("(C1.4) --url rejects an invalid URL and exits non-zero", async () => {
    const code = await runOpen(["--url", "not a url"]);
    expect(code).not.toBe(0);
  });

  it("(C1.5) --help returns 0", async () => {
    const code = await runOpen(["--help"]);
    expect(code).toBe(0);
  });
});
