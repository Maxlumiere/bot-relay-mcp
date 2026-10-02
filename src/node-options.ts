// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 3 (#297 Codex R1 P1) — node's OWN command-line option table, so the
 * fleet classifier can find a process's script (the first non-option argument)
 * without ever taking an option's VALUE for it.
 *
 * Source: `node --help` of node v22.23.3 and v24.13.0 (the supported range,
 * engines >=22). An option listed as `--opt=...` takes a value, which node also
 * accepts as the NEXT argument; every other listed option is a flag (an optional
 * value, `--inspect[=port]`, attaches only with `=`). No option has a different
 * arity across those versions. tests/adr-0047-fleet-verdicts.test.ts pins this
 * table against `node --help` of the node running the suite, so a node upgrade
 * that adds an option fails loudly instead of silently mis-parsing.
 *
 * An option NOT in this table (a V8 option such as --max-old-space-size, or one
 * from a newer node) is uncertain in the space form: the classifier reads it both
 * ways and never concludes "not relay" from a reading it cannot confirm.
 */

/** Options that take a value: `--opt=value`, or `--opt value` (the NEXT argument). */
export const NODE_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--allow-fs-read", "--allow-fs-write", "--build-snapshot-config", "--conditions", "--cpu-prof-dir",
  "--cpu-prof-interval", "--cpu-prof-name", "--debug-port", "--diagnostic-dir", "--disable-proto",
  "--disable-warning", "--dns-result-order", "--env-file", "--env-file-if-exists", "--eval",
  "--experimental-config-file", "--experimental-default-type", "--experimental-loader",
  "--experimental-sea-config", "--experimental-test-isolation", "--heap-prof-dir", "--heap-prof-interval",
  "--heap-prof-name", "--heapsnapshot-near-heap-limit", "--heapsnapshot-signal", "--icu-data-dir", "--import",
  "--input-type", "--inspect-port", "--inspect-publish-uid", "--loader", "--localstorage-file",
  "--max-http-header-size", "--max-old-space-size-percentage", "--network-family-autoselection-attempt-timeout",
  "--openssl-config", "--redirect-warnings", "--report-dir", "--report-directory", "--report-filename",
  "--report-signal", "--require", "--run", "--secure-heap", "--secure-heap-min", "--snapshot-blob",
  "--test-concurrency", "--test-coverage-branches", "--test-coverage-exclude", "--test-coverage-functions",
  "--test-coverage-include", "--test-coverage-lines", "--test-global-setup", "--test-isolation",
  "--test-name-pattern", "--test-reporter", "--test-reporter-destination", "--test-rerun-failures",
  "--test-shard", "--test-skip-pattern", "--test-timeout", "--title", "--tls-cipher-list", "--tls-keylog",
  "--trace-event-categories", "--trace-event-file-pattern", "--trace-require-module", "--unhandled-rejections",
  "--use-largepages", "--v8-pool-size", "--watch-kill-signal", "--watch-path", "-C", "-e", "-r",
]);

/** Options that never take the next argument (flags, and optional values that attach only with `=`). */
export const NODE_FLAGS: ReadonlySet<string> = new Set([
  "--abort-on-uncaught-exception", "--allow-addons", "--allow-child-process", "--allow-inspector", "--allow-wasi",
  "--allow-worker", "--build-snapshot", "--check", "--completion-bash", "--cpu-prof", "--disable-sigusr1",
  "--disable-wasm-trap-handler", "--disallow-code-generation-from-strings", "--enable-etw-stack-walking",
  "--enable-fips", "--enable-network-family-autoselection", "--enable-source-maps", "--entry-url",
  "--experimental-addon-modules", "--experimental-async-context-frame", "--experimental-default-config-file",
  "--experimental-eventsource", "--experimental-import-meta-resolve", "--experimental-inspector-network-resource",
  "--experimental-network-inspection", "--experimental-permission", "--experimental-print-required-tla",
  "--experimental-strip-types", "--experimental-test-coverage", "--experimental-test-module-mocks",
  "--experimental-transform-types", "--experimental-vm-modules", "--experimental-webstorage",
  "--experimental-worker-inspection", "--expose-gc", "--force-context-aware", "--force-fips",
  "--force-node-api-uncaught-exceptions-policy", "--frozen-intrinsics", "--heap-prof", "--help",
  "--huge-max-old-generation-size", "--insecure-http-parser", "--inspect", "--inspect-brk", "--inspect-wait",
  "--interactive", "--interpreted-frames-native-stack", "--jitless", "--no-addons", "--no-async-context-frame",
  "--no-deprecation", "--no-experimental-detect-module", "--no-experimental-fetch",
  "--no-experimental-global-customevent", "--no-experimental-global-navigator",
  "--no-experimental-global-webcrypto", "--no-experimental-repl-await", "--no-experimental-require-module",
  "--no-experimental-sqlite", "--no-experimental-strip-types", "--no-experimental-websocket",
  "--no-extra-info-on-fatal-exception", "--no-force-async-hooks-checks", "--no-global-search-paths",
  "--no-network-family-autoselection", "--no-strip-types", "--no-warnings", "--node-memory-debug",
  "--openssl-legacy-provider", "--openssl-shared-config", "--pending-deprecation", "--permission",
  "--preserve-symlinks", "--preserve-symlinks-main", "--print", "--prof", "--prof-process", "--report-compact",
  "--report-exclude-env", "--report-exclude-network", "--report-on-fatalerror", "--report-on-signal",
  "--report-uncaught-exception", "--test", "--test-force-exit", "--test-only", "--test-update-snapshots",
  "--throw-deprecation", "--tls-max-v1.2", "--tls-max-v1.3", "--tls-min-v1.0", "--tls-min-v1.1",
  "--tls-min-v1.2", "--tls-min-v1.3", "--trace-atomics-wait", "--trace-deprecation", "--trace-env",
  "--trace-env-js-stack", "--trace-env-native-stack", "--trace-exit", "--trace-promises", "--trace-sigint",
  "--trace-sync-io", "--trace-tls", "--trace-uncaught", "--trace-warnings", "--track-heap-objects",
  "--use-bundled-ca", "--use-env-proxy", "--use-openssl-ca", "--use-system-ca", "--v8-options", "--version",
  "--watch", "--watch-preserve-output", "--zero-fill-buffers", "-c", "-h", "-i", "-p", "-v",
]);

/**
 * Options after which node runs no script file at all (checked BEFORE the tables above).
 * NOT -i / --interactive: `node -i <script>` still runs the script (#297 Codex R2 #2).
 */
export const NODE_NO_SCRIPT: ReadonlySet<string> = new Set([
  "-e", "--eval", "-p", "--print", "-v", "--version", "-h", "--help", "-c", "--check", "--run",
]);
