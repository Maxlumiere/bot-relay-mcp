// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20: a REVOKED agent's token authorizes nothing.
 *
 * A revoke keeps the agent's token hash (for forensics), so the token still MATCHES; only the row's
 * auth_state makes it invalid. Every consumer that checked the hash alone let a revoked agent act:
 *   - /api/send-message (what `relay send` POSTs to) verified the from-token's hash and sent the message;
 *   - `relay mint-token` / stableMintOrReuse returned a revoked agent's vault token as "reused";
 *   - the `relay send` and `relay resolve` local pre-checks accepted it.
 * One authorizer (auth.ts authorizeAgentToken: the state-aware authenticateAgent, then revalidate's
 * predicate) now decides for all of them. tests/sec-20-verify-sites.test.ts pins that no other code path
 * calls the hash check directly.
 *
 * HARM and TWIN run the REAL `relay send` binary and the REAL dist daemon; the in-process cases pin
 * the authorizer's states and the mint-reuse path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { getFreePort } from "./_helpers/port.js";
import { mintHeaders } from "./_helpers/mint.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_INDEX = path.join(REPO, "dist", "index.js");
const BIN_RELAY = path.join(REPO, "bin", "relay");
const DASHBOARD_SECRET = "sec-20-test-dashboard-secret-0123456789abcdef";

async function rpc(port: number, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await resp.text();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const outer = JSON.parse(line ? line.slice(5).trim() : text.trim());
  const inner = outer.result?.content?.[0]?.text;
  return inner ? JSON.parse(inner) : outer;
}

