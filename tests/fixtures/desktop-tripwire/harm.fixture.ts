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

/** Run `/bin/bash <script>` ASYNC and resolve its exit code: a sync spawn would throw at the tripwire's report first, so
 * an exit-status assertion after it never ran (Codex #333 R2 NEW-5). */
const runScript = (body: string, env?: NodeJS.ProcessEnv, args: string[] = []) => {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-script-")), "s.sh");
  fs.writeFileSync(script, body);
  return new Promise<number | null>((resolve) => cp.spawn("/bin/bash", [script, ...args], env ? { env } : {}).on("close", resolve));
};

// A SCRIPT FILE (not -c: the worker parses a -c line and would refuse it before launch), so the call reaches the stand-in.
it("HARM bash-child-by-name: a bash child calling osascript BY NAME → the stand-in refuses it (exit 96) and records it", async () => {
  expect(await runScript("osascript -e 'beep'\n"), "the stand-in's own exit").toBe(96);
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
it("HARM restricted-path-swallowed: PATH = the stand-ins only, `|| true` swallows the refusal → still recorded, still failed", async () => {
  const shimDir = (process.env.PATH ?? "").split(":")[0]!;
  expect(await runScript("osascript -e beep || true\n", { ...process.env, PATH: shimDir }), "the refusal was swallowed by the script").toBe(0);
});

// Ruled 13 Oct (Codex #333 R2 NEW-1/2): each cheap close. Harmless on a tree WITHOUT them: the PATH resets point at the
// outer test's RECORDING stand-ins (TW_RECORDERS), and xdotool is not installed.
it("HARM env-S: env -S \"PATH=… osascript\" (the split string) → refused before launch", () => {
  try {
    cp.spawnSync("env", ["-S", `PATH=${process.env.TW_RECORDERS} osascript -e beep`]);
  } catch {
    /* swallowed */
  }
});

it("HARM input-fed: a shell fed `PATH=…; osascript` on its stdin → refused before launch", () => {
  try {
    cp.spawnSync("bash", [], { input: `PATH=${process.env.TW_RECORDERS}\nosascript -e beep\n` });
  } catch {
    /* swallowed */
  }
});

it("HARM eval: bash -c '…; eval osascript' → refused before launch", () => {
  try {
    cp.spawnSync("bash", ["-c", `PATH="${process.env.TW_RECORDERS}"; eval osascript -e beep`]);
  } catch {
    /* swallowed */
  }
});

it("HARM if-command-p: `if command -p …` (command -p anywhere in a command) → refused before launch", () => {
  try {
    cp.spawnSync("bash", ["-c", "if command -p xdotool --version; then :; fi"]);
  } catch {
    /* swallowed */
  }
});

// Codex #333 R2 NEW-4: a refusal's throw marks only ITS record; an earlier child's record is still reported at the next
// sync spawn (A: a child refused by name, recorded; B: a direct refusal, thrown; C: a harmless sync spawn reports A).
it("HARM ab-sequence: A (a child's record) is still reported at the next sync spawn after B (a direct refusal)", async () => {
  expect(await runScript("osascript -e 'beep'\n"), "A: the child's refusal").toBe(96);
  try {
    cp.spawnSync("osascript", ["-e", "beep"]);
  } catch {
    /* B: swallowed */
  }
  let reported = "";
  try {
    cp.spawnSync(process.execPath, ["-e", "0"]);
  } catch (err) {
    reported = String(err);
  }
  expect(reported, "C: the next sync spawn reports A").toMatch(/refused osascript by name/);
});

// Codex #333 R2 NEW-3: honest calls that the earlier every-later-word rule refused. Each must RUN.
it("control env-grep: env LC_ALL=C grep osascript <file> (grep reads a word)", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-legit-")), "f.txt");
  fs.writeFileSync(f, "osascript\n");
  expect(cp.spawnSync("env", ["LC_ALL=C", "grep", "-c", "osascript", f], { encoding: "utf-8" }).stdout.trim()).toBe("1");
});

it("control env-node: env node -e 0 /tmp/open (an argument named open)", () => {
  expect(cp.spawnSync("env", ["node", "-e", "0", "/tmp/open"]).status).toBe(0);
});

it("control command-v-lookup: command -v osascript is a lookup, not a run", () => {
  expect(cp.spawnSync("bash", ["-c", "command -v osascript >/dev/null; true"]).status).toBe(0);
});

it("control quoted-args: grep \"osascript\" and echo \"open it\" (quoted arguments are data)", () => {
  expect(cp.spawnSync("bash", ["-c", 'echo "open it" | grep -c "osascript"; true']).status).toBe(0);
});

// Codex #333 R2 NEW-5: a grandchild with a STRIPPED env (no RELAY_TEST_TRIPWIRE_DIR) still records, in the run's
// fallback dir: this test PASSES (its worker never sees the record), and the RUN fails at teardown on it.
it("FALLBACK stripped-env: a grandchild with env -i still records (via the fallback), and its exit is the stand-in's", async () => {
  const shimDir = (process.env.PATH ?? "").split(":")[0]!;
  expect(await runScript('env -i PATH="$1" /bin/sh -c "osascript -e beep; echo \\$? > /dev/null"\nexit 0\n', undefined, [shimDir])).toBe(0);
});
