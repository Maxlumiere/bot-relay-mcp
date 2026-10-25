// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The sandbox child env (tests/_helpers/sandbox-env.ts, used by the release suite's sandbox and the SEC-24 black-box
 * test) never carries an inherited NODE_OPTIONS: a planted `--require` preload in the parent env would run in the
 * child BEFORE the operator tripwire's own preload. CONTROL: a parent NODE_OPTIONS=--require <a file that writes a
 * marker> does NOT run in a child started with the sandbox env (no marker). THE TWIN: the same planted env passed
 * through unfiltered DOES run it (the marker appears), so the control is not vacuous.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { sandboxEnv } from "./_helpers/sandbox-env.js";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-env-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function plant(label: string) {
  const dir = path.join(ROOT, label);
  fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  const marker = path.join(dir, "PRELOAD-RAN");
  const preload = path.join(dir, "preload.cjs");
  fs.writeFileSync(preload, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  // Unquoted (NODE_OPTIONS quoting and Windows backslashes do not mix): the temp dir must hold no space.
  if (/\s/.test(preload)) throw new Error(`precondition: the preload path holds a space: ${preload}`);
  const parent: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require=${preload}` };
  return { dir, marker, parent };
}

describe("the sandbox child env drops an inherited NODE_OPTIONS", () => {
  it("CONTROL: a planted NODE_OPTIONS=--require preload in the parent env does NOT run in a child started with the sandbox env", () => {
    const p = plant("control");
    const env = sandboxEnv(path.join(p.dir, "home"), p.parent);
    expect(Object.keys(env).some((k) => /^node_options$/i.test(k) && env[k]?.includes("preload.cjs")), "no NODE_OPTIONS carrying the plant").toBe(false);
    const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { env, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(p.marker), "the planted preload never ran").toBe(false);
  });

  it("THE TWIN: the same planted env passed through unfiltered DOES run the preload (the control is not vacuous)", () => {
    const p = plant("twin");
    const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { env: p.parent, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(p.marker), "the planted preload ran").toBe(true);
  });

  it("drops NODE_OPTIONS in any letter case (Windows env names are case-insensitive), and every relay and test-runner variable", () => {
    const env = sandboxEnv("/sandbox-home", { PATH: "/bin", Node_Options: "--require x", NODE_OPTIONS: "--require y", RELAY_HOME: "/r", relay_db_path: "/d", VITEST_WORKER_ID: "1", KEEP: "k" });
    expect(Object.keys(env).filter((k) => /^(node_options|relay_|vitest)/i.test(k))).toEqual([]);
    expect(env.KEEP).toBe("k");
    expect(env.HOME).toBe("/sandbox-home");
    expect(env.USERPROFILE).toBe("/sandbox-home");
  });
});
