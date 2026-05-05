// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.2 — Spawn-to-ready integration test.
 *
 * Establishes the missing shipped-path test that hid the original v2.6.0
 * dropped-token bug. End-to-end: spawn-agent.sh DRY_RUN capture → execute
 * the inner shell prelude with claude exec replaced by an env-recording
 * stub → assert the env that "claude" would have seen.
 *
 * Three scenarios pin the prelude's behavior across the three real-world
 * vault states:
 *   A. first-spawn (no pre-existing vault) — prelude no-ops, claude env empty
 *      (daemon-side stdio FIX 2/R3 covers identity from RELAY_AGENT_NAME +
 *      vault read on first MCP call).
 *   B. re-spawn (vault has a valid token) — prelude reads + exports, claude
 *      env carries the token. Bonus: a real stdio MCP subprocess pointed at
 *      the same DB authenticates first call.
 *   C. vault corrupted (token shape rejected) — prelude refuses to export
 *      a malformed value, claude env empty (same as A; daemon-side covers).
 *
 * Test path matches shipped path: real `bin/spawn-agent.sh` subprocess for
 * DRY_RUN capture, real bash for the prelude, real `node dist/index.js`
 * stdio MCP subprocess for the bonus. NO InMemoryTransport, NO TS
 * reimplementations of the bash flow.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SPAWN_SCRIPT = path.join(REPO_ROOT, "bin", "spawn-agent.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

interface PreludeRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Capture spawn-agent.sh's assembled CMD via DRY_RUN, then strip the launch
 * tail (`cd <cwd>; claude ...`) so we can substitute a probe in its place.
 * Returns the prelude prefix only — including all `export …;` statements
 * the spawn script emits before `cd ; claude`.
 */
function capturePrelude(opts: {
  agentName: string;
  role: string;
  caps: string;
  cwd: string;
  homeRoot: string;
}): { prelude: string; rawCmd: string } {
  const dry = spawnSync(
    SPAWN_SCRIPT,
    [opts.agentName, opts.role, opts.caps, opts.cwd],
    {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        HOME: process.env.HOME || os.tmpdir(),
        PATH: process.env.PATH || "/usr/bin:/bin",
        RELAY_HOME: opts.homeRoot,
        RELAY_SPAWN_DRY_RUN: "1",
        RELAY_INSTANCE_ID: "",
        RELAY_DB_PATH: "",
      },
    },
  );
  if (dry.status !== 0) {
    throw new Error(
      `spawn-agent.sh DRY_RUN exited ${dry.status}\nstderr: ${dry.stderr}\nstdout: ${dry.stdout}`,
    );
  }
  const cmdLine = (dry.stdout || "").split("\n").find((l) => l.startsWith("CMD="));
  if (!cmdLine) {
    throw new Error(`No CMD= line in DRY_RUN output:\n${dry.stdout}`);
  }
  const rawCmd = cmdLine.replace(/^CMD=/, "");
  // Strip everything from the first `cd ` onwards — that's the launch tail.
  // What's before is the prelude prefix (export statements + vault read).
  const cdIdx = rawCmd.indexOf("cd ");
  if (cdIdx < 0) {
    throw new Error(`No 'cd ' launch tail in CMD: ${rawCmd}`);
  }
  return {
    prelude: rawCmd.slice(0, cdIdx).trim(),
    rawCmd,
  };
}

/**
 * Execute the captured prelude in an isolated bash shell with a probe that
 * prints RELAY_AGENT_TOKEN. Crucially, NO RELAY_AGENT_TOKEN is in the
 * inherited env — the only way the var becomes set is via the prelude's
 * vault read.
 */