function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health" }, (r) => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(400, () => req.destroy());
    };
    const retry = (): void => {
      if (Date.now() - start > timeoutMs) return reject(new Error("daemon not healthy in time"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe("SEC-20 through the REAL daemon and the REAL `relay send`", () => {
  let port: number;
  let root: string;
  let configPath: string;
  let dbPath: string;
  let daemon: ReturnType<typeof spawn>;
  const tokens: Record<string, string> = {};

  const sendAs = (from: string, token: string, content: string): Promise<{ code: number; stderr: string }> =>
    new Promise((resolve) => {
      const p = spawn("node", [BIN_RELAY, "send", "receiver", content, "--from", from], {
        env: { ...process.env, RELAY_HOME: root, RELAY_CONFIG_PATH: configPath, RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1", RELAY_AGENT_TOKEN: token, RELAY_AGENT_NAME: "", RELAY_DASHBOARD_SECRET: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let se = "";
      p.stderr.on("data", (d: Buffer) => (se += d.toString()));
      p.on("close", (code) => resolve({ code: code ?? -1, stderr: se }));
    });
  const rowsFrom = (from: string): number => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_agent = ?").get(from) as { n: number }).n;
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    expect(fs.existsSync(DIST_INDEX), "run `npm run build` first").toBe(true);
    port = await getFreePort();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sec-20-"));
    configPath = path.join(root, "config.json");
    dbPath = path.join(root, "relay.db");
    fs.writeFileSync(configPath, JSON.stringify({ transport: "http", http_port: port, http_host: "127.0.0.1", dashboard_secret: DASHBOARD_SECRET }), { mode: 0o600 });
    daemon = spawn("node", [DIST_INDEX], {
      env: { ...process.env, RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1", RELAY_HOME: root, RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: configPath, RELAY_AGENT_TOKEN: "", RELAY_AGENT_NAME: "", RELAY_DASHBOARD_SECRET: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHealth(port, 10_000);
    for (const [name, caps] of [["admin", ["admin"]], ["receiver", []], ["revoked-with-recovery", []], ["revoked-terminal", []], ["active-twin", []]] as const) {
      const r = await rpc(port, "register_agent", { name, role: "worker", capabilities: caps }, mintHeaders(dbPath));
      expect(typeof r.agent_token, JSON.stringify(r)).toBe("string");
      tokens[name] = r.agent_token as string;
    }
    for (const [target, issue_recovery] of [["revoked-with-recovery", true], ["revoked-terminal", false]] as const) {
      const r = await rpc(port, "revoke_token", { target_agent_name: target, revoker_name: "admin", agent_token: tokens.admin, issue_recovery });
      expect(r.success, JSON.stringify(r)).toBe(true);
    }
  }, 60_000);

  afterAll(async () => {
    daemon?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    try {
      daemon?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("TWIN: an ACTIVE agent sends through `relay send` (exit 0, the row lands)", async () => {
    const r = await sendAs("active-twin", tokens["active-twin"], "twin");
    expect(r.code, r.stderr).toBe(0);
    expect(rowsFrom("active-twin")).toBe(1);
  });

  it("HARM: revoked WITH a recovery token (recovery_pending): `relay send` with its old token is refused, AUTH_FAILED, NO row", async () => {
    const r = await sendAs("revoked-with-recovery", tokens["revoked-with-recovery"], "should never land");
    expect(r.code, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/AUTH_FAILED|revoked|recovery/i);
    expect(rowsFrom("revoked-with-recovery")).toBe(0);
  });

  it("HARM: revoked for good (terminal): `relay send` with its old token is refused, AUTH_FAILED, NO row", async () => {
    const r = await sendAs("revoked-terminal", tokens["revoked-terminal"], "should never land either");
    expect(r.code, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/AUTH_FAILED|revoked/i);
    expect(rowsFrom("revoked-terminal")).toBe(0);
  });

  it("HARM: the operator endpoint itself (Bearer) refuses a revoked from-token with 403 AUTH_FAILED", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DASHBOARD_SECRET}` },
      body: JSON.stringify({ from: "revoked-terminal", to: "receiver", content: "direct", from_agent_token: tokens["revoked-terminal"] }),
    });
    const json = (await res.json()) as { error_code?: string };
    expect(res.status).toBe(403);
    expect(json.error_code).toBe("AUTH_FAILED");
    expect(rowsFrom("revoked-terminal")).toBe(0);
  });
});

describe("SEC-20 in process: the authorizer and the local consumers", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sec-20-inproc-"));
  const saved = { home: process.env.RELAY_HOME, db: process.env.RELAY_DB_PATH, cfg: process.env.RELAY_CONFIG_PATH };
  let db: typeof import("../src/db.js");
  let auth: typeof import("../src/authorize-token.js");
  let reuse: typeof import("../src/mint-reuse.js");
  let store: typeof import("../src/token-store.js");

  beforeAll(async () => {
    process.env.RELAY_HOME = ROOT;
    process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
    process.env.RELAY_CONFIG_PATH = path.join(ROOT, "config.json");
    db = await import("../src/db.js");
    auth = await import("../src/authorize-token.js");
    reuse = await import("../src/mint-reuse.js");
    store = await import("../src/token-store.js");
    await db.initializeDb();
  });
  afterAll(() => {
    db.closeDb();
    fs.rmSync(ROOT, { recursive: true, force: true });
    for (const [k, v] of [["RELAY_HOME", saved.home], ["RELAY_DB_PATH", saved.db], ["RELAY_CONFIG_PATH", saved.cfg]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("authorizeAgentToken: ACTIVE + its token → ok (current); a wrong token → refused", async () => {
    const t = db.mintAgentToken("az-active", "w", []).plaintext_token;
    const ok = await auth.authorizeAgentToken("az-active", t);
    expect(ok.ok).toBe(true);
    const bad = await auth.authorizeAgentToken("az-active", "not-the-token-0000000000000000");
    expect(bad.ok).toBe(false);
  });

  it("authorizeAgentToken: REVOKED (terminal) and RECOVERY_PENDING rows refuse their own still-matching token", async () => {
    const t1 = db.mintAgentToken("az-revoked", "w", []).plaintext_token;
    const t2 = db.mintAgentToken("az-recovery", "w", []).plaintext_token;
    db.revokeAgentToken("az-revoked", { issueRecovery: false });
    db.revokeAgentToken("az-recovery", { issueRecovery: true });
    for (const [name, tok] of [["az-revoked", t1], ["az-recovery", t2]] as const) {
      const r = await auth.authorizeAgentToken(name, tok);
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.reason, name).toMatch(/revoked|recovery/i);
    }
  });

  it("authorizeAgentToken: during rotation_grace both the new and the previous token authorize; a revoke during grace refuses BOTH", async () => {
    const old = db.mintAgentToken("az-grace", "w", []).plaintext_token;
    db.getDb().prepare("UPDATE agents SET managed = 1 WHERE name = ?").run("az-grace"); // grace applies to managed agents only
    const rot = db.rotateAgentTokenAdmin("az-grace", { graceSeconds: 300 });
    expect([rot.agentClass, rot.graceExpiresAt === null]).toEqual(["managed", false]); // precondition: a grace window is open
    const fresh = rot.newPlaintextToken;
    expect((await auth.authorizeAgentToken("az-grace", fresh)).ok).toBe(true);
    expect((await auth.authorizeAgentToken("az-grace", old)).ok).toBe(true);
    db.revokeAgentToken("az-grace", { issueRecovery: false });
    expect((await auth.authorizeAgentToken("az-grace", fresh)).ok).toBe(false);
    expect((await auth.authorizeAgentToken("az-grace", old)).ok).toBe(false);
  });

  it("RACE: a revoke that lands WHILE the token is being verified is refused by the post-await revalidate (the state check already passed)", async () => {
    const { _onNextCompareForTests } = await import("../src/bcrypt-pool.js");
    const t = db.mintAgentToken("az-race", "w", []).plaintext_token;
    let fired = false;
    _onNextCompareForTests(() => {
      fired = true;
      db.revokeAgentToken("az-race", { issueRecovery: false });
    });
    try {
      const r = await auth.authorizeAgentToken("az-race", t);
      expect(fired, "precondition: the revoke landed during the compare").toBe(true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal).toBe("revoked");
    } finally {
      _onNextCompareForTests(null);
    }
  });

  it("health_check (Codex #315 R1 P2): a revoke landing while the token is LOCATED is reported revoked, never valid, and nothing is stamped", async () => {
    const { _onNextCompareForTests } = await import("../src/bcrypt-pool.js");
    const { handleHealthCheck } = await import("../src/tools/status.js");
    const t = db.mintAgentToken("hc-race", "w", []).plaintext_token;
    let fired = false;
    _onNextCompareForTests(() => {
      fired = true;
      db.revokeAgentToken("hc-race", { issueRecovery: false });
    });
    try {
      const res = await handleHealthCheck({ agent_token: t } as never);
      const body = JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as { auth_error?: boolean; auth_error_reason?: string; auth_state?: string };
      expect(fired, "precondition: the revoke landed during the compare").toBe(true);
      expect([body.auth_error, body.auth_state]).toEqual([true, "revoked"]);
      expect(body.auth_error_reason).toMatch(/revoked/i);
      expect((db.getDb().prepare("SELECT first_authed_at FROM agents WHERE name = ?").get("hc-race") as { first_authed_at: string | null }).first_authed_at).toBeNull();
    } finally {
      _onNextCompareForTests(null);
    }
  });

  it("stableMintOrReuse: a REVOKED agent's authenticating vault token is NOT reused (reported revoked)", async () => {
    const created = await reuse.stableMintOrReuse("mr-revoked", "w", []);
    expect(created.status).toBe("created");
    const vault = await store.defaultTokenStore().read("mr-revoked");
    expect(vault).toBeTruthy();
    db.revokeAgentToken("mr-revoked", { issueRecovery: false });
    const r = await reuse.stableMintOrReuse("mr-revoked", "w", []);
    expect(r.status).toBe("revoked");
    expect("token" in r).toBe(false);
  });

  it("`relay mint-token --force` (forceRotateAndVault) REFUSES a revoked or recovery_pending row, pointing to `relay recover`; the row is unchanged", async () => {
    for (const [name, issueRecovery, state] of [["fm-revoked", false, "revoked"], ["fm-recovery", true, "recovery_pending"]] as const) {
      db.mintAgentToken(name, "w", []);
      db.revokeAgentToken(name, { issueRecovery });
      const before = db.getDb().prepare("SELECT auth_state, token_hash, revoked_at FROM agents WHERE name = ?").get(name);
      await expect(reuse.forceRotateAndVault(name, "w", []), name).rejects.toThrow(/relay recover/);
      // ...and it names the RIGHT way back: a recovery_pending agent also has its revoker-issued recovery token.
      await expect(reuse.forceRotateAndVault(name, "w", []), name).rejects.toThrow(state === "recovery_pending" ? /awaiting recovery[\s\S]*recovery token/ : /is revoked: /);
      expect(() => db.mintAgentToken(name, "w", [], { force: true }), name).toThrow(/revoked|recovery/);
      const after = db.getDb().prepare("SELECT auth_state, token_hash, revoked_at FROM agents WHERE name = ?").get(name) as { auth_state: string };
      expect(after, name).toEqual(before);
      expect(after.auth_state).toBe(state);
    }
  });

  it("N1 (Codex #315 R2): a revoke committed BETWEEN mint --force's read and its write is never overwritten (both revoke kinds)", async () => {
    for (const [name, issueRecovery, state] of [["cas-revoked", false, "revoked"], ["cas-recovery", true, "recovery_pending"]] as const) {
      db.mintAgentToken(name, "w", []);
      let fired = false;
      db._onMintBeforeWriteForTests(() => {
        fired = true;
        db.revokeAgentToken(name, { issueRecovery });
      });
      try {
        expect(() => db.mintAgentToken(name, "w", [], { force: true }), name).toThrow(state === "recovery_pending" ? /awaiting recovery/ : /is revoked: /);
      } finally {
        db._onMintBeforeWriteForTests(null);
      }
      expect(fired, `${name}: precondition, the revoke landed between the read and the write`).toBe(true);
      expect((db.getDb().prepare("SELECT auth_state FROM agents WHERE name = ?").get(name) as { auth_state: string }).auth_state, name).toBe(state);
    }
  });

  it("TWIN: `relay mint-token --force` on an ACTIVE row still rotates (a new token that authorizes; the old one does not)", async () => {
    const old = db.mintAgentToken("fm-active", "w", []).plaintext_token;
    const f = await reuse.forceRotateAndVault("fm-active", "w", []);
    expect((await auth.authorizeAgentToken("fm-active", f.token)).ok).toBe(true);
    expect((await auth.authorizeAgentToken("fm-active", old)).ok).toBe(false);
  });

  it("TWIN: an ACTIVE agent's authenticating vault token is still reused", async () => {
    await reuse.stableMintOrReuse("mr-active", "w", []);
    const r = await reuse.stableMintOrReuse("mr-active", "w", []);
    expect(r.status).toBe("reused");
  });
});
