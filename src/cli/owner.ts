// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay owner …`: the hooks' client of a relay daemon's OWNER DOOR (hook PR 1, made CONFIDENTIAL by hook PR 3, as
 * ruled after Codex #418 R2; src/owner-endpoint.ts).
 *   relay owner peek <agent> --json [--with-content N] [--timeout-ms MS]
 *   relay owner liveness <agent> --pid N [--start S] [--timeout-ms MS]
 *   relay owner tool <register_agent|health_check|report_liveness> --args-json JSON [--with-recovery-token] [--timeout-ms MS]
 *   (the args are NOT secret: name, role, capabilities, pids. Credentials never ride argv: a token key in them is refused.)
 *   relay owner session <agent> [--timeout-ms MS]   (as ruled: that ONE agent's session_id, for its own token)
 * - It resolves the LOCAL instance (the resolver alone: a remote RELAY_HTTP_HOST never redirects it) and opens NO
 *   database. It reads the record under the trust model
 *   and takes the key from it; the key never passes through a shell, the environment, argv or another file.
 * - ONE exchange with node's http client to 127.0.0.1:<the record's port> (no proxy, no redirect, no curl
 *   configuration). The request is AES-256-GCM sealed (its AAD binds the path, ts, nonce and this instance); the reply
 *   is opened (authenticated) BEFORE anything is printed: a forged or altered reply prints nothing.
 * - CREDENTIALS ride INSIDE the sealed request, never argv: the agent token from this process's RELAY_AGENT_TOKEN (the
 *   hook's, unchanged), the recovery token from RELAY_RECOVERY_TOKEN (only with --with-recovery-token), and, for
 *   register_agent, the instance's registration secret from its file. The owner runs the SAME dispatcher as /mcp.
 * - `tool` prints the tool's JSON-RPC answer and an `HTTP_STATUS:200` line, exactly as the hooks' curl call printed it,
 *   so their parsing is unchanged. `peek` prints `relay pending --json`'s answer (+ "source": "owner", "registered").
 * - BOUNDS: the caller's watchdog is the guaranteed bound (the hooks run it under relay_run_pending); --timeout-ms
 *   (default 5000) bounds the exchange and, best-effort, the run; spawned system tools take a timeout within it.
 * Every failure is one stderr line "relay owner: <why>", exit 1.
 */
import fs from "fs";
import http from "http";
import crypto from "crypto";
import { setSystemSpawnDeadline } from "../fs-perms.js";
import {
  type DoorBinding,
  ownerEndpointVerdict,
  doorKey,
  doorSeal,
  doorOpen,
  doorRequestAad,
  doorResponseAad,
  OWNER_DOOR_PEEK,
  OWNER_DOOR_LIVENESS,
  OWNER_DOOR_REGISTER,
  OWNER_DOOR_HEALTH,
  OWNER_DOOR_SESSION,
} from "../owner-endpoint.js";

const AGENT_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const TOOL_PATH: Readonly<Record<string, string>> = {
  register_agent: OWNER_DOOR_REGISTER,
  health_check: OWNER_DOOR_HEALTH,
  report_liveness: OWNER_DOOR_LIVENESS,
};
const USAGE =
  "Usage: relay owner peek <agent> --json [--with-content N] [--timeout-ms MS]\n" +
  "       relay owner liveness <agent> --pid N [--start S] [--timeout-ms MS]\n" +
  "       relay owner tool <register_agent|health_check|report_liveness> --args-json JSON [--with-recovery-token] [--timeout-ms MS]\n" +
  "       relay owner session <agent> [--timeout-ms MS]\n";

interface Args {
  sub: "peek" | "liveness" | "tool" | "session";
  target: string;
  withContent: number;
  timeoutMs: number;
  pid: number | null;
  start: string | null;
  argsJson: string | null;
  withRecovery: boolean;
}

function parse(argv: string[]): Args | string {
  const [sub, target, ...rest] = argv;
  if (sub !== "peek" && sub !== "liveness" && sub !== "tool" && sub !== "session") return "the first argument is peek, liveness, tool or session";
  if (sub === "tool" ? !(typeof target === "string" && target in TOOL_PATH) : !(typeof target === "string" && AGENT_RE.test(target))) {
    return sub === "tool" ? "tool takes register_agent, health_check or report_liveness" : "a valid agent name is required";
  }
  const a: Args = { sub, target, withContent: 0, timeoutMs: 5000, pid: null, start: null, argsJson: null, withRecovery: false };
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    const val = () => rest[++i];
    if (f === "--json") continue;
    if (f === "--with-recovery-token") {
      a.withRecovery = true;
    } else if (f === "--with-content") {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 0 || n > 50) return "--with-content takes an integer 0-50";
      a.withContent = n;
    } else if (f === "--timeout-ms") {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 100 || n > 120_000) return "--timeout-ms takes an integer 100-120000";
      a.timeoutMs = n;
    } else if (f === "--pid") {
      const n = Number(val());
      if (!Number.isInteger(n) || n <= 0) return "--pid takes a positive integer";
      a.pid = n;
    } else if (f === "--start") {
      const s = val();
      if (typeof s !== "string" || s.length === 0 || s.length > 200) return "--start takes a non-empty string";
      a.start = s;
    } else if (f === "--args-json") {
      const s = val();
      if (typeof s !== "string" || s.length === 0 || s.length > 16_000) return "--args-json takes a JSON object";
      a.argsJson = s;
    } else {
      return `unknown argument ${JSON.stringify(f)}`;
    }
  }
  if (a.sub === "liveness" && a.pid === null) return "liveness needs --pid";
  if (a.sub === "tool" && a.argsJson === null) return "tool needs --args-json";
  return a;
}

