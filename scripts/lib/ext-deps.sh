# bot-relay-mcp
# Copyright (c) 2026 Lumiere Ventures
# SPDX-License-Identifier: MIT
# See LICENSE for full terms.
#
# Sourced by scripts/pre-publish-check.sh. relay_ext_deps_missing DIR: return 0 (missing, so install) when
# DIR/node_modules lacks a tool the extension steps run (esbuild for the bundle, tsc for the compile), 1 when
# both are present. An EMPTY node_modules counts as missing: the old `[ ! -d node_modules ]` skipped the
# install on an empty directory, and the 4.0.0 publish then failed on a missing esbuild.
# Windows is detected by $OS=Windows_NT (set by Windows itself, inherited by Git Bash/MSYS/Cygwin shells) or by a
# MINGW/MSYS/CYGWIN `uname -s`. Only there does a .cmd shim count: on Unix a .cmd file cannot run the tool.
relay_is_windows() {
  [ "${OS:-}" = "Windows_NT" ] && return 0
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; esac
  return 1
}
relay_ext_tool_present() {
  [ -x "$1/$2" ] && return 0
  relay_is_windows && [ -f "$1/$2.cmd" ] && return 0
  return 1
}
relay_ext_deps_missing() {
  local d="$1/node_modules/.bin"
  relay_ext_tool_present "$d" esbuild && relay_ext_tool_present "$d" tsc && return 1
  return 0
}