function runPreludeProbe(prelude: string): PreludeRunResult {
  const probe = `${prelude} printenv RELAY_AGENT_TOKEN || true`;
  const r = spawnSync("bash", ["-lc", probe], {
    encoding: "utf-8",
    timeout: 5000,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      // explicitly NO RELAY_AGENT_TOKEN
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const KNOWN_GOOD_TOKEN = "Spawn2Ready_Test_Token-v2-6-2.abcd";
const KNOWN_BAD_TOKEN = "has whitespace and won't pass shape regex";

describe("v2.6.2 — spawn-to-ready integration (vault state matrix)", () => {
  // macOS-only: spawn-agent.sh is the macOS launcher. Linux + Windows
  // equivalents are tested via spawn-drivers.test.ts (string-construction)
  // and would need their own integration harness on those platforms.
  it.skipIf(process.platform !== "darwin")(
    "(SR-A) first-spawn (no vault present) → prelude no-ops, claude env empty (daemon FIX 2/R3 will cover)",
    () => {
      const ROOT = path.join(os.tmpdir(), "v2-6-2-sr-A-" + process.pid);
      if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
      fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
      try {
        // No vault file written. agents/ dir doesn't even exist.
        const { prelude, rawCmd } = capturePrelude({
          agentName: "sr-a-agent",
          role: "builder",
          caps: "build",
          cwd: "/tmp",
          homeRoot: ROOT,
        });
        // The prelude SHOULD reference the agents/sr-a-agent.token vault
        // path (a literal absolute path resolved on the parent side).
        expect(rawCmd).toContain("sr-a-agent.token");
        // Probe shows env empty because the file doesn't exist.
        const r = runPreludeProbe(prelude);
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe("");
      } finally {
        fs.rmSync(ROOT, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "(SR-B) re-spawn (valid vault present) → prelude exports, claude env has the vault token",
    () => {
      const ROOT = path.join(os.tmpdir(), "v2-6-2-sr-B-" + process.pid);
      if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
      fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
      try {
        const vaultDir = path.join(ROOT, "agents");
        fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(vaultDir, "sr-b-agent.token"),
          KNOWN_GOOD_TOKEN + "\n",
          { mode: 0o600 },
        );
        const { prelude } = capturePrelude({
          agentName: "sr-b-agent",
          role: "builder",
          caps: "build",
          cwd: "/tmp",
          homeRoot: ROOT,
        });
        const r = runPreludeProbe(prelude);
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(KNOWN_GOOD_TOKEN);
      } finally {
        fs.rmSync(ROOT, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "(SR-C) corrupted vault (shape regex rejects) → prelude refuses to export, claude env empty",
    () => {
      const ROOT = path.join(os.tmpdir(), "v2-6-2-sr-C-" + process.pid);
      if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
      fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
      try {
        const vaultDir = path.join(ROOT, "agents");
        fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
        // The bad token contains spaces — fails the prelude's shape regex.
        fs.writeFileSync(
          path.join(vaultDir, "sr-c-agent.token"),
          KNOWN_BAD_TOKEN + "\n",
          { mode: 0o600 },
        );
        const { prelude } = capturePrelude({
          agentName: "sr-c-agent",
          role: "builder",
          caps: "build",
          cwd: "/tmp",
          homeRoot: ROOT,
        });
        const r = runPreludeProbe(prelude);
        expect(r.status).toBe(0);
        // Prelude shape-validates against /^[A-Za-z0-9_=.-]{8,128}$/ before
        // export. The bad token fails the regex → no export → env empty.
        expect(r.stdout.trim()).toBe("");
      } finally {
        fs.rmSync(ROOT, { recursive: true, force: true });
      }
    },
  );

  // --- Bonus: full daemon authentication using the env hydrated by the prelude ---
  // Pins the END-TO-END story: spawn launches, prelude exports token, the
  // FIRST MCP call from a stdio subprocess pointed at the same daemon DB
  // authenticates from that env alone. Closes the v2.6.0 dropped-token
  // failure mode at the wire surface.
  it.skipIf(process.platform !== "darwin")(
    "(SR-D) bonus: env hydrated by prelude → stdio MCP subprocess authenticates first call",
    async () => {
      const ROOT = path.join(os.tmpdir(), "v2-6-2-sr-D-" + process.pid);
      if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
      fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
      const PORT = 39430;
      expect(fs.existsSync(DIST_INDEX)).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } = require("child_process") as typeof import("child_process");
      let agentToken: string;

      // Phase 1 — spawn an HTTP daemon transient, register sr-d-agent, capture token, kill.
      const httpChild = spawn("node", [DIST_INDEX], {
        env: {
          ...process.env,
          RELAY_TRANSPORT: "http",
          RELAY_HTTP_PORT: String(PORT),
          RELAY_HTTP_HOST: "127.0.0.1",
          RELAY_HOME: ROOT,
          RELAY_DB_PATH: path.join(ROOT, "relay.db"),
          RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
          RELAY_AGENT_TOKEN: "",
          RELAY_AGENT_NAME: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          try {
            const r = await fetch(`http://127.0.0.1:${PORT}/health`);
            if (r.ok) break;
          } catch {
            /* not up */
          }
          await new Promise((res) => setTimeout(res, 100));
        }
        const body = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "register_agent",
            arguments: { name: "sr-d-agent", role: "tester", capabilities: [] },
          },
        };
        const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
        const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
        const rpc = JSON.parse(payload);
        const inner = JSON.parse(rpc.result.content[0].text);
        expect(inner.success).toBe(true);
        agentToken = inner.agent_token;
        expect(agentToken).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      } finally {
        httpChild.kill("SIGTERM");
        await new Promise((res) => setTimeout(res, 200));
        try { httpChild.kill("SIGKILL"); } catch { /* */ }
      }

      // Settle for DB lock release.
      await new Promise((res) => setTimeout(res, 200));

      // Phase 2 — write the token to the vault (simulating what the
      // SessionStart hook would have done after register_agent).
      const vaultDir = path.join(ROOT, "agents");
      fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(vaultDir, "sr-d-agent.token"), agentToken! + "\n", { mode: 0o600 });

      // Phase 3 — run spawn-agent.sh DRY_RUN, capture prelude, exec it to
      // hydrate env, then exec a stdio MCP subprocess in that env.
      const { prelude } = capturePrelude({
        agentName: "sr-d-agent",
        role: "builder",
        caps: "build",
        cwd: "/tmp",
        homeRoot: ROOT,
      });
      // Confirm the prelude actually hydrates env locally first (sanity).
      const probe = runPreludeProbe(prelude);
      expect(probe.stdout.trim()).toBe(agentToken!);

      // Phase 4 — stdio MCP subprocess inheriting the same env path.
      // Compose the env directly (the prelude is bash; we already know it
      // exports RELAY_AGENT_TOKEN to the value of the vault file). The
      // assertion is: the daemon authenticates THIS env on first call.
      const stdioChild = spawn("node", [DIST_INDEX], {
        env: {
          ...process.env,
          RELAY_TRANSPORT: "stdio",
          RELAY_HOME: ROOT,
          RELAY_DB_PATH: path.join(ROOT, "relay.db"),
          RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
          RELAY_AGENT_NAME: "sr-d-agent",
          RELAY_AGENT_TOKEN: agentToken!, // what the prelude would have exported
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        let outBuf = "";
        const responses: any[] = [];
        stdioChild.stdout!.on("data", (chunk: Buffer) => {
          outBuf += chunk.toString("utf-8");
          let idx;
          while ((idx = outBuf.indexOf("\n")) !== -1) {
            const line = outBuf.slice(0, idx).trim();
            outBuf = outBuf.slice(idx + 1);
            if (line) {
              try { responses.push(JSON.parse(line)); } catch { /* */ }
            }
          }
        });
        async function awaitId(id: number, timeoutMs: number): Promise<any> {
          const t0 = Date.now();
          while (Date.now() - t0 < timeoutMs) {
            const r = responses.find((x) => x.id === id);
            if (r) return r;
            await new Promise((res) => setTimeout(res, 50));
          }
          throw new Error(`timeout waiting for id ${id}`);
        }
        stdioChild.stdin!.write(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sr-d-test", version: "0" } },
        }) + "\n");
        await awaitId(1, 5000);
        stdioChild.stdin!.write(JSON.stringify({
          jsonrpc: "2.0", method: "notifications/initialized", params: {},
        }) + "\n");
        // health_check WITH no explicit token in args — env is the only source.
        stdioChild.stdin!.write(JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "health_check", arguments: {} },
        }) + "\n");
        const callResp = await awaitId(2, 5000);
        const inner = JSON.parse(callResp.result.content[0].text);
        // Auth succeeded → token_validated:true with agent_name.
        expect(inner.status).toBe("ok");
        expect(inner.token_validated).toBe(true);
        expect(inner.agent_name).toBe("sr-d-agent");
        expect(inner.auth_state).toBe("active");
      } finally {
        stdioChild.kill("SIGTERM");
        await new Promise((res) => setTimeout(res, 200));
        try { stdioChild.kill("SIGKILL"); } catch { /* */ }
        fs.rmSync(ROOT, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
