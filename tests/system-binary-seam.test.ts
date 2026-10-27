// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The TEST-ONLY system-tool seam (tests/_helpers/system-binary-seam.cjs) still BITES the relay's own code after SEC-22
 * moved its tools to absolute paths, and does nothing else. Driven through the BUILT relay (dist/liveness.js, the
 * module `relay watch` runs) in a child process, as the INV-LIVE-01 watch tests use it:
 *   - TWIN: no seam → the child reads its own real start;
 *   - BITES: the seam maps the trusted `ps` path to a failing script → the start is "unreadable" (never "gone");
 *   - NARROW: a key that is not the trusted path changes nothing;
 *   - LOUD: a malformed or relative map is refused on stderr, and no seam applies.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { systemBinarySeamEnv, systemBinarySeamPath } from "./_helpers/system-binary-seam-env.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVENESS = pathToFileURL(path.join(REPO, "dist", "liveness.js")).href;
const POSIX = process.platform === "darwin" || process.platform === "linux";

/** A child that loads the BUILT relay and reads its OWN start (processStartedAt), with `env` extra. */
function childStart(env: Record<string, string>): { start: unknown; stderr: string } {
  const code = `const m = await import(${JSON.stringify(LIVENESS)}); process.stdout.write(JSON.stringify(m.processStartedAt(process.pid)));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf-8", env: { ...process.env, ...env }, timeout: 30_000 });
  expect(r.status, `child: ${r.stderr}`).toBe(0);
  return { start: JSON.parse(r.stdout), stderr: r.stderr };
}
const withSeam = (map: Record<string, string> | string) => systemBinarySeamEnv(map);

describe("the test-only system-tool seam (SEC-22)", () => {
  it("TWIN no seam: the built relay reads the child's real start", (ctx) => {
    if (!POSIX) ctx.skip("POSIX start reads");
    expect(fs.existsSync(fileURLToPath(LIVENESS)), "precondition: dist/ is built").toBe(true);
    expect((childStart({}).start as { kind: string }).kind).toBe("start");
  });

  it("BITES the seam maps the TRUSTED ps path to a failing script: the start is unreadable, never gone", async (ctx) => {
    if (!POSIX) ctx.skip("POSIX start reads");
    expect(systemBinarySeamPath(), "a path with no spaces (NODE_OPTIONS splits on them)").not.toMatch(/\s/);
    const { systemBinary } = await import("../src/system-binary.js");
    const trustedPs = systemBinary("ps");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ps-"));
    const failing = path.join(dir, "ps");
    fs.writeFileSync(failing, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = childStart(withSeam({ [trustedPs]: failing }));
    expect(r.start, r.stderr).toMatchObject({ kind: "unreadable" });
  });

  it("NARROW a key that is not the trusted path changes nothing", (ctx) => {
    if (!POSIX) ctx.skip("POSIX start reads");
    expect((childStart(withSeam({ "/nonexistent/ps": "/bin/false" })).start as { kind: string }).kind).toBe("start");
  });

  it("LOUD a relative or malformed map is refused on stderr, and no seam applies", (ctx) => {
    if (!POSIX) ctx.skip("POSIX start reads");
    const rel = childStart(withSeam({ ps: "/bin/false" }));
    expect(rel.stderr).toMatch(/both sides must be absolute paths: no seam/);
    expect((rel.start as { kind: string }).kind).toBe("start");
    const bad = childStart(withSeam("{not json"));
    expect(bad.stderr).toMatch(/is not JSON .*: no seam/);
  });
});
