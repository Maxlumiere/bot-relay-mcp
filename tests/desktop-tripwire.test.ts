// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * DESKTOP TRIPWIRE (tests/_setup/operator-tripwire.ts): no test may raise, open or type into a window on the machine
 * running it. The harms run in a NESTED vitest run (tests/fixtures/desktop-tripwire/harm.fixture.ts) under the real
 * base config, tripwire and run guard; this file asserts what that run did.
 *
 * NOTHING ACTUATES: the nested run's PATH carries a RECORDING stand-in for every actuator BEHIND the tripwire's own
 * refusing ones, so any call that got past the tripwire by name would be logged. The log must stay empty.
 * Not covered (stated in the tripwire): an actuator by ABSOLUTE path from a child, a child with no PATH, Windows children.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { nestedVitestRun } from "./_helpers/nested-vitest-run.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20
const ACTUATORS = ["osascript", "open", "xdg-open", "wmctrl", "xdotool"];

describe.skipIf(process.platform === "win32")("NESTED: every desktop harm is refused, actuates nothing, and FAILS its test even when swallowed", () => {
  let work: string;
  let log: string;
  let result: Awaited<ReturnType<typeof nestedVitestRun>>;
  beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tw-desktop-")));
    const recorders = path.join(work, "recorders");
    fs.mkdirSync(recorders);
    log = path.join(work, "actuated.log");
    fs.writeFileSync(log, "");
    for (const name of ACTUATORS) {
      fs.writeFileSync(path.join(recorders, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    }
    result = await nestedVitestRun(
      path.join(REPO, "tests", "fixtures", "desktop-tripwire", "vitest.config.ts"),
      "harm.fixture",
      { PATH: `${recorders}${path.delimiter}${process.env.PATH ?? ""}`, TMPDIR: work, TW_RECORDERS: recorders },
      work,
    );
  }, 120_000);
  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("precondition: the fixture ran (every test has a verdict) and its controls PASSED", () => {
    expect(Object.keys(result.verdicts).length, result.out.slice(-1500)).toBe(26);
    const controls = Object.entries(result.verdicts).filter(([t]) => t.startsWith("control"));
    expect(controls.length).toBe(9);
    for (const [t, v] of controls) expect(v.status, `${t}: ${v.messages}`).toBe("passed");
  });

  it("every HARM test FAILED, naming the desktop tripwire (a swallowed refusal is still failed by afterEach)", () => {
    const harms = Object.entries(result.verdicts).filter(([t]) => t.startsWith("HARM"));
    expect(harms.length).toBe(16);
    for (const [t, v] of harms) {
      expect(v.status, t).toBe("failed");
      expect(v.messages, t).toMatch(/desktop/);
      // Each harm's OWN assertions held (Codex #333 R2 NEW-5: an exit-status check after a sync spawn never ran); it
      // failed only on the tripwire's record.
      expect(v.messages, t).not.toMatch(/AssertionError/);
    }
  });

  it("each harm names WHAT was refused", () => {
    const m = (prefix: string) => Object.entries(result.verdicts).find(([t]) => t.startsWith(prefix))![1].messages;
    const focusActuator = process.platform === "darwin" ? "osascript" : "wmctrl";
    expect(m("HARM focus-real")).toMatch(new RegExp(`refused ${focusActuator}`));
    expect(m("HARM focus-not-1")).toMatch(new RegExp(`refused ${focusActuator}`));
    expect(m("HARM spawnSync-osascript")).toMatch(/child_process\.spawnSync: refused osascript/);
    expect(m("HARM exec-open")).toMatch(/child_process\.execSync: refused open/);
    expect(m("HARM spawn-xdg-open")).toMatch(/child_process\.spawn: refused xdg-open/);
    expect(m("HARM powershell-appactivate")).toMatch(/refused powershell \(WScript\.Shell\)/);
    expect(m("HARM bash-child-by-name")).toMatch(/desktop child pid=\d+ ppid=\d+: refused osascript by name/);
    expect(m("HARM env-path")).toMatch(/child_process\.spawnSync: refused osascript/);
    expect(m("HARM command-p-shell")).toMatch(/child_process\.spawnSync: refused command -p/);
    expect(m("HARM bash-c-command-p")).toMatch(/child_process\.spawnSync: refused command -p/);
    expect(m("HARM env-S")).toMatch(/child_process\.spawnSync: refused osascript/);
    expect(m("HARM input-fed")).toMatch(/child_process\.spawnSync: refused osascript/);
    expect(m("HARM eval")).toMatch(/child_process\.spawnSync: refused eval/);
    expect(m("HARM if-command-p")).toMatch(/child_process\.spawnSync: refused command -p/);
    expect(m("HARM ab-sequence")).toMatch(/refused osascript by name/);
    // P2: the refusal was RECORDED although the script swallowed it and its PATH had no mktemp.
    expect(m("HARM restricted-path-swallowed")).toMatch(/desktop child pid=\d+ ppid=\d+: refused osascript by name/);
  });

  it("NOTHING actuated: no call reached a (recording) actuator behind the tripwire", () => {
    expect(fs.readFileSync(log, "utf-8")).toBe("");
  });

  it("the run FAILED at teardown, listing the violations (catch-proof)", () => {
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/OPERATOR_TRIPWIRE: \d+ operator-tripwire violation\(s\) in this run/);
  });

  it("a grandchild with a STRIPPED env still records (via the run's fallback dir): its test passes, the RUN fails on it (NEW-5)", () => {
    expect(result.verdicts[Object.keys(result.verdicts).find((t) => t.startsWith("FALLBACK"))!]!.status).toBe("passed");
    expect(result.out).toMatch(/refused osascript by name \(a test must never raise, open or type into a window; recorded via fallback\)/);
  });
});
