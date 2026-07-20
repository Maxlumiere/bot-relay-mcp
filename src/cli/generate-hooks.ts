// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — `relay generate-hooks` subcommand.
 * v2.17.0 (P1) — `--codex` / `--all` for Codex CLI hook parity.
 *
 * Default (Claude Code): emits a ~/.claude/settings.json fragment (or full file
 * under --full) with the three hook entries (SessionStart auto-register +
 * PostToolUse / Stop mailbox notify), correctly-quoted absolute paths.
 *
 * --codex (Codex CLI): emits a ~/.codex/config.toml fragment with a SINGLE
 * register-only SessionStart hook. Codex wakes via Tether (the VS Code
 * extension) + the bin/codex-relay launcher — there is NO Stop-hook poll loop
 * (the old codex-stop.sh poller was removed in v2.16.4). PostToolUse / Stop have
 * no Codex analog by design; we do NOT force symmetry.
 *
 * --all: emit both, each in its own labeled section.
 */
import path from "path";
import { fileURLToPath } from "url";
import { getAgentCliProfile } from "../agent-cli-profiles.js";

/**
 * Quote a shell command path for embedding in JSON's "command" field.
 * Paths without spaces pass through unchanged. Paths with spaces get
 * single-quoted inside the JSON string value — double-quote is the JSON
 * delimiter; single-quote survives to the shell that Claude Code spawns.
 */
function quoteForHookCommand(p: string): string {
  if (!/\s/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Encode a string as a TOML double-quoted basic string. Escapes backslash,
 * double-quote, AND all control characters (U+0000–U+001F, U+007F) per the TOML
 * spec — a POSIX path containing a newline / CR / tab would otherwise be emitted
 * literally and produce INVALID TOML. Named escapes for the common controls,
 * \uXXXX for the rest. Exported for the escaping regression test.
 */
export function tomlBasicString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0").toUpperCase();
    else out += ch;
  }
  return out + '"';
}

