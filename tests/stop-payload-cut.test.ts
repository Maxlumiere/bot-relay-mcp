// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The Stop hook NAMES its payload-read cut, exactly as PostToolUse does ("hook stdin not complete within its time
 * budget: …"). A writer that dribbles and never closes ends Stop's read loop at its deadline; that cut used to be
 * SILENT (the verdict fell back to "hook did not reach a conclusion"). The read loop's deadline is real time, so a
 * writer that never closes ALWAYS reaches it; a fixed clock of 1 s spent keeps the read's share at 1 s.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { budgetTree } from "./_helpers/hook-budget-tree.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "stop-cut-"));
const HOOKS = budgetTree(path.join(ROOT, "tree"), path.join(REPO, "hooks"), path.join(REPO, "bin"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const WIN = process.platform === "win32";

async function dribble(hook: string, env: Record<string, string>): Promise<{ out: string; secs: number }> {
  const home = fs.mkdtempSync(path.join(ROOT, "home-"));
  const child = spawn("bash", [path.join(HOOKS, hook)], {
    env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_AGENT_NAME: "cut-bob", RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(home, "wc.json"), ...env },
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d));
  child.stderr.on("data", (d: Buffer) => (out += d));
  child.stdin.on("error", () => {});
  const t0 = Date.now();
  const drip = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write('{"session_id":"s1"}\n'); }, 300);
  const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await new Promise((res) => child.on("close", res));
  clearInterval(drip);
  clearTimeout(killer);
  return { out, secs: (Date.now() - t0) / 1000 };
}

describe.skipIf(WIN)("Stop names its payload-read cut", () => {
  it("a writer that dribbles and never closes → VERDICT=CANNOT-JUDGE 'hook stdin not complete within its time budget: …', inside the budget", async () => {
    const r = await dribble("stop-check.sh", { RELAY_TEST_CLOCK: "1" });
    expect(r.out).toMatch(/VERDICT=CANNOT-JUDGE reason="hook stdin not complete within its time budget: stop check skipped \(mail left pending\)"/);
    expect(r.out).not.toMatch(/hook did not reach a conclusion/);
    expect(r.secs, r.out).toBeLessThan(5);
  }, 30_000);
  it("the CONTROL: a payload that arrives whole and closes is never called incomplete", async () => {
    const home = fs.mkdtempSync(path.join(ROOT, "home-"));
    const child = spawn("bash", [path.join(HOOKS, "stop-check.sh")], {
      env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_AGENT_NAME: "cut-bob", RELAY_HTTP_PORT: "1", RELAY_TEST_CLOCK: "0", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(home, "wc.json") },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.stdin.end(JSON.stringify({ session_id: "s1", stop_hook_active: false }));
    await new Promise((res) => child.on("close", res));
    expect(out).not.toMatch(/hook stdin not complete within its time budget/);
  }, 30_000);
});
