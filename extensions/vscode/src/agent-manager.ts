// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2 — AgentManager: spawn + observe + auto-restart a single
 * agent process inside a VSCode integrated terminal.
 *
 * Architecture (locked in audit-findings/v0.2-tether-executor-scope-brief.md):
 *   - VSCode Terminal API hosts the agent process. No node-pty.
 *   - claude CLI runs inside the terminal. SessionStart hook does
 *     register_agent + token-vault hydration end-to-end (zero new
 *     daemon-side API needed).
 *   - Caps locked at first spawn per
 *     `memory/feedback_relay_caps_immutable.md`. Kill+respawn with
 *     widened caps requires `unregister_agent` first (out of
 *     AgentManager's scope; surfaced to the operator).
 *   - Auto-restart on non-zero exit using RestartPolicy (5/hr cap,
 *     1s→2s→4s→8s→16s clamped at 30s).
 *
 * This module DOES NOT import `vscode` directly so unit tests can
 * stub the terminal API surface without monkey-patching node's
 * module loader. extension.ts wires the real `vscode.window`
 * through `TerminalApi` at construction.
 */

import { RestartPolicy, type RestartDecision } from "./restart-policy.js";
import { tetherTerminalName } from "./terminal-targeting.js";

/** Subset of vscode.TerminalOptions the AgentManager needs. */
export interface ManagedTerminalOptions {
  name: string;
  env: Record<string, string>;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
  hideFromUser?: boolean;
}

/** Subset of vscode.Terminal the AgentManager observes + drives. */
export interface ManagedTerminal {
  /** Bring the terminal panel to the front. */
  show(preserveFocus?: boolean): void;
  /** Type text into the terminal. With addNewLine the text submits. */
  sendText(text: string, addNewLine?: boolean): void;
  /**
   * Kill the underlying process + close the terminal panel. The
   * `onDidCloseTerminal` event fires as a side effect; AgentManager
   * uses `intentionalCloseFor` to distinguish operator-driven
   * shutdown (kill / restart) from a crash.
   */
  dispose(): void;
  /**
   * Reads as `undefined` while the terminal is alive. After close,
   * carries the exit code (when known). VSCode's actual type also
   * has a `reason` enum which we don't introspect — only the code.
   */
  readonly exitStatus: { code: number | undefined } | undefined;
}

/** Tear-off of the bits of `vscode.window` AgentManager calls. */
export interface TerminalApi {
  createTerminal(opts: ManagedTerminalOptions): ManagedTerminal;
  onDidCloseTerminal(cb: (t: ManagedTerminal) => void): { dispose(): void };
  showInformationMessage(msg: string): Thenable<unknown>;
  showWarningMessage(msg: string): Thenable<unknown>;
  showErrorMessage(msg: string): Thenable<unknown>;
}

/** Configuration of the single managed agent. */
export interface AgentSpec {
  /** Agent name — passed via RELAY_AGENT_NAME. Must match the relay's allowlist. */
  name: string;
  /** Agent role — passed via RELAY_AGENT_ROLE. */
  role: string;
  /**
   * Agent capabilities. Locked at first register per
   * `feedback_relay_caps_immutable.md` — declare ALL caps the
   * agent might ever need here at first spawn.
   */
  capabilities: string[];
  /**
   * Plaintext token to expose as RELAY_AGENT_TOKEN inside the
   * spawned terminal. Optional — if the per-instance vault has
   * a fresh token AND the SessionStart hook can resolve it, the
   * agent boots without a parent-provided token. When set,
   * SessionStart hydration is bypassed in favor of the env var.
   */
  token?: string;
  /**
   * Optional override of the binary to run inside the terminal.
   * Defaults to `claude`. Useful for `codex` / `codex-5-5` /
   * future agent CLIs. Validated against a strict allowlist
   * inside `buildShellCommand` so a malicious workspace setting
   * can't shell-out via this knob.
   */
  agentBinary?: string;
  /**
   * Optional cwd for the terminal. Defaults to undefined which
   * means VSCode picks the workspace folder (its default).
   */
  cwd?: string;
}

/** Status of the managed agent, surfaced to the status bar. */
export type AgentStatus =
  | "idle"
  | "spawning"
  | "connected"
  | "crashed"
  | "restarting"
  | "error";

export interface AgentSnapshot {
  spec: AgentSpec | null;
  status: AgentStatus;
  errorReason: string | null;
  /** Number of consecutive auto-restarts since the last clean start. */
  consecutiveRestarts: number;
  /** Total crashes within the rolling rate-cap window. */
  recentCrashes: number;
}

/** Listener for state transitions — wired to the status bar updater. */
export type AgentChangeListener = (snapshot: AgentSnapshot) => void;

const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const AGENT_BINARY_ALLOWLIST = ["claude", "codex", "codex-5-5"] as const;

/**
 * `setTimeout` factory used for restart delays. Injected so tests
 * can drive timers without `vi.useFakeTimers()` global state
 * pollution.
 */
export interface Scheduler {
  setTimeout(cb: () => void, ms: number): { clear: () => void };
}

/** Default scheduler — production uses real timers. */
export function realScheduler(): Scheduler {
  return {
    setTimeout(cb: () => void, ms: number) {
      const handle = setTimeout(cb, ms);
      return {
        clear: () => clearTimeout(handle),
      };
    },
  };
}

/**
 * Build the shell command(s) that boot the agent inside the
 * terminal. Validates the binary against an allowlist so a
 * malicious settings.json can't pivot Tether into a generic
 * shell-exec primitive.
 */
export function buildShellCommand(spec: AgentSpec): string {
  const bin = spec.agentBinary ?? "claude";
  if (!(AGENT_BINARY_ALLOWLIST as readonly string[]).includes(bin)) {
    throw new Error(
      `disallowed agentBinary "${bin}". Allowed: ${AGENT_BINARY_ALLOWLIST.join(", ")}`,
    );
  }
  // We DON'T pre-quote or otherwise shell-escape the binary — the
  // VSCode Terminal sendText runs through the parent shell which
  // applies its own quoting. The allowlist above is the security
  // boundary; everything past it is treated as trusted.
  return bin;
}

/**
 * Build the env-var map for the spawned terminal. Caller-supplied
 * `inherit` should usually be `process.env`; AgentManager keeps it
 * a parameter so tests can pass {} for a clean slate.
 */
export function buildSpawnEnv(
  spec: AgentSpec,
  inherit: Record<string, string | undefined>,
): Record<string, string> {
  if (!AGENT_NAME_RE.test(spec.name)) {
    throw new Error(
      `invalid agent name "${spec.name}" — must match ${AGENT_NAME_RE.source}`,
    );
  }
  if (!AGENT_NAME_RE.test(spec.role)) {
    throw new Error(
      `invalid agent role "${spec.role}" — must match ${AGENT_NAME_RE.source}`,
    );
  }
  for (const c of spec.capabilities) {
    if (!AGENT_NAME_RE.test(c)) {
      throw new Error(
        `invalid capability "${c}" — must match ${AGENT_NAME_RE.source}`,
      );
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inherit)) {
    if (typeof v === "string") out[k] = v;
  }
  out.RELAY_AGENT_NAME = spec.name;
  out.RELAY_AGENT_ROLE = spec.role;
  out.RELAY_AGENT_CAPABILITIES = spec.capabilities.join(",");
  if (spec.token && spec.token.length > 0) {
    out.RELAY_AGENT_TOKEN = spec.token;
  }
  return out;
}

export class AgentManager {
  private readonly terminalApi: TerminalApi;
  private readonly restartPolicy: RestartPolicy;
  private readonly scheduler: Scheduler;
  private readonly inheritedEnv: Record<string, string | undefined>;
  private readonly listeners = new Set<AgentChangeListener>();
  private readonly closeSubscription: { dispose(): void };

  private spec: AgentSpec | null = null;
  private terminal: ManagedTerminal | null = null;
  private status: AgentStatus = "idle";
  private errorReason: string | null = null;
  /**
   * Set when AgentManager itself initiates the terminal close
   * (kill / restart). `onDidCloseTerminal` checks this flag to
   * decide whether the close is a crash (auto-restart candidate)
   * or operator-driven (ignored).
   */
  private intentionalCloseFor: ManagedTerminal | null = null;
  /** Pending restart timer — cancellable via kill(). */
  private pendingRestart: { clear: () => void } | null = null;

  constructor(opts: {
    terminalApi: TerminalApi;
    restartPolicy?: RestartPolicy;
    scheduler?: Scheduler;
    inheritedEnv?: Record<string, string | undefined>;
  }) {
    this.terminalApi = opts.terminalApi;
    this.restartPolicy = opts.restartPolicy ?? new RestartPolicy();
    this.scheduler = opts.scheduler ?? realScheduler();
    this.inheritedEnv = opts.inheritedEnv ?? {};
    this.closeSubscription = this.terminalApi.onDidCloseTerminal((t) =>
      this.onTerminalClosed(t),
    );
  }

  /** Test/debug introspection of the manager's current state. */
  snapshot(): AgentSnapshot {
    return {
      spec: this.spec,
      status: this.status,
      errorReason: this.errorReason,
      consecutiveRestarts: this.restartPolicy.getConsecutiveAttempts(),
      recentCrashes: this.restartPolicy.getRecentCrashCount(),
    };
  }

  /**
   * Subscribe to state transitions. Each listener fires once
   * synchronously after subscription with the current snapshot
   * so the status bar wires up in the right state out of the
   * gate.
   */
  onDidChange(cb: AgentChangeListener): { dispose(): void } {
    this.listeners.add(cb);
    cb(this.snapshot());
    return {
      dispose: () => {
        this.listeners.delete(cb);
      },
    };
  }

  /**
   * Spawn the agent. If one is already running, this is a no-op
   * (caller should `restart()` instead). Throws on invalid spec.
   * Returns the snapshot post-spawn so callers can chain UI logic.
   */
  spawn(spec: AgentSpec): AgentSnapshot {
    if (this.terminal) {
      return this.snapshot();
    }
    // Validate via buildSpawnEnv before any side effect so a bad
    // spec never half-spawns a terminal.
    const env = buildSpawnEnv(spec, this.inheritedEnv);
    const cmd = buildShellCommand(spec);

    this.spec = spec;
    this.errorReason = null;
    this.setStatus("spawning");
    const terminal = this.terminalApi.createTerminal({
      // v0.2.2 P3 — single-source the spawn-name convention so it can never
      // drift from what resolveWakeTarget() looks for.
      name: tetherTerminalName(spec.name),
      env,
      cwd: spec.cwd,
    });
    this.terminal = terminal;
    terminal.show(true);
    terminal.sendText(cmd, true);
    // Status transitions to "connected" once we have evidence the
    // agent is alive. The relay-side daemon owns that signal; for
    // v0.2 the manager treats successful spawn as "connected" since
    // the executor scope brief defers process-health observability
    // to v0.3+. The status will flip to "crashed" or "error" on
    // close.
    this.setStatus("connected");
    return this.snapshot();
  }

  /**
   * Kill the agent. Cancels any pending restart, marks the close
   * as intentional, and disposes the terminal. Status goes to
   * "idle"; spec is preserved so `restart()` knows what to
   * respawn.
   */
  kill(): AgentSnapshot {
    if (this.pendingRestart) {
      this.pendingRestart.clear();
      this.pendingRestart = null;
    }
    if (this.terminal) {
      this.intentionalCloseFor = this.terminal;
      this.terminal.dispose();
      this.terminal = null;
    }
    this.setStatus("idle");
    return this.snapshot();
  }

  /**
   * Operator-initiated restart. Kills + spawns with the previously
   * recorded spec. No-op (with a warning toast) when no spec has
   * been recorded yet — caller should `spawn()` first.
   */
  restart(): AgentSnapshot {
    if (!this.spec) {
      void this.terminalApi.showWarningMessage(
        "Tether: no agent to restart. Run 'Tether: Spawn Agent' first.",
      );
      return this.snapshot();
    }
    const spec = this.spec;
    this.kill();
    // Operator-initiated restart resets the backoff curve but the
    // hour-window crash history stays (so a flapping agent the
    // operator manually bounces still trips the cap eventually).
    this.restartPolicy.recordSuccess();
    return this.spawn(spec);
  }

  /**
   * Tear down listeners + dispose terminal. Called on extension
   * deactivation.
   */
  dispose(): void {
    if (this.pendingRestart) {
      this.pendingRestart.clear();
      this.pendingRestart = null;
    }
    if (this.terminal) {
      this.intentionalCloseFor = this.terminal;
      this.terminal.dispose();
      this.terminal = null;
    }
    this.closeSubscription.dispose();
    this.listeners.clear();
  }

  // ---- private ----

  private setStatus(s: AgentStatus, errorReason: string | null = null): void {
    if (this.status === s && this.errorReason === errorReason) return;
    this.status = s;
    this.errorReason = errorReason;
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // Listener errors don't propagate — a faulty status-bar
        // updater shouldn't take the manager down.
      }
    }
  }

  private onTerminalClosed(t: ManagedTerminal): void {
    if (this.terminal !== t) {
      // Some other terminal closed (e.g. operator opened an
      // unrelated terminal). Ignore.
      return;
    }
    const wasIntentional = this.intentionalCloseFor === t;
    this.intentionalCloseFor = null;
    this.terminal = null;
    if (wasIntentional) {
      // kill() / dispose() already set status. Don't double-fire.
      return;
    }
    // Crash detection: anything that closes without us asking is a
    // crash. exitStatus.code is informational only for the status
    // bar; we restart on close regardless of code because the
    // executor model treats the terminal closing == agent gone.
    const code = t.exitStatus?.code;
    if (!this.spec) {
      // Shouldn't happen — closure without a spec means terminal
      // was created outside spawn(). Fail safe to idle.
      this.setStatus("idle");
      return;
    }
    this.setStatus("crashed");
    const decision: RestartDecision = this.restartPolicy.recordCrash();
    if (decision.kind === "give_up") {
      this.setStatus("error", decision.reason);
      void this.terminalApi.showErrorMessage(
        `Tether: agent "${this.spec.name}" crash-looping — ${decision.reason}. Manual intervention needed (Tether: Restart Agent).`,
      );
      return;
    }
    this.setStatus("restarting");
    const codeMsg = typeof code === "number" ? ` (exit ${code})` : "";
    void this.terminalApi.showWarningMessage(
      `Tether: agent "${this.spec.name}" closed${codeMsg} — restarting in ${(decision.delayMs / 1000).toFixed(1)}s (attempt ${decision.attempt}/5).`,
    );
    const specAtCrash = this.spec;
    this.pendingRestart = this.scheduler.setTimeout(() => {
      this.pendingRestart = null;
      // Guard against kill() interleaving with the scheduled fire.
      if (this.spec !== specAtCrash) return;
      this.spawn(specAtCrash);
    }, decision.delayMs);
  }
}
