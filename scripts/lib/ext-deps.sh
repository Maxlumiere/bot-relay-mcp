# bot-relay-mcp
# Copyright (c) 2026 Lumiere Ventures
# SPDX-License-Identifier: MIT
# See LICENSE for full terms.
#
# Sourced by scripts/pre-publish-check.sh. relay_ext_deps_missing DIR: return 0 (missing, so install) when
# DIR/node_modules lacks a tool the extension steps run (esbuild for the bundle, tsc for the compile), 1 when
# both are present. An EMPTY node_modules counts as missing: the old `[ ! -d node_modules ]` skipped the
# install on an empty directory, and the 4.0.0 publish then failed on a missing esbuild.
relay_ext_deps_missing() {
  local d="$1/node_modules/.bin"
  # Windows installs .cmd shims next to (or instead of) the POSIX scripts.
  { [ -x "$d/esbuild" ] || [ -f "$d/esbuild.cmd" ]; } && { [ -x "$d/tsc" ] || [ -f "$d/tsc.cmd" ]; } && return 1
  return 0
}
