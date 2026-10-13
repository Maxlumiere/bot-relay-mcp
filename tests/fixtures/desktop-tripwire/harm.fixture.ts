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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

it("control env-wrapper: a wrapper starting a non-actuator runs", () => {
  expect(cp.spawnSync("env", ["FOO=1", "node", "-e", "0"]).status).toBe(0);
});

it("control command-v: a shell -c line with no actuator runs", () => {
  expect(cp.spawnSync("bash", ["-c", "command -v ls >/dev/null"]).status).toBe(0);
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
  // A SCRIPT FILE: a -c line is refused in the worker before launch (HARM bash-c-command-p); this one reaches the child.
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-child-")), "by-name.sh");
  fs.writeFileSync(script, "osascript -e 'beep'\n");
  const r = cp.spawnSync("bash", [script]);
  expect(r.status, String(r.stderr)).toBe(96);
});

// Codex #333 R1 P1: a wrapper or a shell's default path reaches the real program past the stand-ins. Harmless here: the
// env case resolves to the outer test's RECORDING stand-in (TW_RECORDERS), and xdotool is a name that is not installed.
it("HARM env-path: env PATH=… osascript replaces the decorated PATH → refused before launch", () => {
  try {
    cp.spawnSync("env", [`PATH=${process.env.TW_RECORDERS}`, "osascript", "-e", "beep"]);
  } catch {
    /* swallowed */
  }
});

it("HARM command-p-shell: `command -p` (the shell's DEFAULT path) with shell:true → refused before launch", () => {
  try {
    cp.spawnSync("command -p xdotool --version", { shell: true });
  } catch {
    /* swallowed */
  }
});

it("HARM bash-c-command-p: bash -c 'command -p …' → refused before launch", () => {
  try {
    cp.spawnSync("bash", ["-c", "command -p xdotool --version"]);
  } catch {
    /* swallowed */
  }
});

// Codex #333 R1 P2: a restricted PATH (no mktemp) and a swallowed exit used to leave NO record: the run went green.
// A SCRIPT FILE (not -c: the worker parses a -c line and would refuse it before launch), so the call reaches the stand-in.
it("HARM restricted-path-swallowed: PATH = the stand-ins only, `|| true` swallows the refusal → still recorded, still failed", () => {
  const shimDir = (process.env.PATH ?? "").split(":")[0]!;
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-p2-")), "swallow.sh");
  fs.writeFileSync(script, "osascript -e beep || true\n");
  const r = cp.spawnSync("/bin/bash", [script], { env: { ...process.env, PATH: shimDir } });
  expect(r.status, "the refusal was swallowed by the script").toBe(0);
});
