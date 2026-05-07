// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.4 — regression coverage for the check-relay.sh agent_token capture
 * regex bug.
 *
 * THE BUG (caught 2026-05-06 on news-intel-build's first spawn against a
 * v2.6.0-LIVE daemon): the daemon serves MCP-over-HTTP responses in
 * SSE-wrapped + JSON-stringified format. Inner JSON has escaped quotes
 * (`\"`) and pretty-print spaces after colons (`\": `). Pre-v2.6.4
 * check-relay.sh patterns expected unescaped/unspaced JSON
 * (`"agent_token":"<token>"`) and silently never matched. Vault was never
 * written on first spawn; daemon-side stdio fallback (v2.6.1 R3) couldn't
 * help because the vault had no token to read.
 *
 * v2.6.2 SR-D test claimed to cover this end-to-end but used JSON.parse()
 * in TypeScript (native parsing, handles SSE+escape correctly) and wrote
 * the vault from TS test code — bypassing the bash hook's grep/sed
 * extraction entirely. Test path did NOT match shipped path. This file
 * closes that gap by invoking the actual `hooks/check-relay.sh` as a
 * subprocess against a real HTTP daemon and asserting the vault is
 * written by the hook (NOT by test code).
 *
 * Test path matches shipped path: real `hooks/check-relay.sh` invocation,
 * real `node dist/index.js` HTTP daemon, real curl-style fetch from
 * inside the bash hook. Per memory/feedback_test_path_must_match_shipped_path.md.
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
const HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
}

