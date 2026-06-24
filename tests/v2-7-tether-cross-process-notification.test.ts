// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 / Tether Phase 3d — cross-process notification delivery test.
 *
 * Pre-v2.7 the inbox-changed event bus (src/inbox-events.ts) was a
 * module-local Node EventEmitter. A message written by a stdio terminal
 * (its own OS process) emitted ONLY inside that stdio process and never
 * woke a subscriber connected to the separate HTTP daemon — the Tether
 * VSCode extension's symptom from v0.1.0 smoke + Phase 2 broadcast-trace
 * proof that the daemon's `[broadcast-trace] event emit` line never fired
 * when stdio writers committed.
 *
 * v2.7 Phase 3 fix:
 *   - Producers INSERT a durable row into `inbox_events` inside the same
 *     SQLite tx as the message/broadcast row (src/db.ts).
 *   - The HTTP daemon runs an outbox tail (src/outbox-tail.ts) that polls
 *     `inbox_events` past an in-memory cursor and dispatches each row to
 *     `broadcastInboxChange` in src/mcp-subscriptions.ts.
 *   - That same broadcaster is called by the in-process bus; dedup by
 *     event id ensures same-process sender+subscriber get exactly one
 *     notification.
 *
 * Test plan:
 *   1. CROSS-PROCESS: spawn HTTP daemon, subscribe via MCP, have a
 *      separate node child write directly to the shared DB
 *      (`inbox_events` + `messages`) — mimics what a stdio MCP terminal
 *      does. Assert subscriber receives notification within the poll
 *      interval. Walk all 3 reasons (message_received, message_read,
 *      broadcast_received).
 *   2. SAME-PROCESS DEDUP: subscribe via MCP, call `send_message` via
 *      MCP (writer + reader both in HTTP daemon). The in-process bus
 *      fires synchronously; the tail catches up moments later. Assert
 *      EXACTLY ONE notification — proves the dedup map in
 *      `broadcastInboxChange` works.
 *
 * Test path matches shipped path: real `node dist/index.js` subprocess
 * for the daemon, real `StreamableHTTPClientTransport`, real
 * `better-sqlite3` direct writes from the child to mimic a stdio
 * process — the test exercises the real shipped path.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { getFreePort } from "./_helpers/port.js";
import cp from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
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
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
}

async function waitForCount(
  arr: unknown[],
  atLeast: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && arr.length < atLeast) {
    await new Promise((res) => setTimeout(res, 25));
  }
}

interface DaemonHandle {
  proc: cp.ChildProcessWithoutNullStreams;
  port: number;
  dbPath: string;
  root: string;
  stderr: () => string;
  kill: () => Promise<void>;
}

async function startDaemon(label: string, pollMs = 50): Promise<DaemonHandle> {
  const PORT = await getFreePort();
  const ROOT = path.join(os.tmpdir(), `v2-7-tether-xproc-${label}-${process.pid}-${Date.now()}`);
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const dbPath = path.join(ROOT, "relay.db");

  expect(
    fs.existsSync(DIST_INDEX),
    `missing ${DIST_INDEX} — run \`npm run build\` first`,
  ).toBe(true);

  const proc = cp.spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(PORT),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: ROOT,
      RELAY_DB_PATH: dbPath,
      RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
      RELAY_AGENT_TOKEN: "",
      RELAY_AGENT_NAME: "",
      // Fast poll for test speed; production default is 100ms.
      RELAY_OUTBOX_POLL_MS: String(pollMs),
      // v2.7.0 — the per-event dedup-skip + notify trace lines were
      // downgraded to debug as part of Phase 2 log cleanup. The "mixed
      // traffic" assertion below asserts dedup-skip appeared in stderr,
      // so surface debug-level lines for this test.
      RELAY_LOG_LEVEL: "debug",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf-8");
  });

  await waitForHealth(PORT, 8000);

  return {
    proc,
    port: PORT,
    dbPath,
    root: ROOT,
    stderr: () => stderrBuf,
    kill: async () => {
      proc.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { proc.kill("SIGKILL"); } catch { /* */ }
      try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/**
 * Run a small node child against the daemon's RELAY_DB_PATH that writes
 * directly via better-sqlite3 — the same pattern tests/concurrent.test.ts
 * uses. The script INSERTs ONE row into `messages` + ONE row into
 * `inbox_events`, mimicking the tx in sendMessage's normal path. The
 * daemon's outbox-tail is expected to pick the row up.
 *
 * Returns the child's exit code + stderr so failures are debuggable.
 */
async function writeFromAnotherProcess(
  dbPath: string,
  toAgent: string,
  fromAgent: string,
  reason: "message_received" | "message_read" | "broadcast_received",
): Promise<{ code: number | null; stderr: string }> {
  const childScript = `
    const Database = require('better-sqlite3');
    const crypto = require('crypto');
    const dbPath = process.argv[process.argv.length - 1];
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const to = ${JSON.stringify(toAgent)};
    const from = ${JSON.stringify(fromAgent)};
    const reason = ${JSON.stringify(reason)};
    const tx = db.transaction(() => {
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, 'cross-process probe', 'normal', 'pending', datetime('now'))"
      ).run(id, from, to);
      db.prepare(
        "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, ?, datetime('now'), ?)"
      ).run(to, reason, process.pid);
    });
    tx();
    db.close();
  `;

  return new Promise((resolve, reject) => {
    const child = cp.spawn(
      process.execPath,
      ["--input-type=commonjs", "-e", childScript, "--", dbPath],
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stderr }));
    child.on("error", reject);
  });
}

