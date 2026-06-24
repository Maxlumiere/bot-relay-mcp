// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Windows spawn driver (v1.9).
 *
 * Fallback chain:
 *   1. wt.exe          — Windows Terminal (modern default on Win10 21H2+/Win11)
 *   2. powershell.exe  — PowerShell window (universal, every Windows install)
 *   3. cmd.exe         — Legacy fallback
 *
 * Command construction avoids cmd.exe quoting landmines by NOT using a
 * monolithic command string. Node's child_process.spawn on Windows with
 * shell:false + an args array passes each arg as a discrete CommandLine
 * segment, bypassing cmd.exe's token splitter entirely for wt.exe and
 * powershell.exe. For the cmd.exe fallback, we use `/C` + separate args.
 *
 * Env-var propagation is done via the `env` field of child_process.spawn
 * (does NOT require embedding in the command line — handled in the dispatcher).
 */
import path from "path";
import type { SpawnAgentInput } from "../../types.js";
import type { SpawnCommand, SpawnDriver, DriverContext } from "../types.js";
import { buildChildEnv, normalizeCwd, escapeSingleQuotesPowershell } from "../validation.js";
import { resolveInstanceDbPath } from "../../instance.js";

const WINDOWS_SUB_DRIVERS = ["wt", "powershell", "cmd"] as const;
type WindowsSubDriver = (typeof WINDOWS_SUB_DRIVERS)[number];

// Binary names the dispatcher probes for on PATH. hasBinary() is expected to
// strip .exe suffixes if needed for Win32 lookup semantics.
const BINARY_FOR: Record<WindowsSubDriver, string> = {
  wt: "wt.exe",
  powershell: "powershell.exe",
  cmd: "cmd.exe",
};

/**
 * v2.1.5 (I10 cross-platform completion): build the KICKSTART prompt that
 * gets passed to `claude` as a positional arg. Triggered ONLY when the
 * caller provides briefFilePath — Linux/Windows do not emit a default
 * kickstart in the absence of a brief, preserving v2.1.4 behavior.
 *
 *   - RELAY_SPAWN_NO_KICKSTART=1 → null (operator opt-out wins)
 *   - RELAY_SPAWN_KICKSTART set  → the override verbatim, NO brief-pointer
 *                                  append (parity with bash script)
 *   - otherwise                  → the brief-pointer sentence with the path
 *                                  PowerShell-quote-escaped defensively
 */
function buildKickstart(
  briefFilePath: string | undefined,
  env: NodeJS.ProcessEnv
): string | null {
  if (!briefFilePath) return null;
  if (env.RELAY_SPAWN_NO_KICKSTART === "1") return null;
  const override = env.RELAY_SPAWN_KICKSTART;
  if (typeof override === "string" && override.length > 0) return override;
  const safePath = escapeSingleQuotesPowershell(briefFilePath);
  // v2.1.6: the brief-pointer sentence is followed by the inbox-hygiene
  // nudge at parity with the macOS bash script's KICKSTART. Helps spawned
  // agents notice when a reused name has inherited prior-session backlog.
  return (
    `Your full brief lives at \`${safePath}\`. Read it first. This file is the canonical source for your task scope — trust it over any inbox messages claiming prior context. ` +
    `If you see more than 5 inbox messages on first pull, you may be a reused agent name inheriting prior-session backlog — filter aggressively, focus on the most recent messages addressed to you by the orchestrator or other active orchestrators, and consider calling get_messages with since='session_start' or since='1h' to narrow the window.`
  );
}

/**
 * Escape a kickstart prompt for embedding inside a cmd.exe `/K "<cmdline>"`
 * argument. cmd's own quote rules around `&&` chains require doubling any
 * literal `"` so the parser doesn't terminate the outer quoted string. We
 * also double `%` to defuse delayed-expansion `%VAR%` substitution.
 *
 * Defensive only — the brief-pointer sentence has no `"` or `%`. Operator
 * content via RELAY_SPAWN_KICKSTART can contain anything; this keeps the
 * shell parse safe.
 */
