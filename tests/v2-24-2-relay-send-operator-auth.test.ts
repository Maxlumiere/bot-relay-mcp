// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR B / ADR-0006 — the `relay send` P1 (codex reject of #142@1665cb3).
 *
 * #142 made /api/send-message an operator endpoint (operatorAuthCheck) behind the
 * global csrfCheck. The real `relay send` CLI presents Bearer but performs no
 * browser CSRF handshake, so it began exiting on 403 CSRF and delivering zero
 * rows — severing the operator's own CLI channel. TWO fixes:
 *   1. csrfCheck exempts EXPLICIT-credential requests (Authorization / ?auth);
 *      CSRF is an ambient-cookie defence and a Bearer request never rides the
 *      cookie (dashboardAuthCheck precedence: a wrong header 401s, no fallthrough).
 *   2. send.ts resolves the OPERATOR secret via the shared resolveDashboardSecret
 *      (reads dashboard_secret), not http_secret (the removed escalation / 4th copy).
 *
 * ADR-0015 harm + twin through the REAL shipped path: the real `dist/cli/send.js`
 * binary against a real `dist/index.js` daemon with a fresh dashboard_secret in the
 * config FILE (so the fourth-resolver fix is exercised — no RELAY_DASHBOARD_SECRET
 * env). Twin = a row is delivered; Harm = a cookie-only POST still 403s (browser
 * CSRF intact).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const BIN_RELAY = path.join(REPO_ROOT, "bin", "relay"); // the real CLI entry point (dispatches to dist/cli/send.js)
const DASHBOARD_SECRET = "relay-send-test-dashboard-secret-0123456789ab"; // >= 32

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

async function rpc(port: number, name: string, args: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await resp.text();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const payload = line ? line.slice(5).trim() : text.trim();
  const outer = JSON.parse(payload);
  const inner = outer.result?.content?.[0]?.text;
  return inner ? JSON.parse(inner) : outer;
}

function httpReq(
  port: number,
  method: string,
  p: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<{ status: number; setCookie: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string | number> = { ...headers };
    if (body != null) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(body); }
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        const sc = res.headers["set-cookie"] || [];
        resolve({ status: res.statusCode ?? 0, setCookie: Array.isArray(sc) ? sc : [sc], body: b });
      });
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

describe("v2.24.2 — relay send survives operator-auth (ADR-0006 P1)", () => {
  it("the REAL `relay send` binary delivers through the operator gate; a cookie-only POST still 403s", async () => {
    const { spawn } = require("child_process") as typeof import("child_process");
    expect(fs.existsSync(DIST_INDEX)).toBe(true);
    expect(fs.existsSync(BIN_RELAY)).toBe(true);

    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-24-2-relay-send-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const CONFIG_PATH = path.join(ROOT, "config.json");
    // dashboard_secret lives in the config FILE — no RELAY_DASHBOARD_SECRET env —
    // so the CLI's resolveDashboardSecret must read cfg.dashboard_secret (the 4th
    // resolver). http_secret is absent, proving http_secret is not what authorizes.
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ transport: "http", http_port: PORT, http_host: "127.0.0.1", dashboard_secret: DASHBOARD_SECRET }),
      { mode: 0o600 },
    );

    const daemonEnv = {
      ...process.env,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(PORT),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: ROOT,
      RELAY_DB_PATH: path.join(ROOT, "relay.db"),
      RELAY_CONFIG_PATH: CONFIG_PATH,
      RELAY_AGENT_TOKEN: "",
      RELAY_AGENT_NAME: "",
      RELAY_DASHBOARD_SECRET: "", // force the daemon onto config.dashboard_secret too
    };
    const child = spawn("node", [DIST_INDEX], { env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
    let daemonErr = "";
    child.stderr.on("data", (d: Buffer) => { daemonErr += d.toString(); });

    try {
      await waitForHealth(PORT, 8000);

      // register sender + receiver over /mcp (agent transport — no dashboard secret needed).
      const senderReg = await rpc(PORT, "register_agent", { name: "sender", role: "worker", capabilities: [] });
      const senderToken: string = senderReg.agent_token || senderReg.token;
      expect(typeof senderToken, JSON.stringify(senderReg)).toBe("string");
      await rpc(PORT, "register_agent", { name: "receiver", role: "worker", capabilities: [] });

      // TWIN — the real CLI binary. Bearer, no CSRF handshake, dashboard_secret
      // read from the config file. Must deliver.
      const runSend = (): Promise<{ code: number; stderr: string; stdout: string }> =>
        new Promise((resolve) => {
          const p = spawn("node", [BIN_RELAY, "send", "receiver", "hello via the real CLI", "--from", "sender"], {
            env: {
              ...process.env,
              RELAY_HOME: ROOT,
              RELAY_CONFIG_PATH: CONFIG_PATH,
              RELAY_HTTP_PORT: String(PORT),
              RELAY_HTTP_HOST: "127.0.0.1",
              RELAY_AGENT_TOKEN: senderToken, // explicit sender token path
              RELAY_AGENT_NAME: "",
              RELAY_DASHBOARD_SECRET: "", // NOT provided by env — must come from cfg
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let se = "";
          let so = "";
          p.stderr.on("data", (d: Buffer) => { se += d.toString(); });
          p.stdout.on("data", (d: Buffer) => { so += d.toString(); });
          p.on("close", (code) => resolve({ code: code ?? -1, stderr: se, stdout: so }));
        });

      const sendResult = await runSend();
      expect(sendResult.code, `relay send should exit 0; stderr: ${sendResult.stderr}`).toBe(0);

      // The row actually landed — read the daemon's SQLite directly (get_messages
      // is mailbox-auth; the DB is the ground truth). No encryption key set → the
      // content column is plaintext, so we grep it verbatim.
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const db = new Database(path.join(ROOT, "relay.db"), { readonly: true });
      const all = db.prepare("SELECT from_agent, to_agent, content FROM messages").all() as Array<{ from_agent: string; to_agent: string; content: string }>;
      db.close();
      const found = all.find((m) => m.content === "hello via the real CLI");
      expect(found, `messages table dump: ${JSON.stringify(all)} | send stdout: ${sendResult.stdout}`).toBeDefined();
      expect(found!.from_agent).toBe("sender");
      expect(found!.to_agent).toBe("receiver");

      // HARM — a cookie-authenticated POST WITHOUT the CSRF header must still 403.
      // Authenticate to mint the relay_dashboard_auth cookie, then POST with ONLY
      // that cookie (no Authorization, no X-Relay-CSRF): the ambient-cookie path
      // the exemption must NOT open.
      const auth = await httpReq(PORT, "GET", "/dashboard", { Authorization: `Bearer ${DASHBOARD_SECRET}` }, null);
      let authCookie = "";
      for (const line of auth.setCookie) {
        const m = line.match(/^relay_dashboard_auth=([^;]+)/);
        if (m) authCookie = `relay_dashboard_auth=${m[1]}`;
      }
      expect(authCookie).not.toBe("");
      const cookieOnlyPost = await httpReq(
        PORT,
        "POST",
        "/api/send-message",
        { Cookie: authCookie }, // ambient cookie only — no Authorization, no CSRF header
        JSON.stringify({ from: "sender", to: "receiver", content: "csrf attempt", from_agent_token: senderToken }),
      );
      expect(cookieOnlyPost.status, "cookie-only POST without CSRF must stay refused").toBe(403);
      expect(cookieOnlyPost.body).toContain("CSRF");
    } finally {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 500);
      try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 30000);
});