describe("v2.7 / Tether Phase 3d — cross-process notification delivery", () => {
  it("subscriber on HTTP daemon receives notification when a DIFFERENT process writes to shared DB", async () => {
    const daemon = await startDaemon("xproc", 50);
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp`),
      );
      const client = new Client(
        { name: "v2-7-tether-xproc-test", version: "0.0.0" },
        { capabilities: {} },
      );
      const notifications: { uri: string }[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        notifications.push({ uri: n.params.uri });
      });

      try {
        await client.connect(transport);
        // Register the recipient inside the daemon process so the agent
        // row exists when the child writes. (Cross-process write is to
        // `messages` + `inbox_events`; agent registration is the
        // out-of-band step the daemon needs.)
        await client.callTool({
          name: "register_agent",
          arguments: { name: "xproc-target", role: "tester", capabilities: [] },
        });
        await client.subscribeResource({ uri: "relay://inbox/xproc-target" });

        // Walk all three reasons. After each, wait for at least one new
        // notification, then snapshot the URI and clear notifications for
        // the next round so reason-by-reason we observe delivery.
        for (const reason of ["message_received", "broadcast_received", "message_read"] as const) {
          notifications.length = 0;
          const w = await writeFromAnotherProcess(
            daemon.dbPath,
            "xproc-target",
            "external-writer",
            reason,
          );
          expect(w.code, `child writer failed for reason=${reason}: ${w.stderr}`).toBe(0);
          await waitForCount(notifications, 1, 3000);
          expect(
            notifications.length,
            `no notification for reason=${reason} within 3s; daemon stderr tail:\n${daemon.stderr().slice(-2000)}`,
          ).toBeGreaterThanOrEqual(1);
          expect(notifications[0].uri).toBe("relay://inbox/xproc-target");
        }

        // Daemon stderr should show the tail-sourced fanout for at least one of
        // the cross-process events (tail is the only path that could deliver
        // them, since the writer was in a different process).
        const stderrBuf = daemon.stderr();
        expect(
          /\[broadcast-trace\] fanout enter source=tail/.test(stderrBuf),
          `expected at least one tail-sourced fanout line; got:\n${stderrBuf.slice(-2000)}`,
        ).toBe(true);
      } finally {
        try { await client.close(); } catch { /* */ }
      }
    } finally {
      await daemon.kill();
    }
  }, 25_000);

  it("same-process sender + subscriber gets EXACTLY ONE notification per send_message (dedup)", async () => {
    const daemon = await startDaemon("dedup", 50);
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp`),
      );
      const client = new Client(
        { name: "v2-7-tether-dedup-test", version: "0.0.0" },
        { capabilities: {} },
      );
      const notifications: { uri: string }[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        notifications.push({ uri: n.params.uri });
      });

      try {
        await client.connect(transport);
        const reg = await client.callTool({
          name: "register_agent",
          arguments: { name: "dedup-target", role: "tester", capabilities: [] },
        });
        const regInner = JSON.parse((reg.content as { text: string }[])[0].text);
        expect(regInner.success).toBe(true);
        const targetToken = regInner.agent_token;

        await client.subscribeResource({ uri: "relay://inbox/dedup-target" });

        // Single send via MCP. Bus fires synchronously inside the daemon
        // process (subscribe + send share the daemon's process and thus
        // its in-process bus). The outbox tail also runs in this process;
        // it polls every 50ms.
        const send = await client.callTool({
          name: "send_message",
          arguments: {
            from: "dedup-target",
            to: "dedup-target",
            content: "dedup probe",
            agent_token: targetToken,
          },
        });
        const sendInner = JSON.parse((send.content as { text: string }[])[0].text);
        expect(sendInner.success).toBe(true);

        // Wait for at least one notification, then keep waiting several
        // poll intervals so the tail has every chance to (incorrectly)
        // re-broadcast. If dedup works end-to-end (either via the
        // event-id high-water map OR SQLite's data_version skip for same-
        // connection writes — both are valid same-process dedup
        // mechanisms), count stays at 1.
        await waitForCount(notifications, 1, 2000);
        expect(notifications.length).toBeGreaterThanOrEqual(1);
        await new Promise((res) => setTimeout(res, 400)); // ~8 poll intervals
        expect(
          notifications.length,
          `expected exactly 1 notification (dedup); got ${notifications.length}.\nDaemon stderr:\n${daemon.stderr().slice(-2500)}`,
        ).toBe(1);

        // Confirm the bus actually fired (the user-observable success path
        // for same-process). The tail's behavior here is implementation-
        // dependent: SQLite's PRAGMA data_version does NOT bump for writes
        // made by the same connection, so the tail's cheap-skip will often
        // prevent the SELECT from even running in this scenario. The
        // event-id dedup map in mcp-subscriptions is the defense-in-depth
        // mechanism that catches the multi-connection case (e.g. another
        // process writes between two same-process writes). The
        // cross-process test in this file exercises that path explicitly.
        const stderrBuf = daemon.stderr();
        expect(
          /\[broadcast-trace\] fanout enter source=bus/.test(stderrBuf),
          "expected bus-sourced fanout to have fired",
        ).toBe(true);
      } finally {
        try { await client.close(); } catch { /* */ }
      }
    } finally {
      await daemon.kill();
    }
  }, 25_000);

  it("mixed traffic — external writer bumps data_version, tail dedups same-process row by id", async () => {
    const daemon = await startDaemon("mixed", 50);
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp`),
      );
      const client = new Client(
        { name: "v2-7-tether-mixed-test", version: "0.0.0" },
        { capabilities: {} },
      );
      const notifications: { uri: string }[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        notifications.push({ uri: n.params.uri });
      });

      try {
        await client.connect(transport);
        const reg = await client.callTool({
          name: "register_agent",
          arguments: { name: "mixed-target", role: "tester", capabilities: [] },
        });
        const regInner = JSON.parse((reg.content as { text: string }[])[0].text);
        expect(regInner.success).toBe(true);
        const targetToken = regInner.agent_token;

        await client.subscribeResource({ uri: "relay://inbox/mixed-target" });

        // Same-process send: bus fires synchronously, event_id=1.
        const send = await client.callTool({
          name: "send_message",
          arguments: {
            from: "mixed-target",
            to: "mixed-target",
            content: "mixed-traffic same-process probe",
            agent_token: targetToken,
          },
        });
        const sendInner = JSON.parse((send.content as { text: string }[])[0].text);
        expect(sendInner.success).toBe(true);
        await waitForCount(notifications, 1, 2000);
        expect(notifications.length).toBe(1);

        // External writer commits a row for an UNRELATED agent. That bumps
        // data_version (different connection) so the tail's next tick
        // WILL run a SELECT. The SELECT returns BOTH inbox_events rows
        // (id=1 for mixed-target written by the daemon, id=2 for unrelated
        // written by the child). The tail attempts to broadcast id=1 →
        // dedup-skip (last_broadcast_id_by_uri = 1 from the bus). It
        // attempts to broadcast id=2 → no subscriber, silent. The
        // subscriber for mixed-target should still have exactly 1
        // notification — proving dedup-by-id works.
        const w = await writeFromAnotherProcess(
          daemon.dbPath,
          "unrelated-agent",
          "external-writer",
          "message_received",
        );
        expect(w.code, `child writer failed: ${w.stderr}`).toBe(0);

        await new Promise((res) => setTimeout(res, 400)); // ~8 poll intervals
        expect(
          notifications.length,
          `expected exactly 1 notification after mixed traffic; got ${notifications.length}.\nDaemon stderr:\n${daemon.stderr().slice(-3000)}`,
        ).toBe(1);

        // Now the tail MUST have run + must have dedup-skipped the
        // same-process row id=1.
        const stderrBuf = daemon.stderr();
        expect(
          /\[broadcast-trace\] dedup-skip source=tail/.test(stderrBuf),
          `expected tail to dedup-skip the same-process row. Daemon stderr:\n${stderrBuf.slice(-3000)}`,
        ).toBe(true);
      } finally {
        try { await client.close(); } catch { /* */ }
      }
    } finally {
      await daemon.kill();
    }
  }, 25_000);
});
