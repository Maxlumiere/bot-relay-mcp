#!/usr/bin/env node
/**
 * bot-relay-mcp: Managed Agent reference implementation (Node, stdlib-only).
 *
 * Parallel to the Python reference — same protocol, same lifecycle, same
 * inline documentation. ~200 lines. Uses node:http only (no express, no
 * axios, no node-fetch). Read top to bottom to learn the relay protocol.
 *
 * Usage:
 *   # 1. Start the relay in HTTP mode:
 *   RELAY_TRANSPORT=http node /path/to/bot-relay-mcp/dist/index.js
 *
 *   # 2. Run this script:
 *   RELAY_HTTP_HOST=127.0.0.1 RELAY_HTTP_PORT=3777 node agent.js
 *
 *   # 3. From another terminal, send a message via the relay MCP tools.
 *
 * Environment variables:
 *   RELAY_HTTP_HOST   — relay hostname (default: 127.0.0.1)
 *   RELAY_HTTP_PORT   — relay port (default: 3777)
 *   RELAY_AGENT_NAME  — this agent's name (default: managed-node)
 *   RELAY_AGENT_ROLE  — this agent's role (default: worker)
 *   RELAY_AGENT_TOKEN — saved token from a previous registration (optional)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Configuration from environment ---

const HOST = process.env.RELAY_HTTP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.RELAY_HTTP_PORT || "3777", 10);
const NAME = process.env.RELAY_AGENT_NAME || "managed-node";
const ROLE = process.env.RELAY_AGENT_ROLE || "worker";
const CAPABILITIES = (process.env.RELAY_AGENT_CAPABILITIES || "tasks,webhooks").split(",");
let TOKEN = process.env.RELAY_AGENT_TOKEN || "";
const POLL_INTERVAL = parseInt(process.env.RELAY_POLL_INTERVAL || "5", 10) * 1000;

// v2.1 Phase 4b.2: persistent token store alongside the script by default.
// Real deployments should use a platform secrets manager instead.
const TOKEN_STORE_PATH = process.env.RELAY_AGENT_TOKEN_STORE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), ".agent-token");

function persistToken(token) {
  // Atomic write: tmp + fsync + rename. Mode 0600 matches the relay's own
  // file-perm discipline (Phase 4c.4). See docs/managed-agent-protocol.md
  // §Persist-before-ack for the ordering contract.
  const tmp = TOKEN_STORE_PATH + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, token);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, TOKEN_STORE_PATH);
}

function loadPersistedToken() {
  try {
    return fs.readFileSync(TOKEN_STORE_PATH, "utf-8").trim();
  } catch {
    return "";
  }
}

// Hydrate from persistent store if env didn't supply one.
if (!TOKEN) {
  const persisted = loadPersistedToken();
  if (persisted) {
    TOKEN = persisted;
    console.error(`[${NAME}] Restored token from ${TOKEN_STORE_PATH}.`);
  }
}

// --- JSON-RPC helper ---

function rpc(toolName, args) {
  return new Promise((resolve, reject) => {
    if (TOKEN) {
      args.agent_token = TOKEN;
    }
    const payload = JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (TOKEN) headers["X-Agent-Token"] = TOKEN;

    const req = http.request({ hostname: HOST, port: PORT, path: "/mcp", method: "POST", headers, timeout: 10000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk.toString()));
      res.on("end", () => {
        try {
          // SSE-framed: find the "data:" line.
          let dataJson = null;
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              dataJson = trimmed.slice(5).trim();
              break;
            }
          }
          if (!dataJson) dataJson = raw;
          const rpcResult = JSON.parse(dataJson);
          const innerText = rpcResult.result.content[0].text;
          resolve(JSON.parse(innerText));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}\nRaw: ${raw.slice(0, 500)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(payload);
    req.end();
  });
}

// --- Registration ---

async function register() {
  if (TOKEN) {
    // managed=true is immutable after first register but re-sending is
    // harmless (preserved). Signals intent on the dashboard.
    await rpc("register_agent", { name: NAME, role: ROLE, capabilities: CAPABILITIES, managed: true });
    console.error(`[${NAME}] Re-registered (last_seen refreshed).`);
    return TOKEN;
  }
  // First-time registration as a managed agent. Flag managed:true so the
  // relay routes token_rotated push-messages to us and gives us a grace
  // window on rotate_token instead of immediate cut.
  const result = await rpc("register_agent", { name: NAME, role: ROLE, capabilities: CAPABILITIES, managed: true });
  if (!result.success) {
    console.error(`[${NAME}] Registration failed: ${result.error}`);
    process.exit(1);
  }
  const newToken = result.agent_token || "";
  if (newToken) {
    TOKEN = newToken;
    persistToken(TOKEN);
    console.error(`[${NAME}] Registered as managed. Token persisted to ${TOKEN_STORE_PATH}.`);
  }
  return TOKEN;
}

// --- v2.1 Phase 4b.2: token-rotation push-message handler ---

const PROTOCOL_FENCE_RE = /```json\n([\s\S]*?)\n```/;

function parseProtocolPayload(messageContent) {
  const m = PROTOCOL_FENCE_RE.exec(messageContent || "");
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Persist-before-ack: write the new token to TOKEN_STORE_PATH BEFORE
 * updating the in-memory TOKEN. If the process crashes between, next
 * startup loads the persisted token and reconnects cleanly. Mirror of
 * the Phase 4o recovery-flow discipline.
 */
