#!/bin/bash
# bot-relay-mcp: spawn a new Claude Code terminal pre-configured as a relay agent.
#
# Opens a new iTerm2 window (or falls back to Terminal.app) with the agent's
# name, role, and capabilities set as environment variables. The SessionStart
# hook will automatically register the agent and deliver pending mail when
# Claude Code starts.
#
# Usage:
#   spawn-agent.sh <name> <role> [capabilities] [cwd]
#
# Examples:
#   spawn-agent.sh builder-1 builder
#   spawn-agent.sh reviewer reviewer "review,testing,security"
#   spawn-agent.sh worker builder "build,deploy" "/path/to/project"
#
# Security (v1.6.1 + v1.6.2 defense-in-depth):
#
# THREE layers of defense. All three exist independently. DO NOT remove any
# of them without reviewing the threat model — each catches a different class
# of attack and a future refactor that simplifies "just this one" layer will
# reintroduce the vulnerability.
#
# Layer 1 — TS Zod validation at the MCP tool boundary (src/types.ts
#   SpawnAgentSchema). This is the primary defense and fails-fast before
#   the shell ever runs. Uses the same regexes as this script, deliberately.
# Layer 2 — This script's argument validation (regex allowlist below).
#   Protects against direct CLI invocation bypassing the MCP layer.
# Layer 3 — printf %q for shell interpolation and applescript_escape() for
#   the osascript heredoc. Even if a bug let a bad character through, the
#   final command embedding stays safe.
#
# Allowlists:
# - Name/role:     [A-Za-z0-9_.-]{1,64}
# - Capabilities:  [A-Za-z0-9_.,-]{1,256} (comma-separated tokens)
# - CWD:           absolute path, no shell metacharacters, no newlines, 1-1024 chars
#
# Integration tests in tests/spawn-integration.test.ts exercise this script
# directly with RELAY_SPAWN_DRY_RUN=1 and 15+ attack payloads. If you edit
# this file, run those tests.

set -eu

NAME="${1:-}"
ROLE="${2:-}"
CAPS="${3:-}"
CWD="${4:-$HOME}"
# v2.1 Phase 4j: optional parent-issued agent token. When present, the script
# exports it into the child terminal's shell so the spawned agent starts
# authenticated — no operator paste required. Shape-validated below.
TOKEN="${5:-}"

if [ -z "$NAME" ] || [ -z "$ROLE" ]; then
  echo "Usage: $0 <name> <role> [capabilities] [cwd] [token]" >&2
  exit 1
fi

# --- Input validation (v1.6.1 security hardening) ---
validate_token() {
  local value="$1"
  local field="$2"
  local pattern="$3"
  local max_len="$4"
  if [ "${#value}" -gt "$max_len" ]; then
    echo "[spawn-agent] $field exceeds $max_len chars" >&2
    exit 2
  fi
  # Reject newlines, CRs, tabs, and null bytes explicitly. grep -E anchors $ at
  # each line end, so a multi-line value can smuggle garbage past the regex if
  # we only check with grep. Catch that here, before the regex.
  # macOS bash 3.2 does not handle $'\n' inside case patterns reliably, so we
  # use tr to strip control chars and compare lengths instead.
  stripped=$(printf '%s' "$value" | tr -d '\n\r\t\0')
  if [ "${#stripped}" -ne "${#value}" ]; then
    echo "[spawn-agent] $field contains a newline, carriage return, tab, or null byte" >&2
    exit 2
  fi
  if ! printf '%s' "$value" | grep -Eq "$pattern"; then
    echo "[spawn-agent] $field has invalid characters. Allowed pattern: $pattern" >&2
    exit 2
  fi
}

validate_token "$NAME" "name" '^[A-Za-z0-9_.-]+$' 64
validate_token "$ROLE" "role" '^[A-Za-z0-9_.-]+$' 64
if [ -n "$CAPS" ]; then
  validate_token "$CAPS" "capabilities" '^[A-Za-z0-9_.,-]+$' 256
fi
# v2.1 Phase 4j: token shape allowlist mirrors hooks/post-tool-use-check.sh +
# src/spawn/validation.ts isValidTokenShape. Same pattern in three places is
# deliberate defense-in-depth — any one of them could drift, but an invalid
# token reaching the exported CMD would embed in an AppleScript string and
# could smuggle characters past applescript_escape on future refactors.
if [ -n "$TOKEN" ]; then
  validate_token "$TOKEN" "token" '^[A-Za-z0-9_=.-]+$' 128
  if [ "${#TOKEN}" -lt 8 ]; then
    echo "[spawn-agent] token is too short (min 8 chars)" >&2
    exit 2
  fi
fi

