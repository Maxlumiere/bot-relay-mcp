// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Release guards must RUN when invoked through a symlinked path.
 *
 * Seven scripts decide "am I being run directly?" by comparing `argv[1]` with
 * `import.meta.url`: six guards with `path.resolve(argv[1]) === fileURLToPath(...)`,
 * and verify-native-binary with `pathToFileURL(argv[1]).href === import.meta.url`.
 * `import.meta.url` is symlink-RESOLVED; `argv[1]` is not. So through a symlinked
 * directory (on the maintainer Mac, ~/bot-relay-mcp is one) main() never runs and the
 * guard exits 0 with no output: a release gate that PASSES without checking anything.
 *
 * MEASURED on origin/main 6980f93 (no args, real path vs the same file through a
 * symlinked directory):
 *   agent-class, auth-gen, sanctioned-mutation, secret-register: rc 2 + usage → rc 0, silent
 *   shipped-content, verify-native-binary: rc 0 + output              → rc 0, silent
 *   prebuild-guard: rc 0 + silent on BOTH with no args, so it is driven from a cwd that
 *   carries the `.relay-prod-tree` sentinel, where it must refuse with rc 1.
 *
 * The contract: a run through the symlinked path behaves EXACTLY like the run through
 * the real path (same exit code; output present or absent alike). A control first proves
 * each real-path run is LOUD (non-zero exit or output), so "both silent" can never pass
 * as equality.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

// A private scratch area. os.tmpdir() may itself be a symlink on macOS, so resolve it
// once: the ONLY symlink in play must be the one this test creates.
const SCRATCH = path.join(fs.realpathSync(os.tmpdir()), `relay-guard-symlink-${process.pid}`);
const LINK_ROOT = path.join(SCRATCH, "repo-link"); // symlink → REPO_ROOT
const HOME_DIR = path.join(SCRATCH, "home");
const PROD_CWD = path.join(SCRATCH, "prod-tree"); // carries .relay-prod-tree

interface Signature {
  status: number;
  loud: boolean; // any stdout or stderr at all
  detail: string;
}

function runGuard(scriptPath: string, cwd: string): Signature {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: HOME_DIR };
  // The publish environment sets this so npm publish's own prebuild is allowed; inherited
  // here it would turn prebuild-guard's refusal into an allow (tests/prebuild-guard.test.ts).
  delete env.RELAY_ALLOW_PROD_BUILD;
  const r = spawnSync("node", [scriptPath], { cwd, env, encoding: "utf-8", timeout: 60_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return {
    status: r.status ?? -1,
    loud: out.length > 0,
    detail: `rc=${r.status} bytes=${out.length} ${out.slice(0, 160).replace(/\s+/g, " ")}`,
  };
}

/** Each script, and the cwd that makes its real-path run loud. */
const GUARDS: Array<{ script: string; cwd: "repo" | "prod" }> = [
  { script: "agent-class-guard.mjs", cwd: "repo" },
  { script: "auth-gen-guard.mjs", cwd: "repo" },
  { script: "sanctioned-mutation-guard.mjs", cwd: "repo" },
  { script: "secret-register-guard.mjs", cwd: "repo" },
  { script: "shipped-content-guard.mjs", cwd: "repo" },
  { script: "verify-native-binary.mjs", cwd: "repo" },
  { script: "prebuild-guard.mjs", cwd: "prod" },
];

beforeAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(PROD_CWD, { recursive: true });
  fs.writeFileSync(path.join(PROD_CWD, ".relay-prod-tree"), "");
  fs.symlinkSync(REPO_ROOT, LINK_ROOT, "dir");
  expect(fs.realpathSync(LINK_ROOT)).toBe(REPO_ROOT);
  expect(LINK_ROOT).not.toBe(REPO_ROOT);
});

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("release guards run through a symlinked directory exactly as through the real path", () => {
  for (const g of GUARDS) {
    it(`${g.script}: symlinked run matches the real-path run`, () => {
      const realCwd = g.cwd === "prod" ? PROD_CWD : REPO_ROOT;
      const linkCwd = g.cwd === "prod" ? PROD_CWD : LINK_ROOT;

      const real = runGuard(path.join(REPO_ROOT, "scripts", g.script), realCwd);
      // Non-vacuity control: the real-path run must do something observable.
      expect(real.status !== 0 || real.loud, `control: real-path run must be loud — ${real.detail}`).toBe(true);

      const link = runGuard(path.join(LINK_ROOT, "scripts", g.script), linkCwd);
      expect(
        { status: link.status, loud: link.loud },
        `through the symlink: ${link.detail}\nreal path: ${real.detail}`,
      ).toEqual({ status: real.status, loud: real.loud });
    }, 90_000);
  }
});

describe("pre-publish-check.sh started through a symlinked directory invokes guards by their PHYSICAL path", () => {
  it("every node guard step's script path is physical, never routed through the symlink", () => {
    const gate = path.join(LINK_ROOT, "scripts", "pre-publish-check.sh");
    // Same invocation as tests/guard-wiring-coverage.test.ts reachedSteps(), but started
    // through the symlinked directory. --list-steps records each step without running it.
    const r = spawnSync("bash", [gate, "--full", "--list-steps"], {
      cwd: LINK_ROOT,
      env: { ...process.env, HOME: HOME_DIR },
      encoding: "utf-8",
      timeout: 120_000,
    });
    expect(r.status, `--list-steps failed: ${r.stderr}`).toBe(0);

    const nodeScripts = (r.stdout ?? "")
      .split("\n")
      .filter((l) => l.startsWith("list-step:"))
      .map((l) => l.slice("list-step:".length).match(/^(.*) :: cmd=(\S*) :: script=(.*)$/))
      .filter(
        (m): m is RegExpMatchArray =>
          !!m && (m[2] === "node" || m[2].endsWith("/node")) && /\.(mjs|cjs|js)$/.test(m[3].trim()),
      )
      .map((m) => m[3].trim());

    // Non-vacuity: the gate really lists node guard steps.
    expect(nodeScripts.length, "the gate must list node guard steps").toBeGreaterThan(0);

    const viaLink = nodeScripts.filter((p) => p === LINK_ROOT || p.startsWith(LINK_ROOT + path.sep));
    expect(viaLink, "guard script paths still routed through the symlinked directory").toEqual([]);
    for (const p of nodeScripts) {
      expect(p.startsWith(REPO_ROOT + path.sep), `not the physical repo path: ${p}`).toBe(true);
    }
  }, 150_000);
});