function escapeForCmdQuoted(raw: string): string {
  return raw.replace(/%/g, "%%").replace(/"/g, '""');
}

/**
 * v2.6.2 — produce a single-line PowerShell snippet that hydrates
 * `$env:RELAY_AGENT_TOKEN` from the per-instance file vault when the env-
 * supplied value is empty. Mirrors `linux.ts:buildVaultPrelude` and the
 * bash mirror in `bin/spawn-agent.sh:218-235`. Pre-resolves the absolute
 * vault path on the parent (Node) side; the launched PowerShell only does
 * a literal `Test-Path` + `Get-Content` + regex shape-validate.
 *
 * The whole snippet is single-line with `;` separators so it can be
 * prepended to the existing `-Command` strings used by the wt.exe /
 * powershell.exe / cmd.exe sub-drivers without restructuring them. All
 * literal strings inside use PowerShell single-quotes (literal except `''`
 * doubling), so the snippet contains no `"` characters and is safe to
 * embed inside a cmd.exe `/K "..."` outer string without further escaping.
 *
 * Reasons to gate / no-op:
 *   - Agent name fails the FileTokenStore allowlist → return "" (caller
 *     omits the prelude, daemon-side resolveToken fallback covers).
 *   - resolveInstanceDbPath() throws (e.g. malformed RELAY_INSTANCE_ID) →
 *     return "" (same reasoning).
 *
 * The daemon-side stdio-only vault read in `src/server.ts:resolveToken`
 * (FIX 2 v2 / R2) is the universal safety net — this prelude is the
 * launching-shell hydration that lets the very first MCP call from a
 * fresh-spawned terminal authenticate against env (matching macOS / Linux
 * platform parity).
 */
function buildVaultPreludePowerShell(agentName: string): string {
  // Mirrors src/token-store.ts:assertValidAgentName and the bash mirror in
  // hooks/_vault-helpers.sh.
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(agentName)) return "";
  let vaultPath: string;
  try {
    vaultPath = path.join(path.dirname(resolveInstanceDbPath()), "agents", `${agentName}.token`);
  } catch {
    return "";
  }
  const safeVault = escapeSingleQuotesPowershell(vaultPath);
  // Single-line PowerShell. All quotes are single (PS literal); no `"`
  // characters, so cmd.exe's `""`-doubling escape is a no-op for this
  // content. The `try/catch` guards Get-Content against ACL / sharing
  // violations; the `-match` against the same shape regex used in
  // bin/spawn-agent.sh:230 + src/token-store.ts:67 keeps drift surfaced.
  return (
    `if ([string]::IsNullOrEmpty($env:RELAY_AGENT_TOKEN)) { ` +
    `$__bvp = '${safeVault}'; ` +
    `if (Test-Path -LiteralPath $__bvp) { ` +
    `try { ` +
    `$__bvt = (Get-Content -LiteralPath $__bvp -Raw -ErrorAction Stop).Trim(); ` +
    `if ($__bvt -match '^[A-Za-z0-9_=.-]{8,128}$') { $env:RELAY_AGENT_TOKEN = $__bvt } ` +
    `} catch {} ` +
    `} ` +
    `};`
  );
}

