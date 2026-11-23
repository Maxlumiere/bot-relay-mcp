// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay whoami [--agent NAME] [--json]`: which agent does your token belong to? READ-ONLY: the CLI counterpart of the
 * `whoami` MCP tool, for a session whose MCP transport is down.
 *
 * The token IS the identity: RELAY_AGENT_TOKEN, else the vault token of --agent (default $RELAY_AGENT_NAME), validated
 * locally first (src/cli/agent-token.ts). A LOCAL relay is reached only through its owner door; a REMOTE one with its
 * own credentials over /mcp. STREAM DISCIPLINE: --json prints the closed identity envelope (no token, no secret: the
 * tool's closed type); otherwise stdout is ONLY the agent name, the human line on stderr. --agent NAME that the token
 * does not belong to exits 1 with nothing on stdout. Never registers, never mints.
 */
import { RelayClientError } from "./relay-client.js";

/** The CLOSED identity surface (src/types.ts WhoamiResult), field by field: nothing else from a response is printed. */
const IDENTITY_STRINGS = ["agent_name", "role", "instance_id", "db_path", "host_id", "edge_id"] as const;
const BUILD_FIELDS = ["build_id", "commit", "dirty", "built_at", "deps_id", "deps_state", "node"] as const;

/**
 * The permitted envelope, built FIELD BY FIELD (nested `build` included) from an untrusted response: a token, an
 * operator secret or any other extra field a relay (or a man in the middle) adds is dropped, never passed through.
 * Null when the response is not a successful identity.
 */
export function closedIdentity(e: Record<string, unknown>): Record<string, unknown> | null {
  if (e.success !== true || typeof e.agent_name !== "string") return null;
  const out: Record<string, unknown> = { success: true };
  for (const k of IDENTITY_STRINGS) {
    const v = e[k];
    if (typeof v === "string" || v === null) out[k] = v;
  }
  if (Array.isArray(e.capabilities)) out.capabilities = e.capabilities.filter((c): c is string => typeof c === "string");
  if (e.build !== null && typeof e.build === "object" && !Array.isArray(e.build)) {
    const b = e.build as Record<string, unknown>;
    const build: Record<string, unknown> = {};
    for (const k of BUILD_FIELDS) {
      const v = b[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) build[k] = v;
    }
    out.build = build;
  }
  return out;
}

/** A refusal said WITHOUT the relay's own text (it may echo the token): only a well-formed error code. */
export function safeRefusal(e: Record<string, unknown> | null): string {
  const code = e?.error_code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? `the relay refused (${code})` : "the relay refused";
}

/**
 * A transport failure. For a REMOTE, only the client's OWN message (RelayClientError: constructed in relay-client.ts,
 * a redirect shown by its origin only); any other exception text is withheld (it can carry a Location, a token).
 */
export function transportDiagnostic(route: { kind: string }, host: string, port: number, err: unknown): string {
  if (route.kind === "remote") {
    return err instanceof RelayClientError
      ? `could not reach the relay at ${host}:${port} (${err.message})`
      : `could not reach the relay at ${host}:${port} (transport error; details withheld: they can carry credentials)`;
  }
  return `could not reach the daemon at ${host}:${port} — is it running? (${err instanceof Error ? err.message : String(err)})`;
}

interface Args {
  agent: string | null;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { agent: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--agent") {
      const v = argv[++i];
      if (!v) throw new Error("--agent requires an agent name");
      out.agent = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function usage(requested = false): void {
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay whoami [--agent NAME] [--json]\n\n" +
      "Ask the relay which agent your token belongs to (read-only; the CLI form of the whoami tool).\n\n" +
      "  --agent NAME   Whose vault token to present (default: $RELAY_AGENT_NAME); with RELAY_AGENT_TOKEN set,\n" +
      "                 the answer must be this agent or the verb exits 1.\n" +
      "  --json         The identity envelope (agent_name, role, capabilities, instance_id, db_path, host_id,\n" +
      "                 build) on stdout. Without it, stdout is ONLY the agent name.\n" +
      "  --help         Show this message.\n\n" +
      "Token: $RELAY_AGENT_TOKEN → the per-instance vault (validated locally first). A local relay is reached\n" +
      "only through its owner door. Exit 2 on a local refusal (nothing sent), 1 when the relay refuses.\n",
  );
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay whoami: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 1;
  }
  if (args.help) {
    usage(true);
    return 0;
  }
  const agent = args.agent || process.env.RELAY_AGENT_NAME || null;
  if (!agent && !process.env.RELAY_AGENT_TOKEN) {
    process.stderr.write("relay whoami: no identity — pass --agent NAME, set RELAY_AGENT_NAME, or set RELAY_AGENT_TOKEN\n");
    return 1;
  }

  let host = "127.0.0.1";
  let port = 3777;
  try {
    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig();
    host = cfg.http_host || host;
    port = cfg.http_port || port;
  } catch {
    host = process.env.RELAY_HTTP_HOST || host;
    port = process.env.RELAY_HTTP_PORT ? parseInt(process.env.RELAY_HTTP_PORT, 10) : port;
  }
  const { routeFor, unresolvedMessage, localTool, toolJson, remotePost, remoteSecret, mcpResultOf } = await import("./relay-client.js");
  const route = await routeFor(host, port);
  if (route.kind === "unresolved") {
    process.stderr.write(`relay whoami: ${unresolvedMessage(route)}\n`);
    return 2;
  }
  const { resolveCliAgentToken } = await import("./agent-token.js");
  let resolved: { token: string } | { code: number };
  // Where the presented token came from (named in a mismatch line; the token itself never is).
  const envToken = process.env.RELAY_AGENT_TOKEN;
  const { isValidTokenShape } = await import("../spawn/validation.js");
  const { envSelects: selects } = await import("./relay-client.js");
  const tokenSource =
    !agent || (route.kind !== "remote" && isValidTokenShape(envToken)) || (route.kind === "remote" && selects(route.host) && isValidTokenShape(envToken))
      ? "RELAY_AGENT_TOKEN"
      : "the vault";
  if (agent) {
    resolved = await resolveCliAgentToken("whoami", agent, route);
  } else {
    // TOKEN ONLY (no name): the SAME credential policy as the shared resolver. A REMOTE gets RELAY_AGENT_TOKEN only when
    // the environment selected that remote (RELAY_HTTP_HOST); an inherited local token is never sent elsewhere.
    const { envSelects } = await import("./relay-client.js");
    if (route.kind === "remote" && !envSelects(route.host)) {
      process.stderr.write(
        `relay whoami: RELAY_AGENT_TOKEN is not selected for the remote relay ${route.host}:${route.port} (set RELAY_HTTP_HOST=${route.host}, or pass --agent NAME for its own vault entry); nothing is sent.\n`,
      );
      return 2;
    }
    resolved = { token: process.env.RELAY_AGENT_TOKEN as string };
  }
  if ("code" in resolved) return resolved.code;

  let envelope: Record<string, unknown> | null;
  try {
    if (route.kind === "remote") {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": resolved.token };
      const secret = await remoteSecret(route.host, route.port, "http");
      if (secret) headers["Authorization"] = `Bearer ${secret}`;
      const r = await remotePost(route, "/mcp", headers, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }));
      const result = mcpResultOf(r.text);
      envelope = result ? toolJson(result) : null;
    } else {
      envelope = toolJson(await localTool("whoami", {}, { agentToken: resolved.token }, agent ? { agentName: agent } : {}));
    }
  } catch (err) {
    process.stderr.write(`relay whoami: ${transportDiagnostic(route, host, port, err)}\n`);
    return 2;
  }
  if (envelope === null) {
    process.stderr.write("relay whoami: the relay returned an unparseable tool result\n");
    return 1;
  }
  const identity = closedIdentity(envelope);
  if (identity === null) {
    process.stderr.write(`relay whoami: ${safeRefusal(envelope)}\n`);
    return 1;
  }
  const name = identity.agent_name as string;
  // The name is printed, so it must be a NAME (the relay's agent-name rule), never arbitrary response text.
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    process.stderr.write("relay whoami: the relay returned a malformed agent name\n");
    return 1;
  }
  // The contract, ENFORCED (ruling c4454ae5): whenever an expected name exists (--agent, else RELAY_AGENT_NAME), the
  // token must belong to it. --agent wins over the environment's name. The line names both sources, never the token.
  const expected = args.agent ?? (process.env.RELAY_AGENT_NAME || null);
  if (expected && name !== expected) {
    const expectedFrom = args.agent ? "--agent" : "RELAY_AGENT_NAME";
    process.stderr.write(`relay whoami: the token belongs to "${name}", not "${expected}" (token from ${tokenSource}; expected name from ${expectedFrom})\n`);
    return 1;
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(identity) + "\n");
    return 0;
  }
  process.stderr.write(`✓ this token is agent "${name}"\n`);
  process.stdout.write(`${name}\n`);
  return 0;
}
