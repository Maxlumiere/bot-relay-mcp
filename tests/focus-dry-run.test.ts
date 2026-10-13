// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * RELAY_FOCUS_DRY_RUN and the desktop tripwire's pure parts.
 *
 * THE DEFECT (MEASURED on main ba5b97a): the dashboard focus tests called the REAL focusTerminal, which on macOS runs
 * `osascript … tell application "iTerm2" / activate`: every test run raised the terminal app on the machine running
 * it (two calls per run of the focus files). There was no way to build the focus command without running it.
 *
 * THE RULE: RELAY_FOCUS_DRY_RUN=1 (exactly "1") builds the command and runs nothing; the result is
 * { raised: false, dry_run: true, command, reason: "dry run…" }, HTTP 409, and the dashboard says "dry run, not
 * focused": a dry run never reads as a focus success. The test harness sets it for every worker and child, and refuses
 * desktop-actuating programs outright (tests/desktop-tripwire.test.ts runs the harms in a nested run).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import type { Server as HttpServer } from "http";
import { OPERATOR_SECRET, operatorPost } from "./_helpers/operator-auth.js";
import { decorateChildEnv, desktopActuator, desktopActuatorInShell, tripwireView } from "./_setup/operator-tripwire.js";

// What the HARNESS gave this file, read before any test or hook here can change it (an afterEach that set it would make
// the harness-default assertion below pass vacuously: seen under mutant M4).
const DRY_RUN_AT_LOAD = process.env.RELAY_FOCUS_DRY_RUN;
const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-focus-dry-run-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_HTTP_SECRET;

const { registerAgent, closeDb } = await import("../src/db.js");
const { focusTerminal, isFocusDryRun, resolveDriver, buildContext } = await import("../src/focus/dispatcher.js");
const { startHttpServer } = await import("../src/transport/http.js");
const { renderDashboard } = await import("../src/dashboard.js");

beforeEach(() => {
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});
afterEach(() => {
  // Back to what the harness gave this file, whatever a test did.
  if (DRY_RUN_AT_LOAD === undefined) delete process.env.RELAY_FOCUS_DRY_RUN;
  else process.env.RELAY_FOCUS_DRY_RUN = DRY_RUN_AT_LOAD;
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_DASHBOARD_SECRET;
});

describe("RELAY_FOCUS_DRY_RUN: only the exact value \"1\" enables it", () => {
  it.each([["1", true], ["true", false], ["yes", false], ["", false], ["0", false], [" 1", false], ["1 ", false], [undefined, false]])(
    "RELAY_FOCUS_DRY_RUN=%j → dry run %s",
    (value, expected) => {
      expect(isFocusDryRun({ RELAY_FOCUS_DRY_RUN: value })).toBe(expected);
    },
  );
});

