// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The desktop tripwire's harms, run NESTED by tests/desktop-tripwire.test.ts (never in the main run: *.fixture.ts).
 * Every HARM must FAIL (afterEach fails on the recorded violation even when the test swallowed the throw) and must
 * actuate NOTHING. The controls must pass. Order matters: the controls run first, before a harm unsets the dry run.
 */
import { it, expect } from "vitest";
import cp from "node:child_process";

const { focusTerminal } = await import("../../../src/focus/dispatcher.js");

it("control focus-dry-run: the harness default builds the command and runs nothing", async () => {
  const r = await focusTerminal("tw-control-window");
  expect(r.raised).toBe(false);
});

it("control powershell-acl: a plain PowerShell ACL call is not refused", () => {
  cp.spawnSync("powershell", ["-NoProfile", "-Command", "Get-Acl . | Out-Null"], { timeout: 20_000 });
});

it("control bash-echo: a non-actuating child runs", () => {
  expect(cp.spawnSync("bash", ["-c", "echo hi"]).status).toBe(0);
});

it("HARM focus-real: RELAY_FOCUS_DRY_RUN unset → the real focus path reaches its actuator → refused", async () => {
  delete process.env.RELAY_FOCUS_DRY_RUN;
  await focusTerminal("tw-harm-window").catch(() => undefined); // swallowed: afterEach still fails it
});

it("HARM focus-not-1: RELAY_FOCUS_DRY_RUN=true is not a dry run (only \"1\") → refused", async () => {
  process.env.RELAY_FOCUS_DRY_RUN = "true";
  await focusTerminal("tw-harm-window").catch(() => undefined);
});

it("HARM spawnSync-osascript: refused before it starts, even when the throw is swallowed", () => {
  try {
    cp.spawnSync("osascript", ["-e", "beep"]);
  } catch {
    /* swallowed */
  }
});

it("HARM exec-open: a shell string with `open` in command position → refused", () => {
  try {
    cp.execSync("open -a Calculator");
  } catch {
    /* swallowed */
  }
});

it("HARM spawn-xdg-open: the async spawn → refused", () => {
  try {
    cp.spawn("xdg-open", ["https://example.invalid"]);
  } catch {
    /* swallowed */
  }
});

it("HARM powershell-appactivate: PowerShell WITH AppActivate / WScript.Shell → refused", () => {
  try {
    cp.spawnSync("powershell", ["-Command", "(New-Object -ComObject WScript.Shell).AppActivate('tw')"]);
  } catch {
    /* swallowed */
  }
});

it("HARM bash-child-by-name: a bash child calling osascript BY NAME → the stand-in refuses it (exit 96) and records it", () => {
  const r = cp.spawnSync("bash", ["-c", "osascript -e 'beep'"]);
  expect(r.status, String(r.stderr)).toBe(96);
});