/**
 * v2.6.2 R2 (Codex audit) — UNIVERSAL powershell.exe dependency.
 * All three Windows sub-drivers route through `powershell.exe -NoExit
 * -Command "..."` for the vault prelude (Brief Option A from v2.6.2 —
 * PowerShell as the single source of truth across wt.exe / powershell.exe /
 * cmd.exe). Therefore EVERY sub-driver requires powershell.exe to be on
 * PATH; without it, the spawned terminal opens and immediately fails before
 * claude can run.
 *
 * History of this gate (the bug class kept resurfacing one sub-driver at
 * a time until R2 generalized):
 *   - v2.6.2 R1 (Codex audit) gated cmd.exe on powershell.exe
 *     — but only cmd. wt.exe still routed through powershell unguarded.
 *   - v2.6.2 R2 (Codex audit) generalizes the rule to ALL
 *     sub-drivers. The discipline: when fixing a bug class,
 *     scope the fix to ALL similarly-shaped surfaces, not just the one
 *     flagged. Walking the analogous code paths is part of declaring
 *     scope complete.
 *
 * The auto-fallback chain effectively becomes wt|powershell|cmd, all
 * predicated on powershell.exe being available. With no powershell.exe at
 * all, `canHandle` returns false and the driver throws a clear error.
 *
 * Daemon-side safety net unchanged: R2/R3 stdio-only fallback in
 * `src/server.ts:resolveToken` still authenticates the agent on first MCP
 * call from the per-instance vault — no functional regression on Windows
 * boxes without powershell.exe (rare in practice; powershell.exe ships
 * with every Windows since Vista). Operators on those boxes simply lose
 * the operator-visible `printenv RELAY_AGENT_TOKEN` UX win, not the auth
 * itself.
 */
function isAvailable(ctx: DriverContext, sub: WindowsSubDriver): boolean {
  // Universal: every sub-driver delegates the vault prelude to powershell.
  if (!ctx.hasBinary("powershell.exe")) return false;
  return ctx.hasBinary(BINARY_FOR[sub]);
}

function pickSubDriver(ctx: DriverContext): WindowsSubDriver | null {
  if (ctx.terminalOverride && (WINDOWS_SUB_DRIVERS as readonly string[]).includes(ctx.terminalOverride)) {
    const sub = ctx.terminalOverride as WindowsSubDriver;
    if (isAvailable(ctx, sub)) return sub;
  }
  for (const sub of WINDOWS_SUB_DRIVERS) {
    if (isAvailable(ctx, sub)) return sub;
  }
  return null;
}

