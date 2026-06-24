// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2 — AgentManager unit tests.
 *
 * Uses a fake TerminalApi + manual Scheduler (no real timers) so
 * tests are deterministic and don't sleep. Tests assert the
 * exact contract, not a proxy: assertions pin
 * exact env values, exact terminal options, exact UI message text.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  AgentManager,
  buildShellCommand,
  buildSpawnEnv,
  type ManagedTerminal,
  type ManagedTerminalOptions,
  type Scheduler,
  type TerminalApi,
} from "./agent-manager.js";
import { RestartPolicy } from "./restart-policy.js";

interface FakeTerminal extends ManagedTerminal {
  readonly options: ManagedTerminalOptions;
  readonly sendTextCalls: { text: string; addNewLine?: boolean }[];
  readonly showCalls: number;
  /** Simulate a crash: caller sets exitStatus then fires onClose. */
  exitStatus: { code: number | undefined } | undefined;
  /** True once dispose() has been called. */
  disposed: boolean;
}

function makeFakeApi(): {
  api: TerminalApi;
  /** All terminals ever created, oldest first. */
  terminals: FakeTerminal[];
  /** Fire onDidCloseTerminal for a given fake. */
  fireClose: (t: FakeTerminal) => void;
  infoMessages: string[];
  warnMessages: string[];
  errorMessages: string[];
} {
  const terminals: FakeTerminal[] = [];
  const closeCbs: Array<(t: ManagedTerminal) => void> = [];
  const info: string[] = [];
  const warn: string[] = [];
  const errs: string[] = [];
  const api: TerminalApi = {
    createTerminal(opts) {
      const t: FakeTerminal = {
        options: opts,
        sendTextCalls: [],
        showCalls: 0,
        exitStatus: undefined,
        disposed: false,
        show(_preserveFocus?: boolean) {
          t.showCalls += 1;
        },
        sendText(text, addNewLine) {
          t.sendTextCalls.push({ text, addNewLine });
        },
        dispose() {
          t.disposed = true;
          // VSCode fires onDidCloseTerminal as a side effect of
          // dispose(). Mirror that here, with exitStatus=undefined
          // so listener can tell "operator-driven dispose" from
          // "crash with non-zero exit code".
          for (const cb of closeCbs) cb(t);
        },
      };
      terminals.push(t);
      return t;
    },
    onDidCloseTerminal(cb) {
      closeCbs.push(cb);
      return {
        dispose() {
          const i = closeCbs.indexOf(cb);
          if (i >= 0) closeCbs.splice(i, 1);
        },
      };
    },
    showInformationMessage(msg) {
      info.push(msg);
      return Promise.resolve(undefined);
    },
    showWarningMessage(msg) {
      warn.push(msg);
      return Promise.resolve(undefined);
    },
    showErrorMessage(msg) {
      errs.push(msg);
      return Promise.resolve(undefined);
    },
  };
  return {
    api,
    terminals,
    fireClose(t: FakeTerminal) {
      for (const cb of closeCbs) cb(t);
    },
    infoMessages: info,
    warnMessages: warn,
    errorMessages: errs,
  };
}

class ManualScheduler implements Scheduler {
  private pending: { cb: () => void; ms: number; cleared: boolean }[] = [];
  setTimeout(cb: () => void, ms: number): { clear: () => void } {
    const entry = { cb, ms, cleared: false };
    this.pending.push(entry);
    return {
      clear: () => {
        entry.cleared = true;
      },
    };
  }
  /** Fire the most recent pending callback (if not cleared). */
  flushNext(): void {
    const entry = this.pending.shift();
    if (entry && !entry.cleared) entry.cb();
  }
  pendingCount(): number {
    return this.pending.filter((p) => !p.cleared).length;
  }
  /** Last scheduled delay (for assertions). */
  lastDelay(): number | null {
    if (this.pending.length === 0) return null;
    return this.pending[this.pending.length - 1]!.ms;
  }
}