describe("a focus dry run builds the command, runs nothing, and never reads as a success", () => {
  it("focusTerminal under the harness default: raised false, dry_run true, the driver's exact command, a 'dry run' reason", async () => {
    expect(DRY_RUN_AT_LOAD, "the harness sets it for every test file, before the file loads").toBe("1");
    const driver = resolveDriver();
    if (!driver) return; // an unsupported platform never reaches a command
    const ctx = buildContext(driver.platform);
    const result = await focusTerminal("tw-dry-window");
    expect(result.raised).toBe(false);
    if (!driver.canHandle(ctx)) {
      // No focus tool on this host (e.g. Linux without wmctrl): degraded before any command is built.
      expect(result.dry_run).toBeUndefined();
      return;
    }
    const built = driver.buildCommand("tw-dry-window", ctx);
    expect(result).toMatchObject({ dry_run: true, driver_name: driver.name, command: { exec: built.exec, args: built.args } });
    expect(result.reason).toMatch(/^dry run \(RELAY_FOCUS_DRY_RUN=1\)/);
  });

  it("POST /api/focus-terminal in a dry run → 409 with dry_run:true (never the 200 of a real raise)", async () => {
    process.env.RELAY_DASHBOARD_SECRET = OPERATOR_SECRET;
    const server: HttpServer = startHttpServer(0, "127.0.0.1");
    try {
      await new Promise((r) => setTimeout(r, 60));
      const port = (server.address() as { port: number }).port;
      registerAgent("dry-target", "r", [], { terminal_title_ref: "dry-target-window" });
      const r = await operatorPost(port, "/api/focus-terminal", { agent_name: "dry-target" });
      const data = JSON.parse(r.body) as { raised: boolean; dry_run?: boolean; reason?: string };
      expect(r.status).toBe(409);
      expect(data.raised).toBe(false);
      if (resolveDriver()?.canHandle(buildContext(resolveDriver()!.platform))) {
        expect(data.dry_run).toBe(true);
        expect(data.reason).toMatch(/dry run/);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("the dashboard's own label function (run from the served page) says 'dry run, not focused' for a dry run", () => {
    let html = "";
    renderDashboard({} as never, { setHeader: () => undefined, send: (b: string) => (html = b) } as never);
    const m = html.match(/function focusResultLabel\(data\) \{\n\s*(return [^\n]+)\n\s*\}/);
    expect(m, "the page defines focusResultLabel").not.toBeNull();
    const focusResultLabel = new Function("data", m![1]!) as (d: Record<string, unknown>) => string;
    expect(focusResultLabel({ raised: false, dry_run: true, platform: "darwin" })).toBe("dry run, not focused");
    expect(focusResultLabel({ raised: true, dry_run: true, platform: "darwin" }), "dry_run wins over everything").toBe("dry run, not focused");
    expect(focusResultLabel({ raised: true, platform: "darwin" })).toBe("raised darwin");
    expect(focusResultLabel({ raised: false })).toBe("raise failed");
    expect(html, "the click handler uses it").toMatch(/label\.textContent = focusResultLabel\(data\);/);
  });
});

describe("the harness: dry run by default in every child; the refusing stand-ins first on PATH", () => {
  it("a child env with no RELAY_FOCUS_DRY_RUN gets \"1\"; one that names it keeps the test's value (deliberate)", () => {
    expect(decorateChildEnv({ PATH: "/usr/bin:/bin" }).RELAY_FOCUS_DRY_RUN).toBe("1");
    expect(decorateChildEnv({ PATH: "/usr/bin:/bin", RELAY_FOCUS_DRY_RUN: "0" }).RELAY_FOCUS_DRY_RUN).toBe("0");
  });

  it.skipIf(process.platform === "win32")("a child's PATH starts with the stand-in directory, which holds one refusing script per actuator", () => {
    const p = decorateChildEnv({ PATH: "/usr/bin:/bin" }).PATH!;
    const shimDir = p.split(path.delimiter)[0]!;
    expect(shimDir).toBe(path.join(tripwireView().runDir, "desktop-shims"));
    expect(p.split(path.delimiter).slice(1)).toEqual(["/usr/bin", "/bin"]);
    for (const name of ["osascript", "open", "xdg-open", "wmctrl", "xdotool"]) {
      expect(fs.statSync(path.join(shimDir, name)).mode & 0o111, `${name} is executable`).not.toBe(0);
    }
    expect(decorateChildEnv({ PATH: p }).PATH, "never prepended twice").toBe(p);
  });
});

describe("the desktop-actuator predicates (pure)", () => {
  it.each([
    ["osascript", [], "osascript"],
    ["/usr/bin/osascript", ["-e", "beep"], "osascript"],
    ["OPEN", ["-a", "Calculator"], "open"],
    ["xdg-open", ["https://example.invalid"], "xdg-open"],
    ["wmctrl", ["-a", "t"], "wmctrl"],
    ["xdotool", ["key", "a"], "xdotool"],
    ["powershell.exe", ["-Command", "(New-Object -ComObject WScript.Shell).AppActivate('t')"], "powershell (WScript.Shell)"],
    ["pwsh", ["-c", "$w.AppActivate('t')"], "pwsh (AppActivate)"],
  ])("HARM %s %j → refused as %s", (program, args, expected) => {
    expect(desktopActuator(program, args)).toBe(expected);
  });

  it.each([
    ["powershell.exe", ["-NoProfile", "-Command", "icacls 'C:\\x' /inheritance:r /grant:r \"$env:USERNAME:(F)\""]],
    ["powershell", ["-NoProfile", "-Command", "Get-Acl C:\\x | Format-List"]],
    ["node", ["-e", "1"]],
    ["bash", ["-c", "echo open"]],
    ["curl", ["--version"]],
    ["opener", []],
  ])("TWIN %s %j → not an actuator (plain PowerShell ACL calls stay allowed)", (program, args) => {
    expect(desktopActuator(program, args)).toBeNull();
  });

  it.each([
    ["osascript -e 'beep'", "osascript"],
    ["FOO=1 open -a Calculator", "open"],
    ["echo hi && wmctrl -a t", "wmctrl"],
    ["bash -c \"osascript -e 'beep'\"", "osascript"],
    ["sudo xdotool key a", "xdotool"],
    ["powershell -c (New-Object -ComObject WScript.Shell).AppActivate('t')", "powershell (WScript.Shell)"],
  ])("HARM shell %j → refused as %s", (cmd, expected) => {
    expect(desktopActuatorInShell(cmd)).toBe(expected);
  });

  it.each([["ls; cat file"], ["node -e \"fs.openSync('x')\""], ["powershell -NoProfile -Command Get-Acl ."], ["git log --oneline"]])(
    "TWIN shell %j → not an actuator",
    (cmd) => {
      expect(desktopActuatorInShell(cmd)).toBeNull();
    },
  );

  it("TWIN (Q2), through the REAL wrapped spawnSync: a plain PowerShell ACL call is NOT refused", () => {
    // Not installed on macOS/Linux (ENOENT, a normal spawn error) and real on Windows: either way the tripwire must not
    // throw, and must record nothing (this test's afterEach would fail on a record).
    const r = cp.spawnSync("powershell", ["-NoProfile", "-Command", "Get-Acl . | Out-Null"], { timeout: 20_000 });
    expect(r.error === undefined || (r.error as NodeJS.ErrnoException).code === "ENOENT", String(r.error)).toBe(true);
  });
});
