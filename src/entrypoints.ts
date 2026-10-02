// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The ONE entrypoint registry (doorbell plan v3, invariant I1; architect ruling
 * ab740fe3). Every way a relay process can be started is listed here with its kind:
 *
 *   long-lived   it keeps running after an install, so something must be able to tell
 *                whether it still runs the old code: its CURRENCY mechanism (a
 *                `connectors` row, the daemon's /health line, or a heartbeat line
 *                that `judgeFleet` reads);
 *   short-lived  one command, then exit: it cannot outlive an install.
 *
 * The CI tripwire (tests/doorbell-pr1-entrypoints.test.ts, through
 * entrypointViolations below) fails on any entrypoint that is NOT in this list:
 * every package.json `bin` target, every script the installers write into a launchd
 * plist or an MCP server config, and every source file with a process bootstrap (a
 * `#!` line). It also fails on a long-lived entry that something INSTALLS while its
 * currency mechanism does not exist yet: no installable process may outlive an
 * install unseen.
 */

export type Currency = "connectors-row" | "daemon-health" | "heartbeat";

export interface EntrypointEntry {
  /** The path inside an install, as the installers and package.json name it. */
  path: string;
  lifetime: "long-lived" | "short-lived";
  /** How a running process of this entry is judged against the install (long-lived only). */
  currency: readonly Currency[];
  note: string;
}

export const ENTRYPOINTS: readonly EntrypointEntry[] = Object.freeze([
  {
    path: "dist/index.js",
    lifetime: "long-lived",
    currency: ["connectors-row", "daemon-health"],
    note: "the relay server: a stdio connector writes its connectors row; the HTTP daemon reports /health.build",
  },
  { path: "bin/relay", lifetime: "short-lived", currency: [], note: "the relay CLI: one command, then exit" },
  {
    path: "dist/doorbell.js",
    lifetime: "long-lived",
    currency: ["heartbeat"],
    note: "the doorbell job (ADR-0038); nothing installs it until its heartbeat line exists (plan v3 PR 5b)",
  },
]);

/**
 * Where each currency mechanism is implemented: a module and an export that must exist,
 * or null while it is not built. A long-lived entry that something installs must have
 * every one of its mechanisms built.
 */
export const CURRENCY_MECHANISMS: Readonly<Record<Currency, { module: string; exportName: string } | null>> = Object.freeze({
  "connectors-row": { module: "./db.js", exportName: "recordOwnConnector" },
  "daemon-health": { module: "./fleet-verdicts.js", exportName: "healthBuild" },
  heartbeat: null, // plan v3 PR 5b: the doorbell's line in judgeFleet
});

/** What the tripwire looks at: every way an entrypoint can be reached, as install-relative paths. */
export interface EntrypointFacts {
  /** package.json `bin` targets. */
  binTargets: string[];
  /** Scripts the installers write into a launchd plist's ProgramArguments. */
  plistScripts: string[];
  /** Scripts the installers write into an MCP server config's args. */
  mcpScripts: string[];
  /** dist paths of source files with a process bootstrap (a `#!` line). */
  bootstrapped: string[];
  /** Whether a module exports a name (for the mechanism check). */
  hasExport: (module: string, exportName: string) => boolean;
}

/** Every tripwire violation, as a human sentence; empty = clean. PURE. */
export function entrypointViolations(f: EntrypointFacts, registry: readonly EntrypointEntry[] = ENTRYPOINTS): string[] {
  const byPath = new Map(registry.map((e) => [e.path, e]));
  const out: string[] = [];
  const reach: Array<[string, string[]]> = [
    ["a package.json bin target", f.binTargets],
    ["a launchd plist script", f.plistScripts],
    ["an MCP server config script", f.mcpScripts],
    ["a source file with a process bootstrap", f.bootstrapped],
  ];
  for (const [what, paths] of reach) {
    for (const p of paths) if (!byPath.has(p)) out.push(`${p} is ${what} but is not in the entrypoint registry (src/entrypoints.ts)`);
  }
  const installed = new Set([...f.binTargets, ...f.plistScripts, ...f.mcpScripts]);
  for (const e of registry) {
    if (e.lifetime === "long-lived" && e.currency.length === 0) out.push(`${e.path} is long-lived but names no currency mechanism`);
    if (e.lifetime === "short-lived" && e.currency.length > 0) out.push(`${e.path} is short-lived but names a currency mechanism`);
    if (e.lifetime !== "long-lived" || !installed.has(e.path)) continue;
    for (const c of e.currency) {
      const m = CURRENCY_MECHANISMS[c];
      if (!m) out.push(`${e.path} is installed and long-lived, but its currency mechanism "${c}" is not built`);
      else if (!f.hasExport(m.module, m.exportName)) out.push(`${e.path}: currency mechanism "${c}" names ${m.module} ${m.exportName}, which does not exist`);
    }
  }
  return out;
}
