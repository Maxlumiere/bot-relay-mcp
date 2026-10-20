// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22 (security/invariants.json): the relay's security subprocesses run by an ABSOLUTE trusted path, never one
 * found through PATH. This gate's first catch (windows-2022, 13 Oct): the installed daemon ran `whoami /user` BY NAME,
 * so under Git Bash Git's GNU whoami answered, the SID was unreadable, and the daemon refused its own registration
 * secret; a planted whoami could report any SID to the owner-only checks.
 *
 * Here, on the INSTALLED daemon (Windows): with Git's usr/bin first on its PATH, and with a PLANTED whoami printing a
 * forged SID first on its PATH, it still accepts its own registration secret (the owner-only checks read the real SID).
 * The observable is the register itself: a by-name lookup reads null or the forged SID, the owner check then fails,
 * and the secret is refused. POSIX is not covered (the SEC-22 POSIX follow-up: see the registry's not_yet).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, afterEach } from "vitest";
import { installed, sandbox, startHttpDaemon, type HttpDaemon, type Sandbox } from "./_installed.js";

const daemons: HttpDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
});

const FORGED_SID = "S-1-5-21-1-2-3-4242";

/** The sandbox's PATH (Windows spells it `Path`), with `dir` first. */
function prependPath(sb: Sandbox, dir: string): void {
  const key = Object.keys(sb.env).find((k) => k.toLowerCase() === "path") ?? "Path";
  sb.env[key] = `${dir};${sb.env[key] ?? ""}`;
}

/**
 * Start the installed daemon in `sb`; assert its owner-only checks passed (/health `mint` is "secret": "unavailable"
 * is what a null or forged SID gives, with its `mint_fault`); then register a NEW name over HTTP with its own secret.
 */
async function startAndRegister(sb: Sandbox, name: string): Promise<{ r: Record<string, unknown>; d: HttpDaemon }> {
  const d = await startHttpDaemon(sb);
  daemons.push(d);
  const health = (await (await fetch(`${d.baseUrl}/health`)).json()) as { mint?: string; mint_fault?: unknown };
  expect(health.mint, `/health mint (fault: ${JSON.stringify(health.mint_fault)}); daemon stderr: ${d.stderr().slice(-1500)}`).toBe("secret");
  const r = await d.rpc("register_agent", { name, role: "worker", capabilities: [] }, d.mintHeaders());
  return { r, d };
}

describe("SEC-22: the installed daemon's SID never comes from a PATH-found whoami (Windows)", () => {
  // A RUNTIME skip, never describe.skipIf: `vitest list` drops tests under a skipIf'd describe, and the registry
  // meta-test resolves test ids through that list (see sec-04.release.ts).
  it("SEC-22.T1 HARM Git Bash's PATH (GNU whoami first): the installed daemon still accepts its own registration secret", async (ctx) => {
    if (process.platform !== "win32") ctx.skip("SEC-22 is enforced on Windows only (POSIX: the SEC-22 follow-up)");
    const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
    expect(fs.existsSync(path.join(gitUsrBin, "whoami.exe")), "precondition: the runner has Git's GNU whoami").toBe(true);
    const sb = sandbox("s22-git");
    prependPath(sb, gitUsrBin);
    // Control: by name, this PATH finds the GNU whoami, which refuses `/user`, or the harm below proves nothing.
    const byName = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8", env: sb.env });
    expect(byName.stdout, `by name on this PATH, whoami gave no SID (stderr: ${byName.stderr})`).not.toMatch(/S-1-\d/);
    const { r, d } = await startAndRegister(sb, "sec22-git");
    expect(r.success, `${JSON.stringify(r)} daemon stderr: ${d.stderr().slice(-1500)}`).toBe(true);
    expect(typeof r.agent_token).toBe("string");
  });

  it("SEC-22.T1 HARM a PLANTED whoami first on PATH, printing a forged SID: the installed daemon ignores it, accepts its own secret, and still refuses a wrong one", async (ctx) => {
    if (process.platform !== "win32") ctx.skip("SEC-22 is enforced on Windows only (POSIX: the SEC-22 follow-up)");
    const sb = sandbox("s22-plant");
    const dir = fs.mkdtempSync(path.join(installed().work, "plant-"));
    fs.copyFileSync(process.execPath, path.join(dir, "whoami.exe")); // a real exe named whoami...
    const forge = path.join(dir, "forge.cjs"); // ...that prints a forged SID before node parses its arguments.
    // NODE_OPTIONS reaches the daemon too (it is node): the forge acts only in a process started AS whoami.
    fs.writeFileSync(
      forge,
      `if (/^whoami(\\.exe)?$/i.test(require("path").basename(process.execPath))) { process.stdout.write('"planted\\\\user","${FORGED_SID}"\\r\\n'); process.exit(0); }\n`,
    );
    expect(forge, "a scratch path with no spaces (NODE_OPTIONS splits on them)").not.toMatch(/\s/);
    prependPath(sb, dir);
    sb.env.NODE_OPTIONS = `${sb.env.NODE_OPTIONS ?? ""} --require ${forge}`.trim();
    // Control: by name, this sandbox's env runs the plant, or the harm below proves nothing.
    const byName = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8", env: sb.env });
    expect(byName.stdout, "the planted whoami answers by name").toContain(FORGED_SID);
    const { r, d } = await startAndRegister(sb, "sec22-plant");
    expect(r.success, `${JSON.stringify(r)} daemon stderr: ${d.stderr().slice(-1500)}`).toBe(true);
    expect(typeof r.agent_token).toBe("string");
    // TWIN: the gate is not simply open under this PATH: a WRONG secret is still refused, with no token.
    const wrong = await d.rpc("register_agent", { name: "sec22-plant-wrong", role: "worker", capabilities: [] }, { "X-Relay-Secret": "not-the-secret" });
    expect(wrong.agent_token, JSON.stringify(wrong)).toBeUndefined();
    expect(wrong.error_code, JSON.stringify(wrong)).toBe("MINT_SECRET_REQUIRED");
  });
});