describe("v2.6.4 — check-relay.sh agent_token extraction (real HTTP daemon SSE response)", () => {
  it("(T1) first spawn: hook calls register_agent via HTTP, captures agent_token from SSE-wrapped response, writes vault", async () => {
    // Pin the EXACT bug class news-intel-build hit. Pre-v2.6.4 this would
    // fail because the bash grep pattern expected unescaped JSON.
    const PORT = 39450;
    const ROOT = path.join(os.tmpdir(), "v2-6-4-hook-extract-T1-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(ROOT, "agents"), { recursive: true, mode: 0o700 });
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");
    const daemon = spawn("node", [DIST_INDEX], {
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
      await waitForHealth(PORT, 5000);

      // Phase 1 — DB needs to exist for the hook's `if [ ! -f "$DB_PATH" ]; then exit 0; fi`
      // gate to pass. The daemon's first health_check has already created the DB.
      const dbPath = path.join(ROOT, "relay.db");
      expect(fs.existsSync(dbPath)).toBe(true);

      // Phase 2 — invoke the actual hook with no pre-existing token. The
      // hook should: probe health_check (no token, so no auth_error),
      // call register_agent over HTTP, parse the SSE-wrapped response with
      // its grep/sed pipeline, write the vault file.
      const agentName = "v264-hook-target";
      const r = spawnSync("bash", [HOOK], {
        encoding: "utf-8",
        timeout: 8000,
        env: {
          HOME: ROOT,
          PATH: process.env.PATH || "/usr/bin:/bin",
          RELAY_HOME: ROOT,
          RELAY_AGENT_NAME: agentName,
          RELAY_AGENT_ROLE: "tester",
          RELAY_AGENT_CAPABILITIES: "",
          RELAY_DB_PATH: dbPath,
          RELAY_HTTP_HOST: "127.0.0.1",
          RELAY_HTTP_PORT: String(PORT),
          RELAY_HOOK_DEBUG: "1",
        },
        input: "",
      });
      // Hook exits 0 on the happy path (empty stdout when no mail).
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Phase 3 — vault file must exist with a valid token shape (the
      // bug under test was: pre-v2.6.4 hook's grep silently failed on the
      // SSE-escape format, vault was never written even though
      // register_agent succeeded).
      const vaultFile = path.join(ROOT, "agents", `${agentName}.token`);
      expect(fs.existsSync(vaultFile), `vault file missing — extraction regex still broken? stderr: ${r.stderr}`).toBe(true);
      const vaultContent = fs.readFileSync(vaultFile, "utf-8").trim();
      expect(vaultContent).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);

  it("(T2) re-spawn with valid token in env: hook does NOT re-register (skip path), vault is preserved", async () => {
    // Confirms the SKIP_REGISTER branch works correctly with the new
    // regex. When agent already exists in DB AND env token is valid, the
    // hook does not touch the daemon's register_agent. Vault is preserved
    // (in this test, vault was written by phase 0 below).
    const PORT = 39451;
    const ROOT = path.join(os.tmpdir(), "v2-6-4-hook-extract-T2-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(ROOT, "agents"), { recursive: true, mode: 0o700 });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");
    const daemon = spawn("node", [DIST_INDEX], {
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
      await waitForHealth(PORT, 5000);

      // Phase 0 — register the agent + capture token via direct fetch
      // (mirroring what a prior session would have done).
      const dbPath = path.join(ROOT, "relay.db");
      const agentName = "v264-respawn-target";
      const regBody = {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "register_agent",
          arguments: { name: agentName, role: "tester", capabilities: [] },
        },
      };
      const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(regBody),
      });
      const text = await resp.text();
      const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
      const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
      const rpc = JSON.parse(payload);
      const inner = JSON.parse(rpc.result.content[0].text);
      const validToken = inner.agent_token;
      expect(validToken).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);

      const vaultFile = path.join(ROOT, "agents", `${agentName}.token`);
      fs.writeFileSync(vaultFile, validToken + "\n", { mode: 0o600 });
      const before = fs.readFileSync(vaultFile, "utf-8");

      // Phase 1 — invoke the hook with valid env-token (mirrors what the
      // launching shell prelude exports on re-spawn).
      const r = spawnSync("bash", [HOOK], {
        encoding: "utf-8",
        timeout: 8000,
        env: {
          HOME: ROOT,
          PATH: process.env.PATH || "/usr/bin:/bin",
          RELAY_HOME: ROOT,
          RELAY_AGENT_NAME: agentName,
          RELAY_AGENT_ROLE: "tester",
          RELAY_AGENT_CAPABILITIES: "",
          RELAY_DB_PATH: dbPath,
          RELAY_HTTP_HOST: "127.0.0.1",
          RELAY_HTTP_PORT: String(PORT),
          RELAY_AGENT_TOKEN: validToken,
        },
        input: "",
      });
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Vault file must still exist + content unchanged (re-register skip
      // means no fresh mint, no overwrite).
      expect(fs.existsSync(vaultFile)).toBe(true);
      const after = fs.readFileSync(vaultFile, "utf-8");
      expect(after).toBe(before);
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);

  it("(T3) recovery flow: revoked token in env + recovery_token, hook detects auth_error + recovery_pending, re-registers, vault gets fresh token", async () => {
    // Pre-v2.6.4 the auth_error grep at line 134 ALSO had the SSE-escape
    // bug — it never matched, so the recovery branch was silently dead
    // even when the operator set RELAY_RECOVERY_TOKEN. This test pins
    // the FULL recovery cycle through the bash hook.
    const PORT = 39452;
    const ROOT = path.join(os.tmpdir(), "v2-6-4-hook-extract-T3-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(ROOT, "agents"), { recursive: true, mode: 0o700 });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");
    const daemon = spawn("node", [DIST_INDEX], {
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

    async function rpc(args: any, headers: Record<string, string> = {}): Promise<any> {
      const allHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      };
      const body = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name: args.name, arguments: args.arguments },
      };
      const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
      const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
      const rpcResp = JSON.parse(payload);
      const inner = rpcResp.result?.content?.[0]?.text;
      return inner ? JSON.parse(inner) : rpcResp;
    }

    try {
      await waitForHealth(PORT, 5000);
      const dbPath = path.join(ROOT, "relay.db");

      // Phase 0 — register admin + target.
      const adminReg = await rpc({
        name: "register_agent",
        arguments: { name: "v264-admin-T3", role: "admin", capabilities: ["admin"] },
      });
      const adminToken = adminReg.agent_token;

      const target = "v264-recover-target";
      const targetReg = await rpc({
        name: "register_agent",
        arguments: { name: target, role: "tester", capabilities: [] },
      });
      const oldToken = targetReg.agent_token;

      // Phase 1 — admin revokes target with issue_recovery=true.
      const revoked = await rpc(
        {
          name: "revoke_token",
          arguments: { target_agent_name: target, revoker_name: "v264-admin-T3", issue_recovery: true },
        },
        { "X-Agent-Token": adminToken },
      );
      expect(revoked.success).toBe(true);
      const recoveryToken = revoked.recovery_token;
      expect(recoveryToken).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      // Vault was scrubbed by revoke_token (v2.6.2 R1 behavior); the hook
      // path will write a fresh entry on successful recovery.
      const vaultFile = path.join(ROOT, "agents", `${target}.token`);
      expect(fs.existsSync(vaultFile)).toBe(false);

      // Phase 2 — invoke the hook with the stale token in env + recovery
      // token set. Hook should: health_check returns auth_error +
      // auth_state=recovery_pending → recovery branch fires → register
      // with recovery_token → recovery_completed:true → extract NEW_TOKEN
      // from response → write vault.
      const r = spawnSync("bash", [HOOK], {
        encoding: "utf-8",
        timeout: 10_000,
        env: {
          HOME: ROOT,
          PATH: process.env.PATH || "/usr/bin:/bin",
          RELAY_HOME: ROOT,
          RELAY_AGENT_NAME: target,
          RELAY_AGENT_ROLE: "tester",
          RELAY_AGENT_CAPABILITIES: "",
          RELAY_DB_PATH: dbPath,
          RELAY_HTTP_HOST: "127.0.0.1",
          RELAY_HTTP_PORT: String(PORT),
          RELAY_AGENT_TOKEN: oldToken, // stale, daemon will return auth_error
          RELAY_RECOVERY_TOKEN: recoveryToken,
        },
        input: "",
      });
      // Recovery happy path → exit 0 + stderr line "Recovery completed".
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);
      expect(r.stderr).toMatch(/Recovery completed/);

      // Vault file MUST exist now with a fresh token (NOT the old or
      // recovery token).
      expect(fs.existsSync(vaultFile)).toBe(true);
      const vaultContent = fs.readFileSync(vaultFile, "utf-8").trim();
      expect(vaultContent).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      expect(vaultContent).not.toBe(oldToken);
      expect(vaultContent).not.toBe(recoveryToken);
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);

  // v2.6.4 R1 — codex residual note: extraction regex was `[A-Za-z0-9_=.-]+`
  // (any length), while write_relay_token_to_vault validates the same charset
  // with `{8,128}` length bounds (mirrors src/token-store.ts:67 TOKEN_SHAPE_RE).
  // The contract was inconsistent — extraction would match a malformed short
  // token, then vault-write would reject it. Aligning the extraction regex
  // to the same length bounds removes the inconsistency at the extraction
  // layer (refuse what vault-write would refuse, before the round-trip).
  //
  // Test path matches shipped path: extracts the actual grep + sed regex
  // bytes from the shipped hooks/check-relay.sh and pipes synthetic SSE
  // fixtures through them via bash. No regex re-implementation in TS — a
  // drift between this test and the shipped hook surfaces as a real failure.
  it("(T4) tightened {8,128} regex rejects below-min tokens, accepts valid 43-char tokens — pinned at EVERY agent_token extraction site (codex residual #1 + R2 walk-analogous)", () => {
    // R2 fix (codex msg 8ccd2702): pre-R2 this test pinned only the L292
    // REG_TOKEN line; the L174 NEW_TOKEN line could silently drift back
    // to `[A-Za-z0-9_=.-]+` and T4 would still pass. R2 generalizes the
    // drift guard + boundary cases to scan ALL `grep -oE.*agent_token`
    // lines in the shipped hook (currently L174 + L292; auto-catches any
    // future N+1 site without test updates). Same scope-too-narrow
    // pattern as v2.6.2 R1 → R2 (cmd.exe → wt.exe powershell gate) and
    // v2.6.4 R0 → R1 (the auth_error/auth_state/recovery_completed
    // analogous patterns) — applied here to the test layer too.
    //
    // Test path matches shipped path: regex bytes come from hooks/check-relay.sh
    // directly (read at test load + extracted via JS regex match), not a TS
    // re-implementation. Drift between this test and the shipped hook
    // surfaces as a real failure pointing at the offending file:line.
    const hookSrc = fs.readFileSync(HOOK, "utf-8");

    // Scan ALL agent_token extraction lines. Currently L174 (NEW_TOKEN
    // recovery flow) + L292 (REG_TOKEN register flow); future N+1 sites
    // get covered automatically.
    const lines = hookSrc.split("\n");
    interface ExtractionSite {
      lineNum: number;        // 1-indexed
      lineText: string;
      grepPat: string;
      sedPat: string;
    }
    const sites: ExtractionSite[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/grep -oE.*agent_token/.test(line)) continue;
      const grepMatch = line.match(/grep -oE '([^']+)'/);
      const sedMatch = line.match(/sed -E '([^']+)'/);
      // Both grep + sed must be on the same line per the shipped one-line
      // pipeline form `grep -oE '...' | head -1 | sed -E '...'`. If the
      // shipped hook ever switches to multi-line (highly unlikely), this
      // assertion surfaces it loudly.
      expect(grepMatch, `hooks/check-relay.sh:${i + 1} agent_token line missing grep -oE pattern`).toBeTruthy();
      expect(sedMatch, `hooks/check-relay.sh:${i + 1} agent_token line missing sed -E pattern (expected one-line pipeline)`).toBeTruthy();
      sites.push({
        lineNum: i + 1,
        lineText: line.trim(),
        grepPat: grepMatch![1],
        sedPat: sedMatch![1],
      });
    }

    // Sanity: at least the 2 known sites (L174 + L292). If a future
    // refactor consolidates both into one helper function, this drops to
    // 1 — that's a good outcome and the `>= 1` floor would still catch
    // the contract drift.
    expect(sites.length, "expected at least 2 agent_token extraction sites (L174 + L292) — refactor consolidation? scope shrink?").toBeGreaterThanOrEqual(2);

    // Drift guard — every extraction site MUST enforce {8,128} length
    // bounds in BOTH the grep -oE pattern AND the sed -E substitution.
    // Per-site failure message points at the exact offending file:line.
    for (const site of sites) {
      expect(
        site.grepPat,
        `hooks/check-relay.sh:${site.lineNum} grep -oE pattern must enforce {8,128} length bounds (matches src/token-store.ts:67 TOKEN_SHAPE_RE). Line: ${site.lineText}`,
      ).toContain("{8,128}");
      expect(
        site.sedPat,
        `hooks/check-relay.sh:${site.lineNum} sed -E pattern must enforce {8,128} length bounds. Line: ${site.lineText}`,
      ).toContain("{8,128}");
    }

    // Helper: run an extraction pipeline against a synthetic input. The
    // grep + sed bytes come from the EXTRACTED ExtractionSite — not a TS
    // copy — so a regression in either L174 or L292 fails the matching
    // boundary cases below.
    function runExtraction(site: ExtractionSite, sseBody: string): string {
      const r = spawnSync(
        "bash",
        [
          "-c",
          'echo "$INPUT" | grep -oE "$GREP_PAT" | head -1 | sed -E "$SED_PAT"',
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            INPUT: sseBody,
            GREP_PAT: site.grepPat,
            SED_PAT: site.sedPat,
          },
        },
      );
      return (r.stdout ?? "").trim();
    }

    // Synthetic SSE-wrapped MCP response with a token of the given value.
    // The escape sequence `\\\"agent_token\\\": \\\"<token>\\\"` in the
    // JS string literal is the bytes `\"agent_token\": \"<token>\"`
    // (backslash + quote pairs) on the wire — exactly what the bash
    // regex matches against (verified against live :3777 in v2.6.4 R0).
    function makeSse(token: string): string {
      return (
        `event: message\n` +
        `data: {"result":{"content":[{"type":"text","text":"{\\"agent_token\\": \\"${token}\\"}"}]},"jsonrpc":"2.0","id":1}`
      );
    }

    // Boundary cases run against EVERY extraction site. Same 4 cases per
    // site (originally pinned at L292 only in R1; R2 walks the analogous
    // surface to L174 too).
    const validToken = "kZIqxolWc9rYZaCURCcWxNnNnbBFqK7-UFAirnDJ5Jc"; // 43-char base64url
    expect(validToken).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);

    for (const site of sites) {
      const ctx = `hooks/check-relay.sh:${site.lineNum}`;
      // 3-char (well below minimum) — original brief case, must reject.
      expect(runExtraction(site, makeSse("abc")), `${ctx}: 3-char token must be rejected`).toBe("");
      // 7-char (one below minimum, boundary-1) — must reject.
      expect(runExtraction(site, makeSse("abc1234")), `${ctx}: 7-char token (boundary-1) must be rejected`).toBe("");
      // 8-char (at minimum, boundary) — must accept.
      expect(runExtraction(site, makeSse("abc12345")), `${ctx}: 8-char token (boundary) must be accepted`).toBe("abc12345");
      // Valid 43-char base64url shape (positive control, real token shape).
      expect(runExtraction(site, makeSse(validToken)), `${ctx}: valid 43-char token must be accepted`).toBe(validToken);
    }
  });
});
