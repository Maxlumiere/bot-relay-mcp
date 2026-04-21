// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Shared validation + env-var construction for all spawn drivers (v1.9).
 *
 * The authoritative allowlist regexes live in src/types.ts (SpawnAgentSchema).
 * zod has already validated the input by the time a driver sees it. This
 * module provides:
 *   1. Platform-aware CWD normalization (Windows separator handling).
 *   2. Minimal env-var construction (principle of least authority — do NOT
 *      propagate arbitrary host env into spawned agents).
 *   3. RELAY_TERMINAL_APP allowlist gating.
 */
import { randomBytes } from "crypto";
import fs from "fs";
import type { SupportedPlatform } from "./types.js";

/**
 * POSIX single-quote escape for embedding untrusted content inside a
 * single-quoted shell string. Pattern: close quote, escaped literal quote,
 * reopen quote. Universal across POSIX shells (sh, bash, dash, zsh).
 *
 *   escapeSingleQuotesPosix("a'b")  →  "a'\\''b"
 *
 * The zod schema already forbids `'` in cwd, so today this function is a
 * no-op on legitimate input. v1.9.1 defense-in-depth: even if a future
 * feature relaxes the schema, the Linux tmux / gnome-terminal / konsole /
 * xterm paths stay safe because they escape before embedding.
 */