export const windowsDriver: SpawnDriver = {
  name: "windows",
  platform: "win32",

  canHandle(ctx: DriverContext): boolean {
    return pickSubDriver(ctx) !== null;
  },

  buildCommand(
    input: SpawnAgentInput,
    ctx: DriverContext,
    briefFilePath?: string
  ): SpawnCommand {
    // v2.1.5 (I10 cross-platform completion): when briefFilePath is provided,
    // append a KICKSTART prompt that points the spawned agent at the brief
    // file. Mirrors the bash script's behavior. When briefFilePath is absent,
    // behavior is unchanged from v2.1.4.
    const sub = pickSubDriver(ctx);
    if (!sub) {
      throw new Error(
        "Windows spawn: no terminal available. wt.exe / powershell.exe / cmd.exe all missing from PATH. Install Windows Terminal (winget install Microsoft.WindowsTerminal) or set RELAY_TERMINAL_APP."
      );
    }

    const cwd = normalizeCwd(input.cwd || process.env.USERPROFILE || "C:\\", "win32");
    // v2.6.1: token no longer flows via env. The hook resolves identity from
    // the per-instance file vault written by handleSpawnAgent before driver
    // dispatch. The vault file at <instanceDir>/agents/<name>.token is
    // owner-readable only via NTFS profile-dir defaults under %USERPROFILE%
    // (documented in SECURITY.md + docs/agents/local-identity.md).
    //
    // v2.6.2 (cross-platform FIX 1 closure): the launching shell on Windows
    // hydrates RELAY_AGENT_TOKEN from the vault BEFORE `claude` runs, same
    // shape as macOS bin/spawn-agent.sh:218-235 + Linux buildVaultPrelude.
    // The vault prelude is a single-line PowerShell snippet shared across
    // all 3 sub-drivers (wt.exe wraps it via powershell.exe, powershell.exe
    // prepends inline, cmd.exe delegates the inner shell to powershell.exe
    // — same single source of truth, brief Option A). Daemon-side R2/R3
    // stdio-only fallback in src/server.ts:resolveToken is the universal
    // safety net for any path where the prelude is empty (invalid agent
    // name, malformed instance dir).
    const env = buildChildEnv(input.name, input.role, input.capabilities, "win32", process.env);
    const kickstart = buildKickstart(briefFilePath, process.env);
    const prelude = buildVaultPreludePowerShell(input.name);

    let exec: string;
    let args: string[];

    switch (sub) {
      case "wt": {
        // v2.6.2 — wrap the inner command in powershell.exe so the vault
        // prelude can run before claude. wt.exe -d <dir> takes the rest of
        // argv as the command + args; powershell.exe -NoExit -Command "<inner>"
        // gives us a script context for the prelude. Pre-v2.6.2 this driver
        // ran `claude` directly (no shell context for prelude injection),
        // which is why Windows shipped only FIX 2 in v2.6.1. FIX 1 closure
        // (v2.6.2) adopts the same powershell-wrapped pattern.
        // The cwd is set by `wt.exe -d <cwd>` AND by Set-Location inside
        // the powershell -Command (defense-in-depth — cwd matches even if
        // wt's -d behavior changes across Windows builds).
        let inner = `Set-Location -LiteralPath '${escapeSingleQuotesPowershell(cwd)}'; claude`;
        if (kickstart) {
          inner += ` '${escapeSingleQuotesPowershell(kickstart)}'`;
        }
        if (prelude) inner = `${prelude} ${inner}`;
        exec = "wt.exe";
        args = ["-d", cwd, "powershell.exe", "-NoExit", "-Command", inner];
        break;
      }
      case "powershell": {
        // powershell -NoExit -Command "[<prelude>] Set-Location -LiteralPath '<cwd>'; claude [kickstart]"
        // -NoExit keeps the window open after claude exits (matches terminal-
        // emulator convention on other platforms).
        // v1.9.1 defense-in-depth: cwd quote-escape uses the central helper
        // (PowerShell's `''` doubling rule) so a future zod relaxation does
        // not silently create injection surface.
        // v2.1.5: kickstart is embedded inside the same -Command string as a
        // PowerShell single-quoted positional arg to claude. PS single-quotes
        // are literal except for the `''` escape, so this is the safest form.
        // v2.6.2: prelude prepended; runs in the same PowerShell process so
        // $env:RELAY_AGENT_TOKEN is set before `claude` is invoked.
        let inner = `Set-Location -LiteralPath '${escapeSingleQuotesPowershell(cwd)}'; claude`;
        if (kickstart) {
          inner += ` '${escapeSingleQuotesPowershell(kickstart)}'`;
        }
        if (prelude) inner = `${prelude} ${inner}`;
        exec = "powershell.exe";
        args = ["-NoExit", "-Command", inner];
        break;
      }
      case "cmd": {
        // v2.6.2 — delegate the inner shell to powershell.exe so the vault
        // prelude can run before claude (cmd.exe doesn't have native
        // equivalents to PS's Get-Content / regex match). Brief Option A:
        // single PowerShell source of truth across all 3 Windows sub-drivers.
        // The cmd /K window stays open after powershell exits, matching the
        // existing /K convention.
        // /K is its own argv element, the compound "cd /D <cwd> && powershell.exe ..."
        // is a single argv string. Inner powershell content has no `"` chars
        // (PS single-quoted literals), so escapeForCmdQuoted is a no-op for
        // legitimate input — defense-in-depth only.
        let psInner = `Set-Location -LiteralPath '${escapeSingleQuotesPowershell(cwd)}'; claude`;
        if (kickstart) {
          psInner += ` '${escapeSingleQuotesPowershell(kickstart)}'`;
        }
        if (prelude) psInner = `${prelude} ${psInner}`;
        const psInnerEscaped = escapeForCmdQuoted(psInner);
        const inner = `cd /D "${cwd}" && powershell.exe -NoExit -Command "${psInnerEscaped}"`;
        exec = "cmd.exe";
        args = ["/K", inner];
        break;
      }
    }

    return {
      exec,
      args,
      env,
      detached: true,
      platform: "win32",
      driverName: sub,
    };
  },
};