# CWD must be an absolute path with no shell metacharacters or newlines.
case "$CWD" in
  /*) ;;
  *) echo "[spawn-agent] cwd must be an absolute path. Got: $CWD" >&2; exit 2 ;;
esac
if [ "${#CWD}" -gt 1024 ]; then
  echo "[spawn-agent] cwd exceeds 1024 chars" >&2
  exit 2
fi
# Strip control chars first (CRLF smuggling defense, same pattern as validate_token)
cwd_stripped=$(printf '%s' "$CWD" | tr -d '\n\r\t\0')
if [ "${#cwd_stripped}" -ne "${#CWD}" ]; then
  echo "[spawn-agent] cwd contains a newline, carriage return, tab, or null byte" >&2
  exit 2
fi
case "$CWD" in
  *[\`\;\$\&\|\<\>\"\'\*\?]*)
    echo "[spawn-agent] cwd contains disallowed shell metacharacters" >&2
    exit 2 ;;
esac

# Symlink / path-resolution defense (v1.6.3).
# Even if the cwd text looks safe, a symlink at /tmp/foo -> / would let an
# attacker cd into any directory they can create a symlink to. Resolve via
# `cd && pwd -P` (POSIX, no realpath dependency) and assert the resolved path
# is still under an approved root ($HOME or a tmp directory).
# Skips the check if the path does not exist yet — spawn will fail naturally
# when the child terminal tries to cd into it, which is fine.
if [ -e "$CWD" ]; then
  CWD_RESOLVED=$(cd "$CWD" 2>/dev/null && pwd -P 2>/dev/null)
  if [ -z "$CWD_RESOLVED" ]; then
    echo "[spawn-agent] cwd could not be resolved (broken symlink?)" >&2
    exit 2
  fi
  # v1.6.4: every approved-root entry now has both the bare form AND the /* form
  # so a cwd that resolves to EXACTLY /var/folders (no subpath) is still accepted.
  # Uncommon but possible on macOS and worth closing for robustness.
  case "$CWD_RESOLVED" in
    "$HOME"|"$HOME"/*|/tmp|/tmp/*|/private/tmp|/private/tmp/*|/var/folders|/var/folders/*)
      ;;
    *)
      echo "[spawn-agent] cwd resolves to '$CWD_RESOLVED' which is outside approved roots (\$HOME, /tmp)" >&2
      exit 2 ;;
  esac
fi

# --- Build the inner command using printf %q for shell-safe quoting ---
# The new terminal will run this as its first command.
Q_NAME=$(printf '%q' "$NAME")
Q_ROLE=$(printf '%q' "$ROLE")
Q_CAPS=$(printf '%q' "$CAPS")
Q_CWD=$(printf '%q' "$CWD")

CMD="export RELAY_AGENT_NAME=$Q_NAME; export RELAY_AGENT_ROLE=$Q_ROLE; export RELAY_AGENT_CAPABILITIES=$Q_CAPS;"
# v2.1 Phase 4j: when a token is provided, export it into the child's shell
# so the spawned agent is authenticated from its first tool call.
if [ -n "$TOKEN" ]; then
  Q_TOKEN=$(printf '%q' "$TOKEN")
  CMD="$CMD export RELAY_AGENT_TOKEN=$Q_TOKEN;"
fi
CMD="$CMD cd $Q_CWD; claude"

# --- Detect terminal. Prefer iTerm2 if running, else Terminal.app. ---
TERMINAL="Terminal"
if osascript -e 'tell application "System Events" to (name of processes) contains "iTerm2"' 2>/dev/null | grep -q "true"; then
  TERMINAL="iTerm2"
fi

# Explicit override must also match our allowlist
if [ -n "${RELAY_TERMINAL_APP:-}" ]; then
  case "$RELAY_TERMINAL_APP" in
    iTerm2|Terminal) TERMINAL="$RELAY_TERMINAL_APP" ;;
    *) echo "[spawn-agent] Unsupported RELAY_TERMINAL_APP (allowed: iTerm2, Terminal)" >&2; exit 2 ;;
  esac
fi

# --- Escape for AppleScript string embedding ---
# Replace \ with \\ first, then " with \", preserving any other character.
applescript_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}
AS_CMD=$(applescript_escape "$CMD")

# Dry-run mode for tests: emit the final command to stdout and exit.
if [ "${RELAY_SPAWN_DRY_RUN:-}" = "1" ]; then
  printf 'TERMINAL=%s\n' "$TERMINAL"
  printf 'CMD=%s\n' "$CMD"
  printf 'AS_CMD=%s\n' "$AS_CMD"
  exit 0
fi

if [ "$TERMINAL" = "iTerm2" ]; then
  osascript <<EOF
tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "$AS_CMD"
  end tell
end tell
EOF
elif [ "$TERMINAL" = "Terminal" ]; then
  osascript <<EOF
tell application "Terminal"
  activate
  do script "$AS_CMD"
end tell
EOF
else
  echo "[spawn-agent] Unsupported terminal: $TERMINAL" >&2
  exit 1
fi

echo "Spawned agent '$NAME' (role: $ROLE) in $TERMINAL"