export function escapeSingleQuotesPosix(raw: string): string {
  return raw.replace(/'/g, `'\\''`);
}

/**
 * PowerShell single-quote escape — doubles each single quote inside a
 * single-quoted PowerShell string literal. PowerShell's own rule:
 *   'it''s'  →  it's
 *
 * Today the zod schema forbids `'` in cwd so this is also a no-op on
 * legitimate input. v1.9.1 defense-in-depth for the Windows powershell
 * driver's `Set-Location -LiteralPath '<cwd>'` path.
 */
export function escapeSingleQuotesPowershell(raw: string): string {
  return raw.replace(/'/g, `''`);
}

/**
 * Generate a short random suffix for tmux session names.
 * 4 hex chars = 2 bytes = 65,536 values. Used ONLY for the tmux session
 * name, never for the agent's relay identity.
 */
export function tmuxSessionSuffix(): string {
  return randomBytes(2).toString("hex");
}

/** Driver names accepted for RELAY_TERMINAL_APP override (v1.9). */
export const TERMINAL_APP_ALLOWLIST: ReadonlySet<string> = new Set([
  // macOS
  "iterm2",
  "terminal",
  // Linux
  "gnome-terminal",
  "konsole",
  "xterm",
  "tmux",
  // Windows
  "wt",
  "powershell",
  "cmd",
]);

/**
 * Platform-scoped allowlists — used by v1.9.1 to reject cross-platform
 * overrides (e.g., RELAY_TERMINAL_APP=gnome-terminal on macOS would silently
 * fall through in v1.9.0; now returns null with a warning, same as "unknown"
 * values).
 */
export const TERMINAL_APP_BY_PLATFORM: Record<SupportedPlatform, ReadonlySet<string>> = {
  darwin: new Set(["iterm2", "terminal"]),
  linux: new Set(["gnome-terminal", "konsole", "xterm", "tmux"]),
  win32: new Set(["wt", "powershell", "cmd"]),
};

/**
 * Gate the RELAY_TERMINAL_APP env var against the platform's allowlist.
 * Returns the normalized value, or null if unset / invalid / cross-platform.
 * Invalid values fall through to auto-detect; caller may log a warning.
 *
 * v1.9.1 change: platform-aware. A Linux driver name on macOS returns null.
 * This makes the override semantics match operator intuition.
 */
export function resolveTerminalOverride(
  raw: string | undefined,
  platform: SupportedPlatform
): string | null {
  if (!raw) return null;
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return null;
  const platformSet = TERMINAL_APP_BY_PLATFORM[platform];
  if (platformSet && platformSet.has(lowered)) return lowered;
  return null;
}

/**
 * Normalize a CWD path for the target platform.
 *
 * The zod schema validates a POSIX-style path. On Windows, we normalize
 * forward slashes to backslashes (lexical only — does not relax the
 * allowlist; forbidden characters remain forbidden).
 *
 * v1.9.1 adds platform-aware rejection:
 *   - POSIX (darwin, linux): a drive-letter prefix (C:\ / D:/ etc.) is a
 *     Windows path and has no meaning here — reject it rather than let it
 *     silently break the spawn.
 *   - Windows (win32): the cwd must be absolute in Windows semantics (drive
 *     letter OR forward-slash-anchored). Non-absolute Windows paths are
 *     rejected.
 *
 * We do NOT `path.resolve()` here — the input is already an absolute path
 * per the schema, and resolve() would read process.cwd() which is a
 * spawn-host concern, not a target-agent concern.
 */
export function normalizeCwd(rawCwd: string, platform: SupportedPlatform): string {
  // Platform-awareness: drive-letter paths are Windows-only.
  const hasDriveLetter = /^[A-Za-z]:[\\/]/.test(rawCwd);
  if (platform === "win32") {
    if (!hasDriveLetter && !rawCwd.startsWith("/") && !rawCwd.startsWith("\\")) {
      throw new Error(
        `Windows spawn: cwd "${rawCwd}" is not absolute. Use a drive letter (C:\\...) or an absolute forward-slash path.`
      );
    }
    return rawCwd.replace(/\//g, "\\");
  }
  // POSIX (darwin, linux): reject Windows-style drive letter paths.
  if (hasDriveLetter) {
    throw new Error(
      `${platform} spawn: cwd "${rawCwd}" is a Windows-style drive-letter path, not valid on ${platform}.`
    );
  }
  return rawCwd;
}

/**
 * Build the minimal env-var map propagated into the spawned Claude Code
 * process. The set is DELIBERATELY small:
 *   - Essential for any process: PATH, HOME/USERPROFILE, LANG, TERM.
 *   - Relay identity: RELAY_AGENT_NAME/ROLE/CAPABILITIES (and TOKEN if set).
 *   - Relay transport config: RELAY_TRANSPORT, RELAY_HTTP_HOST, RELAY_HTTP_PORT.
 *   - Nothing else by default.
 *
 * This is principle-of-least-authority: a spawned agent doesn't need the
 * parent's AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, etc. Operators who need to
 * propagate extra vars can set them with `RELAY_` prefix and they'll pass
 * through via the glob (see below).
 */
/**
 * Defense-in-depth shape check for agent tokens — mirrors the regex in
 * hooks/post-tool-use-check.sh + hooks/stop-check.sh. Centralized here so
 * the spawn path can drop invalid tokens before they reach the child.
 */
const TOKEN_SHAPE_RE = /^[A-Za-z0-9_=.-]{8,128}$/;
export function isValidTokenShape(raw: string | undefined | null): raw is string {
  return typeof raw === "string" && TOKEN_SHAPE_RE.test(raw);
}

/**
 * v2.1.4 (I10): validate a brief_file_path input — absolute, allowlist-matched,
 * exists, readable, <=10KB. Zod has already done the regex+char check at the
 * MCP boundary; this helper adds the filesystem-side invariants that cannot
 * be expressed in a Zod schema.
 *
 * Throws typed Error on any failure. Returns the canonical (as-passed) path
 * string on success — we deliberately do NOT realpath-resolve here; the
 * literal string is what spawn-agent.sh will embed into the KICKSTART
 * prompt, and keeping that equal to what the caller typed is the right UX.
 *
 * Size cap: 10240 bytes. Briefs larger than that should live in a repo
 * path the agent reads with its own Read tool at session start; 10KB is
 * enough for task scope + key constraints.
 */
export const BRIEF_FILE_MAX_BYTES = 10240;

export function validateBriefPath(raw: string): { path: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("brief_file_path must be a non-empty string");
  }
  if (!raw.startsWith("/")) {
    throw new Error(`brief_file_path must be an absolute path (starts with /); got "${raw}"`);
  }
  // Allowlist — defense-in-depth even though Zod already checked.
  if (!/^\/[A-Za-z0-9_./ -]+$/.test(raw)) {
    throw new Error(
      `brief_file_path contains characters outside the allowlist [A-Za-z0-9_./ -]: "${raw}"`
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`brief_file_path does not exist or is not accessible: "${raw}" (${msg})`);
  }
  if (!stat.isFile()) {
    throw new Error(`brief_file_path is not a regular file: "${raw}"`);
  }
  if (stat.size > BRIEF_FILE_MAX_BYTES) {
    throw new Error(
      `brief_file_path exceeds max size ${BRIEF_FILE_MAX_BYTES} bytes (got ${stat.size}): "${raw}"`
    );
  }
  try {
    fs.accessSync(raw, fs.constants.R_OK);
  } catch {
    throw new Error(`brief_file_path is not readable: "${raw}"`);
  }
  return { path: raw };
}

export function buildChildEnv(
  name: string,
  role: string,
  capabilities: string[],
  platform: SupportedPlatform,
  parentEnv: NodeJS.ProcessEnv = process.env,
  token?: string | null,
  /**
   * v2.2.0: window title the child terminal should advertise to the relay on
   * register. Defaults to the agent name when omitted. Flows through the
   * hook's register_agent call so the dashboard click-to-focus driver can
   * look up the live window by title.
   */
  terminalTitle?: string | null
): Record<string, string> {
  const out: Record<string, string> = {};

  // System essentials — different names on Windows vs POSIX.
  const passThrough: string[] =
    platform === "win32"
      ? ["PATH", "SYSTEMROOT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG"]
      : ["PATH", "HOME", "LANG", "TERM", "SHELL", "USER"];

  for (const key of passThrough) {
    const val = parentEnv[key];
    if (typeof val === "string") out[key] = val;
  }

  // Relay-prefixed variables: any RELAY_* passes through. Operators who need
  // to forward custom env can use the prefix.
  for (const [key, val] of Object.entries(parentEnv)) {
    if (typeof val === "string" && key.startsWith("RELAY_")) {
      out[key] = val;
    }
  }

  // Explicit identity (overrides any existing RELAY_AGENT_* from parent).
  out.RELAY_AGENT_NAME = name;
  out.RELAY_AGENT_ROLE = role;
  out.RELAY_AGENT_CAPABILITIES = capabilities.join(",");
  // v2.2.0: RELAY_TERMINAL_TITLE is read by the SessionStart hook and passed
  // to register_agent so the dashboard click-to-focus driver can look up
  // the live window. Defaults to the agent name (matches the bash script's
  // `--name $Q_DISPLAY` default).
  out.RELAY_TERMINAL_TITLE =
    typeof terminalTitle === "string" && terminalTitle.length > 0
      ? terminalTitle
      : name;

  // v2.1 Phase 4j: explicit child token override. The parent pre-registered
  // the child and captured the plaintext token once — propagate it so the
  // child's first call hits the authenticated path without operator paste.
  // Drop silently on shape failure (defense-in-depth; an invalid token is
  // strictly worse than no token because the hook fallback would still issue
  // its own via legacy-migration, but a malformed string here would leak
  // through to the child's shell).
  if (isValidTokenShape(token)) {
    out.RELAY_AGENT_TOKEN = token;
  }

  return out;
}