/** ONE sealed exchange; resolves to the OPENED reply, or rejects with a named reason. */
function exchange(
  port: number,
  key: string,
  binding: DoorBinding,
  doorPath: string,
  plain: { agent_name: string; args: Record<string, unknown> },
  deadlineMs: number,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = JSON.stringify({ ts, client_nonce: nonce, ...doorSeal(doorKey(key, "req"), doorRequestAad(binding, doorPath, ts, nonce), plain) });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: doorPath, method: "POST", agent: false, headers: { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) {
            req.destroy();
            reject(new Error("the owner's reply is too large"));
          } else chunks.push(c);
        });
        res.on("end", () => {
          // A callback failure REJECTS (never an uncaught exception, never an unsettled promise).
          try {
            const status = res.statusCode ?? 0;
            let env: unknown = null;
            try {
              env = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            } catch {
              /* not JSON: not an envelope */
            }
            const opened = doorOpen(doorKey(key, "resp"), doorResponseAad(binding, doorPath, ts, nonce, status), env);
            if (opened === null || typeof opened !== "object" || Array.isArray(opened)) {
              reject(new Error("the owner's reply failed its authentication (a forged or altered reply, or no owner): nothing from it is shown"));
              return;
            }
            resolve({ status, payload: opened as Record<string, unknown> });
          } catch (err) {
            reject(new Error(`the owner's reply could not be read (${(err as Error).message})`));
          }
        });
        res.on("error", (e) => reject(e));
      },
    );
    req.setTimeout(Math.max(1, deadlineMs - Date.now()), () => {
      req.destroy();
      reject(new Error("the owner did not answer in time (timed out)"));
    });
    req.on("error", (e) => reject(new Error(`the owner door could not be reached (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
    req.end(body);
  });
}

/** The instance's registration secret (for register_agent over the door), or undefined when there is none. */
async function mintSecretOrUndefined(): Promise<string | undefined> {
  try {
    const { mintSecretHome } = await import("../mint-gate.js");
    const { readMintSecret } = await import("../mint-secret.js");
    return readMintSecret(mintSecretHome()) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function run(argv: string[]): Promise<number> {
  const a = parse(argv);
  if (typeof a === "string") {
    process.stderr.write(`relay owner: ${a}\n${USAGE}`);
    return 2;
  }
  const fail = (why: string): number => {
    process.stderr.write(`relay owner: ${why}\n`);
    return 1;
  };
  const deadline = Date.now() + a.timeoutMs;
  setSystemSpawnDeadline(deadline);
  // Best-effort inside node (a synchronous step cannot be interrupted): the caller's watchdog is the guaranteed bound.
  const hard = setTimeout(() => {
    process.stderr.write(`relay owner: no answer within ${a.timeoutMs}ms (timed out)\n`);
    process.exit(1);
  }, a.timeoutMs);
  try {
    // #433 R2 P1-1: a LOCAL-ONLY resolver. The owner door is this machine's instance, whatever RELAY_HTTP_HOST says
    // (relay pending's source decision routes an auto-discovered instance remote when it is set): the resolver's DB.
    const { resolveInstance } = await import("../instance.js");
    const resolution = resolveInstance({});
    if (resolution.kind === "error") return fail(`no local relay instance (${resolution.reason})`);
    if (!fs.existsSync(resolution.dbPath)) return fail(`no local relay DB at ${resolution.dbPath}`);
    const source = { dbPath: resolution.dbPath };
    const instanceId = resolution.kind === "instance" ? resolution.id : "";
    const v = ownerEndpointVerdict(source.dbPath, instanceId);
    if (!v.ok) return fail(`no trusted owner endpoint for ${source.dbPath} (${v.reason}): restart the relay daemon if it is running`);
    // The client's OWN binding (never the record's): a record relocated from another instance cannot pass for this one.
    const binding: DoorBinding = { instance_id: instanceId, db_path: fs.realpathSync.native(source.dbPath) };
    const token = process.env.RELAY_AGENT_TOKEN || undefined;
    let agentName: string;
    let doorPath: string;
    let args: Record<string, unknown>;
    if (a.sub === "peek") {
      agentName = a.target;
      doorPath = OWNER_DOOR_PEEK;
      args = { with_content: a.withContent };
    } else if (a.sub === "session") {
      if (!token) return fail("session needs the agent's own token (RELAY_AGENT_TOKEN)");
      agentName = a.target;
      doorPath = OWNER_DOOR_SESSION;
      args = { agent_token: token };
    } else {
      let toolArgs: Record<string, unknown>;
      let tool: string;
      if (a.sub === "liveness") {
        tool = "report_liveness";
        agentName = a.target;
        toolArgs = { agent_name: a.target, agent_pid: a.pid, ...(a.start !== null ? { agent_pid_start: a.start } : {}), ...(token ? { agent_token: token } : {}) };
      } else {
        tool = a.target;
        try {
          toolArgs = JSON.parse(a.argsJson!) as Record<string, unknown>;
        } catch (err) {
          return fail(`--args-json is not JSON (${(err as Error).message})`);
        }
        if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return fail("--args-json must be a JSON object");
        // Credentials never ride argv: they come from this process's environment (and the secret from its file).
        if (["agent_token", "recovery_token", "mint_secret", "http_secret"].some((k) => k in toolArgs)) return fail("--args-json must not carry a credential (it comes from the environment)");
        if (a.withRecovery) {
          const rec = process.env.RELAY_RECOVERY_TOKEN;
          if (!rec) return fail("--with-recovery-token: RELAY_RECOVERY_TOKEN is not set");
          toolArgs = { ...toolArgs, recovery_token: rec };
        }
        agentName = typeof toolArgs.name === "string" ? toolArgs.name : typeof toolArgs.agent_name === "string" ? toolArgs.agent_name : "";
        if (!AGENT_RE.test(agentName)) agentName = "unnamed";
      }
      doorPath = TOOL_PATH[tool]!;
      args = {
        rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: toolArgs } },
        ...(token ? { agent_token: token } : {}),
        ...(tool === "register_agent" ? (await mintSecretOrUndefined().then((s) => (s ? { mint_secret: s } : {}))) : {}),
      };
    }
    let reply: { status: number; payload: Record<string, unknown> };
    try {
      reply = await exchange(v.port, v.key, binding, doorPath, { agent_name: agentName, args }, deadline);
    } catch (err) {
      return fail((err as Error).message);
    }
    const p = reply.payload;
    if (reply.status !== 200 || p.ok !== true) return fail(`the owner refused (${reply.status}): ${typeof p.error === "string" ? p.error : "no reason given"}`);
    if (a.sub === "tool") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: p.result }) + "\nHTTP_STATUS:200\n");
      return 0;
    }
    if (a.sub === "session") {
      process.stdout.write(JSON.stringify({ ok: true, agent: a.target, session_id: typeof p.session_id === "string" ? p.session_id : null }) + "\n");
      return 0;
    }
    if (a.sub === "liveness") {
      const r = p.result as { isError?: boolean } | undefined;
      if (r?.isError) return fail(`the owner refused the liveness report: ${JSON.stringify(r).slice(0, 300)}`);
      process.stdout.write(JSON.stringify({ ok: true, agent: a.target }) + "\n");
      return 0;
    }
    const registered = p.registered === true;
    const { serializeResolution } = await import("../instance.js");
    process.stdout.write(
      JSON.stringify({
        ok: true,
        agent: a.target,
        db_path: source.dbPath,
        resolution: serializeResolution(resolution),
        session_bound: registered ? p.session_bound : false,
        count: registered ? p.count : 0,
        top_priority: registered ? p.top_priority : null,
        messages: registered ? p.messages : [],
        registered,
        source: "owner",
      }) + "\n",
    );
    return 0;
  } finally {
    clearTimeout(hard);
  }
}