const SPEC = {
  name: "build-agent",
  role: "builder",
  capabilities: ["build", "test", "deploy"],
};

class FakeClock {
  t = 1_000_000;
  now = (): number => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

describe("AgentManager — pure helpers", () => {
  it("(A1) buildSpawnEnv populates RELAY_AGENT_NAME/ROLE/CAPABILITIES (joined with comma)", () => {
    const env = buildSpawnEnv(SPEC, { PATH: "/usr/bin", FOO: "bar" });
    expect(env.RELAY_AGENT_NAME).toBe("build-agent");
    expect(env.RELAY_AGENT_ROLE).toBe("builder");
    expect(env.RELAY_AGENT_CAPABILITIES).toBe("build,test,deploy");
    // Inherited env preserved.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
    // Token absent when spec doesn't set it.
    expect(env.RELAY_AGENT_TOKEN).toBeUndefined();
  });

  it("(A2) buildSpawnEnv exposes RELAY_AGENT_TOKEN when spec.token is set", () => {
    const env = buildSpawnEnv({ ...SPEC, token: "abc123_test" }, {});
    expect(env.RELAY_AGENT_TOKEN).toBe("abc123_test");
  });

  it("(A3) buildSpawnEnv rejects malformed name/role/capability", () => {
    expect(() => buildSpawnEnv({ ...SPEC, name: "bad name" }, {})).toThrow(/name/);
    expect(() => buildSpawnEnv({ ...SPEC, role: "has space" }, {})).toThrow(/role/);
    expect(() => buildSpawnEnv({ ...SPEC, capabilities: ["good", "bad cap"] }, {})).toThrow(/capability/);
  });

  it("(A4) buildSpawnEnv strips undefined inherited entries (TS-side type narrowing)", () => {
    const env = buildSpawnEnv(SPEC, { PATH: "/usr/bin", UNSET: undefined });
    expect(env.PATH).toBe("/usr/bin");
    expect(Object.prototype.hasOwnProperty.call(env, "UNSET")).toBe(false);
  });

  it("(A5) buildShellCommand defaults to claude", () => {
    expect(buildShellCommand(SPEC)).toBe("claude");
  });

  it("(A6) buildShellCommand honors a known alternate binary in the allowlist", () => {
    // Contract: any allowlisted non-default binary is passed through verbatim.
    // `codex` is the allowlisted alternate; the binary mechanism — not any
    // specific instance name — is what's under test.
    expect(buildShellCommand({ ...SPEC, agentBinary: "codex" })).toBe("codex");
  });

  it("(A7) buildShellCommand rejects out-of-allowlist binaries", () => {
    expect(() =>
      buildShellCommand({ ...SPEC, agentBinary: "rm" }),
    ).toThrow(/disallowed agentBinary/);
    expect(() =>
      buildShellCommand({ ...SPEC, agentBinary: "bash" }),
    ).toThrow(/disallowed agentBinary/);
  });
});

describe("AgentManager — spawn / kill / restart lifecycle", () => {
  let api: ReturnType<typeof makeFakeApi>;
  let scheduler: ManualScheduler;
  let clock: FakeClock;
  let mgr: AgentManager;
  const snapshots: ReturnType<AgentManager["snapshot"]>[] = [];

  beforeEach(() => {
    api = makeFakeApi();
    scheduler = new ManualScheduler();
    clock = new FakeClock();
    snapshots.length = 0;
    mgr = new AgentManager({
      terminalApi: api.api,
      restartPolicy: new RestartPolicy({ now: clock.now }),
      scheduler,
      inheritedEnv: { PATH: "/usr/bin" },
    });
    mgr.onDidChange((s) => snapshots.push(s));
  });

  it("(A8) spawn() creates exactly one terminal with the correct env + kickstart command", () => {
    mgr.spawn(SPEC);
    expect(api.terminals).toHaveLength(1);
    const t = api.terminals[0]!;
    expect(t.options.name).toBe("Tether: build-agent");
    expect(t.options.env.RELAY_AGENT_NAME).toBe("build-agent");
    expect(t.options.env.RELAY_AGENT_ROLE).toBe("builder");
    expect(t.options.env.RELAY_AGENT_CAPABILITIES).toBe("build,test,deploy");
    expect(t.sendTextCalls).toEqual([{ text: "claude", addNewLine: true }]);
    expect(t.showCalls).toBe(1);
    expect(mgr.snapshot().status).toBe("connected");
  });

  it("(A9) spawn() with token populates RELAY_AGENT_TOKEN", () => {
    mgr.spawn({ ...SPEC, token: "secret_token_abc" });
    const env = api.terminals[0]!.options.env;
    expect(env.RELAY_AGENT_TOKEN).toBe("secret_token_abc");
  });

  it("(A10) spawn() is idempotent — second call is a no-op when terminal still alive", () => {
    mgr.spawn(SPEC);
    mgr.spawn({ ...SPEC, name: "different-name" });
    expect(api.terminals).toHaveLength(1);
    expect(api.terminals[0]!.options.env.RELAY_AGENT_NAME).toBe("build-agent");
  });

  it("(A11) kill() disposes the terminal and transitions to idle", () => {
    mgr.spawn(SPEC);
    expect(mgr.snapshot().status).toBe("connected");
    mgr.kill();
    expect(api.terminals[0]!.disposed).toBe(true);
    expect(mgr.snapshot().status).toBe("idle");
  });

  it("(A12) kill() does NOT trigger auto-restart (intentional close)", () => {
    mgr.spawn(SPEC);
    mgr.kill();
    expect(scheduler.pendingCount()).toBe(0);
    // No new terminal materialized.
    expect(api.terminals).toHaveLength(1);
  });

  it("(A13) restart() kills + respawns with the same spec", () => {
    mgr.spawn(SPEC);
    mgr.restart();
    expect(api.terminals).toHaveLength(2);
    expect(api.terminals[1]!.options.env.RELAY_AGENT_NAME).toBe("build-agent");
    expect(api.terminals[0]!.disposed).toBe(true);
  });

  it("(A14) restart() with no prior spawn warns and stays idle", () => {
    mgr.restart();
    expect(api.terminals).toHaveLength(0);
    expect(api.warnMessages.some((m) => /no agent to restart/i.test(m))).toBe(true);
  });
});

describe("AgentManager — crash detection + auto-restart", () => {
  let api: ReturnType<typeof makeFakeApi>;
  let scheduler: ManualScheduler;
  let clock: FakeClock;
  let mgr: AgentManager;

  beforeEach(() => {
    api = makeFakeApi();
    scheduler = new ManualScheduler();
    clock = new FakeClock();
    mgr = new AgentManager({
      terminalApi: api.api,
      restartPolicy: new RestartPolicy({ now: clock.now }),
      scheduler,
      inheritedEnv: {},
    });
  });

  it("(A15) terminal close with non-zero exit triggers auto-restart with 1s delay", () => {
    mgr.spawn(SPEC);
    const t = api.terminals[0]!;
    // Simulate crash: exit code non-zero, fire close event NOT
    // through dispose() (that would be intentional). We do this
    // by calling fireClose directly with exitStatus set.
    t.exitStatus = { code: 137 }; // SIGKILL'd
    api.fireClose(t);
    expect(mgr.snapshot().status).toBe("restarting");
    expect(scheduler.lastDelay()).toBe(1000);
    expect(scheduler.pendingCount()).toBe(1);
    // Fire the restart timer; new terminal materializes.
    scheduler.flushNext();
    expect(api.terminals).toHaveLength(2);
    expect(api.terminals[1]!.options.env.RELAY_AGENT_NAME).toBe("build-agent");
  });

  it("(A16) backoff curve advances on consecutive crashes (1s → 2s → 4s)", () => {
    mgr.spawn(SPEC);
    const wantDelays = [1000, 2000, 4000];
    for (let i = 0; i < wantDelays.length; i += 1) {
      const t = api.terminals[i]!;
      t.exitStatus = { code: 1 };
      api.fireClose(t);
      expect(scheduler.lastDelay(), `crash ${i + 1}`).toBe(wantDelays[i]);
      scheduler.flushNext();
      clock.advance(wantDelays[i]! + 100); // stay inside hour window
    }
  });

  it("(A17) 6th crash within the hour triggers give-up: error state + error toast", () => {
    mgr.spawn(SPEC);
    // 5 successful auto-restarts.
    for (let i = 0; i < 5; i += 1) {
      const t = api.terminals[i]!;
      t.exitStatus = { code: 1 };
      api.fireClose(t);
      scheduler.flushNext();
      clock.advance(60_000); // stay inside hour
    }
    // 6th crash — must give up.
    const t6 = api.terminals[5]!;
    t6.exitStatus = { code: 1 };
    api.fireClose(t6);
    expect(mgr.snapshot().status).toBe("error");
    expect(mgr.snapshot().errorReason).toMatch(/5 restarts/);
    expect(api.errorMessages.length).toBeGreaterThan(0);
    expect(api.errorMessages.at(-1)).toMatch(/crash-looping/);
    expect(scheduler.pendingCount()).toBe(0); // no restart queued
  });

  it("(A18) operator restart from error state resets backoff and respawns", () => {
    mgr.spawn(SPEC);
    // Drive into error state.
    for (let i = 0; i < 6; i += 1) {
      const t = api.terminals[i]!;
      if (t) {
        t.exitStatus = { code: 1 };
        api.fireClose(t);
        scheduler.flushNext();
        clock.advance(60_000);
      }
    }
    expect(mgr.snapshot().status).toBe("error");
    mgr.restart();
    expect(mgr.snapshot().status).toBe("connected");
    expect(mgr.snapshot().consecutiveRestarts).toBe(0);
  });

  it("(A19) kill() during pending restart cancels the timer (no zombie respawn)", () => {
    mgr.spawn(SPEC);
    const t = api.terminals[0]!;
    t.exitStatus = { code: 1 };
    api.fireClose(t);
    expect(scheduler.pendingCount()).toBe(1);
    mgr.kill();
    expect(scheduler.pendingCount()).toBe(0);
    // Even if a stale timer fired, the spec guard would prevent
    // a respawn. Verify by trying to flush.
    scheduler.flushNext();
    expect(api.terminals).toHaveLength(1);
  });

  it("(A20) listener fires on each state transition", () => {
    const seen: string[] = [];
    mgr.onDidChange((s) => seen.push(s.status));
    mgr.spawn(SPEC);
    mgr.kill();
    // onDidChange fires once immediately + once per setStatus()
    // transition. spawn() goes idle → spawning → connected (3
    // events from a fresh subscription); kill goes connected →
    // idle (1 event). The intial-snapshot fire is the first
    // entry. Exact set:
    expect(seen).toEqual(["idle", "spawning", "connected", "idle"]);
  });

  it("(A21) close event for a terminal we don't own is ignored", () => {
    mgr.spawn(SPEC);
    // Create + close an unrelated terminal directly via the api.
    const stranger = api.api.createTerminal({ name: "stranger", env: {} }) as FakeTerminal;
    stranger.exitStatus = { code: 1 };
    api.fireClose(stranger);
    // Manager's status unchanged.
    expect(mgr.snapshot().status).toBe("connected");
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("(A22) dispose() tears down listeners + disposes the live terminal", () => {
    mgr.spawn(SPEC);
    mgr.dispose();
    expect(api.terminals[0]!.disposed).toBe(true);
    // Closing the terminal post-dispose mustn't trigger restart.
    api.terminals[0]!.exitStatus = { code: 1 };
    api.fireClose(api.terminals[0]!);
    // No restart timer queued.
    expect(scheduler.pendingCount()).toBe(0);
  });
});