function resolveInstallDir(): string {
  // dist/cli/generate-hooks.js → dist/cli → dist → project root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

/** Claude Code hook config (~/.claude/settings.json), built from the registry. */
function claudeHooksConfig(): { hooks: Record<string, unknown> } {
  const root = resolveInstallDir();
  const profile = getAgentCliProfile("claude");
  if (!profile) throw new Error("agent-cli-profiles: 'claude' profile missing");
  const hooks: Record<string, unknown> = {};
  for (const ev of profile.hookInstall.events) {
    hooks[ev.event] = [
      {
        matcher: ev.matcher,
        hooks: [
          {
            type: "command",
            command: quoteForHookCommand(path.join(root, ev.script)),
            ...(ev.timeout !== undefined ? { timeout: ev.timeout } : {}),
          },
        ],
      },
    ];
  }
  return { hooks };
}

/**
 * Codex CLI hook config (~/.codex/config.toml) — register-only SessionStart.
 * NO Stop hook / NO poller: Codex wakes via Tether + bin/codex-relay. The hook
 * registers the agent + its Tether v0.3 PID-handshake so Tether can PID-bind the
 * terminal; the bin/codex-relay launcher pre-registers host_shell_pids at pure
 * launch so a freshly-summoned Codex wakes with zero manual turns.
 */
function codexConfigToml(): string {
  const root = resolveInstallDir();
  const profile = getAgentCliProfile("codex");
  if (!profile) throw new Error("agent-cli-profiles: 'codex' profile missing");
  const ss = profile.hookInstall.events.find((e) => e.event === "SessionStart");
  if (!ss) throw new Error("agent-cli-profiles: 'codex' profile has no SessionStart hook");
  const launcher = path.join(root, "bin", "codex-relay");
  const lines = [
    "# bot-relay-mcp — Codex CLI hook. Paste into ~/.codex/config.toml.",
    "#",
    "# Register-only SessionStart hook: it registers this Codex session + its Tether",
    "# v0.3 PID-handshake on the relay. There is NO Stop-hook poll loop — Codex wakes",
    "# via Tether (the VS Code extension), token-free. For zero-manual-turn wake at",
    "# PURE launch, launch Codex through the cold-start launcher, which pre-registers",
    "# host_shell_pids from the shell before exec'ing Codex:",
    "#",
    `#     alias codex-relay-example='RELAY_AGENT_NAME=<name> RELAY_AGENT_ROLE=<role> \\`,
    `#       ${launcher} <name>'`,
    "#",
    "# You also need the bot-relay MCP server configured in Codex (so the woken agent",
    "# can call get_messages/send_message) and RELAY_AGENT_NAME reaching that server",
    "# (the launcher's -c override handles it). See docs/agents/codex-autowake.md.",
    "",
    "[[hooks.SessionStart]]",
    `matcher = ${tomlBasicString(ss.matcher)}`,
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${tomlBasicString(path.join(root, ss.script))}`,
  ];
  if (ss.statusMessage) lines.push(`statusMessage = ${tomlBasicString(ss.statusMessage)}`);
  lines.push("");
  return lines.join("\n");
}

function windowsHookDisclaimer(): void {
  // The .sh hooks are bash-only (POSIX readlink, sqlite3 CLI, python3). Applies to
  // both the Claude and Codex hooks. Operators on win32 run inside WSL or skip hooks.
  process.stderr.write(
    "[generate-hooks] WARNING: relay hooks ship as bash scripts (.sh).\n" +
      "  Native Windows is NOT supported. Choose one:\n" +
      "    (a) Run your agent CLI inside WSL — the .sh hooks work unchanged there.\n" +
      "    (b) Skip hook installation. Mail visibility still works via the HTTP\n" +
      "        transport (relay daemon on :3777 + RELAY_AGENT_TOKEN); you lose the\n" +
      "        SessionStart auto-register + near-real-time mailbox notify.\n" +
      "  See docs/multi-instance.md §'Windows hook story' for the full rationale.\n",
  );
}

export async function run(argv: string[]): Promise<number> {
  const full = argv.includes("--full");
  const codex = argv.includes("--codex");
  const all = argv.includes("--all");
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) {
    process.stdout.write(
      "Usage: relay generate-hooks [--codex | --all] [--full]\n\n" +
        "Emit relay hook config for your agent CLI.\n" +
        "  (default)   Claude Code — JSON fragment for ~/.claude/settings.json\n" +
        "              (SessionStart auto-register + PostToolUse/Stop mailbox notify).\n" +
        "  --full      Claude Code — complete settings.json template.\n" +
        "  --codex     Codex CLI — TOML fragment for ~/.codex/config.toml\n" +
        "              (register-only SessionStart hook; Codex wakes via Tether +\n" +
        "               bin/codex-relay — no poll loop).\n" +
        "  --all       Emit both, each in its own labeled section.\n\n" +
        "Hook-model note: Claude Code uses SessionStart + PostToolUse + Stop; Codex\n" +
        "uses a single register-only SessionStart hook (its wake is Tether-driven,\n" +
        "not a hook poll loop). PostToolUse/Stop have no Codex analog by design.\n",
    );
    return 0;
  }
  if (process.platform === "win32") windowsHookDisclaimer();

  const claudePayload = claudeHooksConfig();
  const claudeOut = full
    ? JSON.stringify(claudePayload, null, 2)
    : JSON.stringify(claudePayload.hooks, null, 2);

  if (all) {
    process.stdout.write(
      "# ===== Claude Code — ~/.claude/settings.json (JSON) =====\n" +
        claudeOut +
        "\n\n" +
        "# ===== Codex CLI — ~/.codex/config.toml (TOML) =====\n" +
        codexConfigToml() +
        "\n",
    );
    return 0;
  }
  if (codex) {
    process.stdout.write(codexConfigToml() + "\n");
    return 0;
  }
  process.stdout.write(claudeOut + "\n");
  return 0;
}
