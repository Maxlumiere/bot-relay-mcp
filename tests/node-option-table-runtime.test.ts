// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE VERSION-AWARE NODE OPTION TABLE (ruling c076b9cb (3)). The fleet classifier finds a process's script with node's
 * option ARITY (a value-taking option swallows the next argument). A pinned table broke on a newer Node 24 patch
 * (24.22.3 added --experimental-default-config-file, --experimental-package-map, --experimental-test-tag-filter,
 * --test-random-seed: MEASURED in CI). The arity is now DERIVED at runtime from the running node's own `--help`
 * (an option written `--opt=...` takes a value), cached per node binary path + version. Never a target's binary
 * (executing whatever a ps row names would be a trusted-exec hole). If the derivation FAILS, every option is unknown
 * (read both ways): UNKNOWN, loud. A newer version alone never fails it. The table that used to be pinned is now a
 * per-version TEST SNAPSHOT (tests/fixtures/node-help/v<version>.txt).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { parseNodeHelp, nodeOptionTable, type NodeOptionTable } from "../src/node-options.js";
import { classifyProcess } from "../src/fleet-verdicts.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOTS = path.join(REPO, "tests", "fixtures", "node-help");

/** The 4 options node 24.22.3 added (MEASURED in CI), as node's help writes value-taking options. */
const NEWER_PATCH_LINES = [
  "  --experimental-default-config-file=...   set config file from default config file",
  "  --experimental-package-map=...           use the specified file as the package map",
  "  --experimental-test-tag-filter=...       run tests whose tags match",
  "  --test-random-seed=...                   seed for randomized test order",
].join("\n");

describe("parseNodeHelp: node's own help gives each option's arity", () => {
  it("`--opt=...` takes a value; a bare option is a flag; every alias of a line shares its arity; `[=...]` (optional) is a flag", () => {
    const t = parseNodeHelp(["Options:", "  -r, --require=...     module to preload", "  --trace-gc            trace", "  --inspect[=[host:]port]  activate inspector", "  -                     script read from stdin", "  --                    end of options"].join("\n"));
    expect([...t.withValue].sort()).toEqual(["--require", "-r"]);
    expect([...t.flags].sort()).toEqual(["--inspect", "--trace-gc"]);
  });
  it("the snapshot of every recorded version parses non-vacuously (> 150 options)", () => {
    const files = fs.readdirSync(SNAPSHOTS).filter((f) => /^v\d+\.\d+\.\d+\.txt$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const t = parseNodeHelp(fs.readFileSync(path.join(SNAPSHOTS, f), "utf-8"));
      expect(t.withValue.size + t.flags.size, f).toBeGreaterThan(150);
    }
  });
  it("the RUNNING node's derived table equals its recorded snapshot when one exists; a version with NO snapshot still derives (newer never fails)", () => {
    const live = spawnSync(process.execPath, ["--help"], { encoding: "utf-8" }).stdout;
    const derived = parseNodeHelp(live);
    expect(derived.withValue.size + derived.flags.size).toBeGreaterThan(150);
    const snap = path.join(SNAPSHOTS, `${process.version}.txt`);
    if (fs.existsSync(snap)) {
      const recorded = parseNodeHelp(fs.readFileSync(snap, "utf-8"));
      expect([...derived.withValue].sort()).toEqual([...recorded.withValue].sort());
      expect([...derived.flags].sort()).toEqual([...recorded.flags].sort());
    }
  });
});

describe("nodeOptionTable: derived at runtime from process.execPath --help, cached per binary path + version", () => {
  it("one derivation per (execPath, version); the result has node's real options", () => {
    let calls = 0;
    const run = () => (calls++, spawnSync(process.execPath, ["--help"], { encoding: "utf-8" }).stdout);
    const a = nodeOptionTable({ run, key: "test-key-1" });
    const b = nodeOptionTable({ run, key: "test-key-1" });
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.withValue.has("--require")).toBe(true);
  });
  it("the derivation FAILS (the help cannot be read, or reads as nothing) → {ok:false, why}: never a guessed table", () => {
    const failed = nodeOptionTable({ run: () => { throw new Error("spawn failed"); }, key: "test-key-2" });
    expect(failed).toMatchObject({ ok: false, why: expect.stringMatching(/spawn failed/) });
    const empty = nodeOptionTable({ run: () => "Usage: node [options]\n", key: "test-key-3" });
    expect(empty).toMatchObject({ ok: false, why: expect.stringMatching(/too few options/) });
  });
});

describe("the classifier uses the DERIVED table: a newer patch's value option never hides, nor fakes, the script", () => {
  const INSTALL = "/opt/relay";
  const DECOY = "/tmp/decoy";
  const fsx = {
    isFile: (p: string) => [`${INSTALL}/dist/index.js`, `${DECOY}/dist/index.js`].includes(p),
    realpath: (p: string) => p,
    packageName: (d: string) => (d === INSTALL || d === DECOY ? "bot-relay-mcp" : null),
  };
  const view = (argv: string[]) => ({ pid: 77, ppid: 1, start: "Mon Nov 24 10:00:00 2026 UTC", command: argv.join(" "), comm: "node", cwd: "/", argv });
  const derived24_22 = (): NodeOptionTable => {
    const t = parseNodeHelp(fs.readFileSync(path.join(SNAPSHOTS, "v24.13.0.txt"), "utf-8") + "\n" + NEWER_PATCH_LINES);
    return { ok: true, ...t };
  };
  it("24.22.3's --experimental-package-map VALUE (it looks like a relay script) is NOT taken as the script: the real script decides → CONNECTOR", () => {
    const c = classifyProcess(view(["node", "--experimental-package-map", `${DECOY}/dist/index.js`, `${INSTALL}/dist/index.js`]) as never, new Set(), fsx as never, derived24_22());
    expect(c).toEqual({ kind: "connector", script: `${INSTALL}/dist/index.js`, installDir: INSTALL });
  });
  it("CONTROL: with a table that does NOT know the option (the old pinned one), the same argv is read both ways → UNKNOWN (never a guessed connector)", () => {
    const old = parseNodeHelp(fs.readFileSync(path.join(SNAPSHOTS, "v24.13.0.txt"), "utf-8"));
    const c = classifyProcess(view(["node", "--experimental-package-map", `${DECOY}/dist/index.js`, `${INSTALL}/dist/index.js`]) as never, new Set(), fsx as never, { ok: true, ...old });
    expect(c.kind).toBe("unknown");
  });
  it("the derivation FAILED → an option-bearing relay process is UNKNOWN, and the reason SAYS the table could not be derived (loud)", () => {
    const c = classifyProcess(view(["node", "--require", "/x/hook.js", `${INSTALL}/dist/index.js`]) as never, new Set(), fsx as never, { ok: false, why: "spawn failed" });
    expect(c.kind).toBe("unknown");
    expect(c.kind === "unknown" ? c.reason : "").toMatch(/option table could not be derived \(spawn failed\)/);
  });
  it("no options at all: the table is never needed (a failed derivation still classifies a plain `node <script>`)", () => {
    const c = classifyProcess(view(["node", `${INSTALL}/dist/index.js`]) as never, new Set(), fsx as never, { ok: false, why: "spawn failed" });
    expect(c).toEqual({ kind: "connector", script: `${INSTALL}/dist/index.js`, installDir: INSTALL });
  });
});
