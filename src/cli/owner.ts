// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay owner peek <agent> --json [--with-content N] [--timeout-ms MS]` and
 * `relay owner liveness <agent> --pid N [--start S] [--timeout-ms MS]`: the hooks' client of a wasm DB's OWNER DOOR
 * (hook PR 1, as ruled after Codex #418 R1; src/owner-endpoint.ts).
 * - It resolves the instance as `relay pending` does and opens NO database: it reads the owner's record under the
 *   trust model (no link, one link, this uid, private, in a private dir; Windows: the owner-only ACL) and takes the key
 *   from it. The key never passes through a shell, the environment, argv or another file.
 * - ONE exchange with node's http client to 127.0.0.1:<the record's port>: no proxy (node's http uses none), no
 *   redirect (it follows none), no curl configuration. The request is MAC'd; the reply's MAC is verified BEFORE
 *   anything is printed (a forged or altered reply prints nothing).
 * - The whole run is bounded by --timeout-ms (default 5000): past it, a named failure.
 * - `peek` prints exactly `relay pending --json`'s answer (plus "source": "owner"), so a hook renders the owner's mail
 *   with its local code. Every failure is one stderr line "relay owner: <why>", exit 1.
 */
import http from "http";
import crypto from "crypto";
import {
  ownerEndpointVerdict,
  doorMac,
  doorRequestText,
  doorResponseText,
  macEqual,
  OWNER_DOOR_PEEK,
  OWNER_DOOR_LIVENESS,
} from "../owner-endpoint.js";
import { decidePendingSource } from "./pending.js";

const AGENT_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const USAGE =
  "Usage: relay owner peek <agent> --json [--with-content N] [--timeout-ms MS]\n" +
  "       relay owner liveness <agent> --pid N [--start S] [--timeout-ms MS]\n";

interface Args {
  sub: "peek" | "liveness";
  agent: string;
  withContent: number;
  timeoutMs: number;
  pid: number | null;
  start: string | null;
}

function parse(argv: string[]): Args | string {
  const [sub, agent, ...rest] = argv;
  if (sub !== "peek" && sub !== "liveness") return "the first argument is peek or liveness";
  if (typeof agent !== "string" || !AGENT_RE.test(agent)) return "a valid agent name is required";
  const a: Args = { sub, agent, withContent: 0, timeoutMs: 5000, pid: null, start: null };
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    const val = () => rest[++i];
    if (f === "--json") continue;
    if (f === "--with-content") {
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
    } else {
      return `unknown argument ${JSON.stringify(f)}`;
    }
  }
  if (a.sub === "liveness" && a.pid === null) return "liveness needs --pid";
  return a;
}

/** ONE MAC'd exchange; resolves to the verified reply, or rejects with a named reason. */
function exchange(port: number, key: string, doorPath: string, bodyObj: Record<string, unknown>, nonce: string, deadlineMs: number): Promise<{ status: number; payload: Record<string, unknown> }> {
  const body = JSON.stringify(bodyObj);
  const mac = doorMac(key, doorRequestText(doorPath, bodyObj.ts as number, nonce, body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: doorPath,
        method: "POST",
        agent: false,
        headers: { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body), "X-Owner-MAC": mac },
      },
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
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          const got = res.headers["x-owner-mac"];
          if (typeof got !== "string" || !macEqual(got, doorMac(key, doorResponseText(nonce, status, text)))) {
            reject(new Error("the owner's reply failed its MAC (a forged or altered reply): nothing from it is shown"));
            return;
          }
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(text) as Record<string, unknown>;
          } catch {
            reject(new Error("the owner's reply is not JSON"));
            return;
          }
          resolve({ status, payload });
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
  // The hard bound: whatever step is running when it passes (the resolution, the probe, the exchange), the run ends.
  const hard = setTimeout(() => {
    process.stderr.write(`relay owner: no answer within ${a.timeoutMs}ms (timed out)\n`);
    process.exit(1);
  }, a.timeoutMs);
  try {
    const { source, resolution } = await decidePendingSource(null);
    if (source.kind !== "local") return fail(`no local relay instance to read (${source.reason})`);
    const v = ownerEndpointVerdict(source.dbPath);
    if (!v.ok) return fail(`no trusted owner endpoint for ${source.dbPath} (${v.reason})`);
    const nonce = crypto.randomBytes(16).toString("hex");
    const ts = Math.floor(Date.now() / 1000);
    const doorPath = a.sub === "peek" ? OWNER_DOOR_PEEK : OWNER_DOOR_LIVENESS;
    const args: Record<string, unknown> = a.sub === "peek" ? { with_content: a.withContent } : { agent_pid: a.pid, ...(a.start !== null ? { agent_pid_start: a.start } : {}) };
    let reply: { status: number; payload: Record<string, unknown> };
    try {
      reply = await exchange(v.port, v.key, doorPath, { agent_name: a.agent, args, ts, client_nonce: nonce }, nonce, deadline);
    } catch (err) {
      return fail((err as Error).message);
    }
    const p = reply.payload;
    if (reply.status !== 200 || p.ok !== true) return fail(`the owner refused (${reply.status}): ${typeof p.error === "string" ? p.error : "no reason given"}`);
    if (a.sub === "liveness") {
      process.stdout.write(JSON.stringify({ ok: true, agent: a.agent }) + "\n");
      return 0;
    }
    if (p.registered !== true) {
      return fail(`agent ${JSON.stringify(a.agent)} is not registered in ${source.dbPath}: cannot say what is pending (this is NOT "no mail")`);
    }
    const { serializeResolution } = await import("../instance.js");
    process.stdout.write(
      JSON.stringify({
        ok: true,
        agent: a.agent,
        db_path: source.dbPath,
        resolution: resolution ? serializeResolution(resolution) : null,
        session_bound: p.session_bound,
        count: p.count,
        top_priority: p.top_priority,
        messages: p.messages,
        source: "owner",
      }) + "\n",
    );
    return 0;
  } finally {
    clearTimeout(hard);
  }
}
