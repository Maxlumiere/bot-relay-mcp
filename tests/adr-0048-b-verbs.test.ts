// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR B — every CLI verb that resolves a relay DB goes through the ONE
 * strict resolver and, on a resolver error, EXITS NON-ZERO WITH A MESSAGE naming
 * the cause: never a stack trace, never an answer from the flat DB.
 *
 * Error states, reproduced WITHOUT root or injection so the table is portable:
 *   - ambiguous : instances/ holds an instance, no marker selects one;
 *   - empty     : the active-instance marker is an empty file;
 *   - eacces    : instances/ at mode 000 (skipped when running as root, where 000
 *                 does not deny; the skip is explicit, never silent).
 * `relay watch` is every agent's wake path: it emits a DEGRADED line (the watch
 * Monitor greps for it) and exits non-zero. `relay list-instances` is the tool
 * that FIXES the ambiguous state, so it still lists (exit 0) and names the fault.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048b-")));
const HOME = path.join(ROOT, "home");
const RH = path.join(HOME, ".bot-relay");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

type State = "ambiguous" | "empty" | "eacces";
const REASON: Record<State, RegExp> = {
  ambiguous: /ambiguous/,
  empty: /active-instance is empty/,
  eacces: /EACCES|permission denied/i,
};

function setState(s: State): void {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(RH, "instances", "work"), { recursive: true });
  if (s === "empty") fs.writeFileSync(path.join(RH, "active-instance"), "");
  if (s === "eacces") fs.chmodSync(path.join(RH, "instances"), 0o000);
}
afterEach(() => {
  try {
    fs.chmodSync(path.join(RH, "instances"), 0o755);
  } catch {
    /* not present */
  }
});

// `relay bind` resolves its window anchor BEFORE the DB. Pin the anchor so every
// environment reaches the resolver: the agent process this test runs under, when
// there is one (CLAUDE_PID must AGREE with the ancestry walk), else this test's
// own live pid. Unpinned, the row passed only where an agent was an ancestor.
const { detectAgentProcess } = await import("../src/liveness.js");
const ANCHOR_PID = String(detectAgentProcess()?.pid ?? process.pid);

const PAYLOAD = JSON.stringify({ session_id: "11111111-2222-3333-4444-555555555555", hook_event_name: "SessionStart", cwd: "/tmp", source: "startup" });

/** Every verb that resolves a relay DB. [label, argv, stdin]. */
const VERBS: Array<[string, string[], string]> = [
  ["send", ["send", "b", "hi", "--from", "a"], ""],
  ["resolve", ["resolve", "m1", "--agent", "a"], ""],
  ["watch", ["watch", "a", "--once"], ""],
  ["backup", ["backup"], ""],
  ["recover", ["recover", "a"], ""],
  ["bind", ["bind"], PAYLOAD],
  ["fleet", ["fleet"], ""],
  ["pending", ["pending", "a", "--json"], ""],
  ["where", ["where"], ""],
  ["release-binding", ["release-binding", "a"], ""],
  ["mint-token", ["mint-token", "a"], ""],
  ["purge-history", ["purge-history", "a", "--yes"], ""],
  ["purge-agents", ["purge-agents", "--yes"], ""],
  ["re-encrypt", ["re-encrypt"], ""],
  ["doctor", ["doctor"], ""],
  ["init", ["init", "--yes", "--skip-daemon", "--skip-hooks"], ""],
];

function relay(argv: string[], stdin: string) {
  const r = spawnSync("node", [RELAY_BIN, ...argv], {
    encoding: "utf-8",
    timeout: 30_000,
    input: stdin,
    env: { PATH: process.env.PATH ?? "", HOME, RELAY_HTTP_PORT: "1", RELAY_AGENT_NAME: "a", CLAUDE_PID: ANCHOR_PID },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

for (const state of ["ambiguous", "empty", "eacces"] as State[]) {
  describe.skipIf(state === "eacces" && IS_ROOT)(`ADR-0048 PR B — a resolver error (${state}): every verb exits non-zero WITH A MESSAGE`, () => {
    beforeEach(() => setState(state));
    for (const [label, argv, stdin] of VERBS) {
      it(`relay ${label}`, () => {
        const r = relay(argv, stdin);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out, "precondition: the verb got past its window anchor to the resolver").not.toMatch(/window anchor/);
        expect(r.out, "the message names the resolver's cause").toMatch(REASON[state]);
        expect(r.out, "never a stack trace").not.toMatch(/\n\s+at [^\n]+:\d+:\d+/);
        if (label === "watch") expect(r.out, "watch is the wake path: it says DEGRADED").toMatch(/DEGRADED/);
      });
    }
  });
}

describe("ADR-0048 PR B — `relay list-instances` still LISTS in the ambiguous state (it is how you fix it)", () => {
  beforeEach(() => {
    setState("ambiguous");
    fs.writeFileSync(
      path.join(RH, "instances", "work", "instance.json"),
      JSON.stringify({ instance_id: "work", created_at: "2026-09-28T00:00:00Z", hostname: "h", daemon_version_first_seen: "x", label: null }),
    );
  });
  it("text: exit 0, the instance listed, the fault named, the fix named", () => {
    const r = relay(["list-instances"], "");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("work");
    expect(r.out).toMatch(/ambiguous/);
    expect(r.out).toMatch(/relay use-instance/);
  });
  it("--json: exit 0, active_instance_id null, the resolution error carried", () => {
    const r = relay(["list-instances", "--json"], "");
    expect(r.status, r.out).toBe(0);
    const j = JSON.parse(r.out.slice(0, r.out.lastIndexOf("}") + 1));
    expect(j.active_instance_id).toBeNull();
    expect(j.resolution_error).toMatch(/ambiguous/);
    expect(j.instances.map((m: { instance_id: string }) => m.instance_id)).toEqual(["work"]);
  });
});
