// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * scripts/lib/entrypoint.mjs — the shared "am I being run directly?" check.
 *
 * Driven through REAL subprocesses, because the defect only exists in how node fills
 * argv[1] and import.meta.url for a real run:
 *   - a path containing a SPACE → "main" (it ran);
 *   - the same file through a SYMLINKED DIRECTORY → "main" (the old checks said no and
 *     exited 0 silently);
 *   - imported by another program → "imported" (stays quiet, exit 0);
 *   - a different file with the SAME NAME as argv[1] → "mismatch": nothing runs, the
 *     reason is printed, exit code 2.
 * The per-guard integration lives in tests/release-guards-symlink-entrypoint.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const HELPER = path.join(REPO_ROOT, "scripts", "lib", "entrypoint.mjs");
const HELPER_URL = pathToFileURL(HELPER).href;

const SCRATCH = path.join(fs.realpathSync(os.tmpdir()), `relay-entrypoint-${process.pid}`);
const SPACED_DIR = path.join(SCRATCH, "dir with space");
const LINK_DIR = path.join(SCRATCH, "link-to-spaced"); // symlink → SPACED_DIR
const PROBE_NAME = "probe-entry.mjs";
const PROBE = path.join(SPACED_DIR, PROBE_NAME);
const IMPORTER = path.join(SCRATCH, "importer.mjs");
const LOOKALIKE = path.join(SCRATCH, "elsewhere", PROBE_NAME); // same name, different file

function run(script: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [script], { encoding: "utf-8", timeout: 30_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SPACED_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOOKALIKE), { recursive: true });
  // The probe reports what the helper decided, and whether its "main" body ran.
  fs.writeFileSync(
    PROBE,
    `import { entrypointStatus, isDirectRun } from ${JSON.stringify(HELPER_URL)};\n` +
      `process.stdout.write("status=" + entrypointStatus(import.meta.url) + "\\n");\n` +
      `if (isDirectRun(import.meta.url)) process.stdout.write("RAN\\n");\n`,
  );
  const probeUrl = JSON.stringify(pathToFileURL(PROBE).href);
  fs.writeFileSync(IMPORTER, `await import(${probeUrl});\n`);
  fs.writeFileSync(LOOKALIKE, `await import(${probeUrl});\n`);
  fs.symlinkSync(SPACED_DIR, LINK_DIR, "dir");
});

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("scripts/lib/entrypoint.mjs — decided from a real node run", () => {
  it("a path containing a space → main, and the body runs", () => {
    const r = run(PROBE);
    expect(r.stdout, r.stderr).toContain("status=main");
    expect(r.stdout).toContain("RAN");
    expect(r.status).toBe(0);
  });

  it("the same file through a symlinked directory → main, and the body runs", () => {
    const r = run(path.join(LINK_DIR, PROBE_NAME));
    expect(r.stdout, r.stderr).toContain("status=main");
    expect(r.stdout).toContain("RAN");
    expect(r.status).toBe(0);
  });

  it("imported by another program → imported, the body stays quiet, exit 0", () => {
    const r = run(IMPORTER);
    expect(r.stdout, r.stderr).toContain("status=imported");
    expect(r.stdout).not.toContain("RAN");
    expect(r.status).toBe(0);
  });

  it("a different file with the same name as argv[1] → mismatch: nothing runs, reason printed, exit 2", () => {
    const r = run(LOOKALIKE);
    expect(r.stdout, r.stderr).toContain("status=mismatch");
    expect(r.stdout).not.toContain("RAN");
    expect(r.stderr).toMatch(/could not be confirmed/);
    expect(r.status).toBe(2);
  });

  it("no argv[1] at all → imported", async () => {
    // A literal specifier: the #212 parser-pin gate must be able to prove it is not the
    // bumpable typescript (a computed one is undecidable and fails that gate).
    const { entrypointStatus } = await import("../scripts/lib/entrypoint.mjs");
    expect(entrypointStatus(pathToFileURL(PROBE).href, undefined)).toBe("imported");
  });
});