function handleTokenRotation(payload) {
  const newToken = payload.new_token;
  const graceExpiresAt = payload.grace_expires_at;
  const rotator = payload.rotator || "?";
  if (typeof newToken !== "string" || !newToken) {
    console.error(`[${NAME}] token_rotated payload missing new_token — ignoring.`);
    return false;
  }
  try {
    persistToken(newToken);
  } catch (e) {
    console.error(`[${NAME}] persist failed; will retry on next poll: ${e.message}`);
    return false;
  }
  TOKEN = newToken;
  console.error(
    `[${NAME}] Token rotated by "${rotator}". Persisted + cut over. ` +
    `Old token valid until ${graceExpiresAt}.`
  );
  return true;
}

// --- Unregister (clean shutdown) ---

async function unregister() {
  try {
    const result = await rpc("unregister_agent", { name: NAME });
    console.error(`[${NAME}] Unregistered (removed=${result.removed}).`);
  } catch (e) {
    console.error(`[${NAME}] Unregister failed (non-fatal): ${e.message}`);
  }
}

// --- Signal handlers ---

async function shutdownAndExit() {
  console.error(`\n[${NAME}] Shutting down...`);
  await unregister();
  process.exit(0);
}
process.on("SIGINT", shutdownAndExit);
process.on("SIGTERM", shutdownAndExit);

// --- Message handling ---

async function checkMessages() {
  const result = await rpc("get_messages", { agent_name: NAME, status: "pending", limit: 20 });
  const messages = result.messages || [];
  for (const m of messages) {
    // v2.1 Phase 4b.2: intercept protocol envelopes BEFORE surfacing to
    // human-readable logging. Protocol messages are system events (token
    // rotation, etc.), not peer traffic.
    const payload = parseProtocolPayload(m.content || "");
    if (payload && payload.protocol === "bot-relay-token-rotation") {
      if (payload.version !== 1) {
        console.error(`[${NAME}] Unknown bot-relay-token-rotation version ${payload.version}; ignoring.`);
        continue;
      }
      if (payload.event === "token_rotated") {
        handleTokenRotation(payload);
        continue;
      }
      console.error(`[${NAME}] Unknown bot-relay-token-rotation event ${payload.event}; ignoring.`);
      continue;
    }
    console.error(`[${NAME}] Mail from ${m.from_agent} [${m.priority}]: ${(m.content || "").slice(0, 200)}`);
  }
  return messages;
}

// --- Task handling ---

async function checkTasks() {
  const result = await rpc("get_tasks", { agent_name: NAME, role: "assigned", status: "posted" });
  const tasks = result.tasks || [];
  for (const t of tasks) {
    console.error(`[${NAME}] Task from ${t.from_agent}: ${t.title} (id=${t.id})`);
    await rpc("update_task", { task_id: t.id, agent_name: NAME, action: "accept" });
    console.error(`[${NAME}] Accepted task ${t.id}.`);
    // ... do real work here ...
    await rpc("update_task", { task_id: t.id, agent_name: NAME, action: "complete", result: `Completed by ${NAME} (reference agent).` });
    console.error(`[${NAME}] Completed task ${t.id}.`);
  }
  return tasks;
}

// --- Discover peers ---

async function discover() {
  const result = await rpc("discover_agents", {});
  const names = (result.agents || []).map((a) => a.name);
  console.error(`[${NAME}] Peers: ${names.join(", ") || "(none)"}`);
}

// --- Main loop ---

async function main() {
  console.error(`[${NAME}] Starting managed agent (host=${HOST}:${PORT}, role=${ROLE})`);
  await register();
  await discover();
  console.error(`[${NAME}] Entering poll loop (interval=${POLL_INTERVAL / 1000}s). Ctrl-C to quit.`);

  while (true) {
    try {
      await checkMessages();
      await checkTasks();
    } catch (e) {
      console.error(`[${NAME}] Poll error (will retry): ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch((e) => { console.error(`[${NAME}] Fatal: ${e.message}`); process.exit(1); });
