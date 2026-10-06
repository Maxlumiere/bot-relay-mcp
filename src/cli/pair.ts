// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 7r — `relay pair <hub-url>` subcommand.
 *
 * Packages the "cloud-hosted relay + multiple thin MCP clients" deployment
 * pattern as a first-class CLI. The machinery it uses already exists —
 * `RELAY_TRANSPORT=http` + per-agent bcrypt tokens (v1.7) + HTTP hardening
 * (Phase 4d/4e/4n) — but until 7r there was no convenience path for an
 * operator to point a local MCP client at a remote bot-relay-mcp hub.
 *
 * Flow:
 *   1. Probe `<hub-url>/health`. Timeout 5s, abort on unreachable.
 *   2. Call `register_agent` on the hub via HTTP. If the hub returns 401,
 *      prompt for `RELAY_HTTP_SECRET` and retry once (or use --secret /
 *      env on the first call).
 *   3. Capture the returned `agent_token` and emit a ready-to-paste MCP
 *      client config snippet to stdout (or --output path).
 *   4. Print next-steps guidance.
 *
 * Exit codes:
 *   0 — paired successfully
 *   1 — argv error, operator cancel, unreachable hub
 *   2 — hub rejected (auth failure, schema error, unknown state)
 *
 * Trust model: the operator has network access to the hub and (if required)
 * the shared secret. Per-agent tokens are minted server-side via the normal
 * register_agent path — NO new trust boundary introduced.
 */
import * as readline from "readline/promises";
import fs from "fs";
import path from "path";
import { withDeadline } from "../http-deadline.js";

interface Args {
  hubUrl: string | null;
  name: string | null;
  role: string;
  capabilities: string[];
  output: string | null;
  /** PR-D: the hub's registration secret is read from this FILE at use time, never from argv. */
  secretFile: string | null;
  /** PR-D: read the hub's registration secret from stdin (first line). */
  secretStdin: boolean;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    hubUrl: null,
    name: null,
    role: "user",
    capabilities: [],
    output: null,
    secretFile: null,
    secretStdin: false,
    yes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--name") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--name requires a value\n");
        throw new Error("missing --name");
      }
      out.name = v;
    } else if (a === "--role") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--role requires a value\n");
        throw new Error("missing --role");
      }
      out.role = v;
    } else if (a === "--capabilities") {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write("--capabilities requires a comma-separated list\n");
        throw new Error("missing --capabilities");
      }
      out.capabilities = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === "--output") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--output requires a path\n");
        throw new Error("missing --output");
      }
      out.output = v;
    } else if (a === "--secret" || a.startsWith("--secret=")) {
      // PR-D (architect 66e27eff): a secret on the command line is visible to every process on the machine
      // (ps). The hub's secret now also registers new agent names, so it never rides argv.
      process.stderr.write(
        "relay pair: --secret is no longer accepted: a secret on the command line is visible to every process (ps).\n" +
          "  Use --secret-file PATH (read when pairing), --secret-stdin (pipe it in), or the hidden prompt.\n",
      );
      throw new Error("refused --secret");
    } else if (a === "--secret-file") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--secret-file requires a path\n");
        throw new Error("missing --secret-file");
      }
      out.secretFile = v;
    } else if (a === "--secret-stdin") {
      out.secretStdin = true;
    } else if (!a.startsWith("-") && !out.hubUrl) {
      out.hubUrl = a;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

function printUsage(requested = false): void {
  // STREAM DISCIPLINE: usage is DIAGNOSTIC on the error path → STDERR, so a
  // failed `$(relay pair …)` capture yields EMPTY (fails loud) instead of help
  // text that reads as a value. Only an explicit --help is `requested` and
  // belongs on stdout.
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay pair <hub-url> [--name NAME] [--role ROLE] [--capabilities CAPS]\n" +
      "                     [--output PATH] [--secret-file PATH | --secret-stdin] [--yes]\n\n" +
      "Register this machine as an agent on a remote bot-relay-mcp hub and emit\n" +
      "a ready-to-paste MCP client config snippet. Use when you have a centralized\n" +
      "bot-relay-mcp deployment (e.g. on a VPS) and want to point a local Claude\n" +
      "Code / Cursor / etc. client at it.\n\n" +
      "Arguments:\n" +
      "  <hub-url>              HTTP URL of the remote hub, e.g. https://relay.example.com:3777\n\n" +
      "Options:\n" +
      "  --name NAME            Agent name (default: prompts interactively)\n" +
      "  --role ROLE            Agent role (default: 'user')\n" +
      "  --capabilities CSV     Comma-separated capabilities (default: none)\n" +
      "  --output PATH          Write MCP client config to PATH (default: stdout)\n" +
      "  --secret-file PATH     File holding the hub's secret (its registration secret: the hub operator\n" +
      "                         finds it at <relay instance dir>/secrets/mint.secret and hands it over)\n" +
      "  --secret-stdin         Read the hub's secret from stdin (first line)\n" +
      "                         (an already-set RELAY_HTTP_SECRET is also read; a secret is never taken from argv)\n" +
      "  --yes                  Skip interactive prompts (requires --name)\n" +
      "  --help                 Show this message\n\n" +
      "Exit codes:\n" +
      "  0 — paired successfully\n" +
      "  1 — argv/connection error, operator cancelled\n" +
      "  2 — hub rejected (auth failure, bad state)\n"
  );
}

function sanitizeHubUrl(raw: string): { url: URL | null; error: string | null } {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { url: null, error: `hub URL must be http:// or https:// (got ${u.protocol})` };
    }
    return { url: u, error: null };
  } catch {
    return { url: null, error: `malformed URL: ${raw}` };
  }
}

/**
 * REMOVED: the old `fetchWithTimeout` cleared its timer in a `finally` that ran
 * as soon as `fetch()` resolved — i.e. on RESPONSE HEADERS — leaving every
 * subsequent `res.json()` / `res.text()` completely unbounded. Measured against
 * a real stalling server: `pair.run` still pending at 7003ms against its own
 * 5000ms promise.
 *
 * Callers now wrap the WHOLE exchange (connect + body) in `withDeadline`. Do not
 * reintroduce a helper that returns a Response for the caller to drain later —
 * that shape is the defect, and it looks correct at every call site.
 */

/** PR-D: a NO-ECHO prompt for the hub's secret (a TTY only): raw mode, nothing is written back. */
async function promptHidden(msg: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return "";
  process.stdout.write(msg);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve) => {
      const onData = (buf: Buffer) => {
        for (const ch of buf.toString("utf-8")) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            stdin.off("data", onData);
            process.stdout.write("\n");
            return resolve(value.trim());
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            process.stdout.write("\n");
            return resolve("");
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/** PR-D: the hub's secret from --secret-file (read now, at use time) or --secret-stdin. Never argv. */
async function secretFromArgs(args: Args): Promise<string | null> {
  if (args.secretFile) {
    const v = fs.readFileSync(args.secretFile, "utf-8").trim();
    if (!v) throw new Error(`${args.secretFile} is empty`);
    return v;
  }
  if (args.secretStdin) {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const v = text.split("\n")[0].trim();
    if (!v) throw new Error("nothing on stdin");
    return v;
  }
  return null;
}

async function promptInteractive(msg: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(msg)).trim();
  } finally {
    rl.close();
  }
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch {
    return 1;
  }
  if (args.help) {
    printUsage(true);
    return 0;
  }
  if (!args.hubUrl) {
    process.stderr.write("relay pair: missing <hub-url>\n\n");
    printUsage();
    return 1;
  }

  const { url, error } = sanitizeHubUrl(args.hubUrl);
  if (!url) {
    process.stderr.write(`relay pair: ${error}\n`);
    return 1;
  }
  const hubBase = `${url.protocol}//${url.host}`;

  // --- Step 1: probe /health ---
  let healthBody: any = null;
  try {
    // The body read is INSIDE the deadline — that is the whole fix. A hub that
    // sends headers and stalls now fails at 5s instead of hanging forever.
    const probe = await withDeadline(5000, "hub health probe", async (signal) => {
      const res = await fetch(`${hubBase}/health`, { signal });
      if (!res.ok) return { ok: false as const, status: res.status };
      return { ok: true as const, body: await res.json().catch(() => ({})) };
    });
    if (!probe.ok) {
      process.stderr.write(
        `relay pair: hub health probe returned HTTP ${probe.status}. ` +
          `Hub may be down or URL may be wrong.\n`
      );
      return 1;
    }
    healthBody = probe.body;
  } catch (err) {
    process.stderr.write(
      `relay pair: cannot reach hub at ${hubBase}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  process.stdout.write(`Hub reachable: ${hubBase}\n`);
  if (healthBody.version) process.stdout.write(`  version:          ${healthBody.version}\n`);
  if (healthBody.protocol_version) {
    process.stdout.write(`  protocol_version: ${healthBody.protocol_version}\n`);
  }

  // --- Step 2: resolve agent name ---
  let agentName = args.name;
  if (!agentName) {
    if (args.yes) {
      process.stderr.write("relay pair: --yes requires --name\n");
      return 1;
    }
    agentName = await promptInteractive("Agent name for this machine: ");
    if (!agentName) {
      process.stderr.write("relay pair: agent name is required\n");
      return 1;
    }
  }

  // --- Step 3: resolve secret ---
  // Precedence: --secret-file / --secret-stdin > an already-set RELAY_HTTP_SECRET > none (try without one
  // first, then the hidden prompt on a TTY). PR-D: never from argv, and nothing here ever EXPORTS it.
  let secret: string | null;
  try {
    secret = (await secretFromArgs(args)) ?? process.env.RELAY_HTTP_SECRET ?? null;
  } catch (err) {
    process.stderr.write(`relay pair: could not read the hub's secret: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const NEEDS_SECRET =
    "relay pair: the hub requires its secret to register a new agent name.\n" +
    "  Ask the hub's operator for it (the hub keeps it at <relay instance dir>/secrets/mint.secret and never\n" +
    "  prints it), save it to a file readable only by you, then re-run with --secret-file PATH.\n";

  const attemptRegister = async (): Promise<{
    status: number;
    body: any;
  }> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (secret) headers["X-Relay-Secret"] = secret;
    // `res.text()` is inside the deadline. The MCP endpoint answers with SSE
    // frames, so this is exactly the shape most likely to deliver headers and
    // then stall — the register step was the second unbounded body read.
    return await withDeadline(10_000, "hub register_agent", async (signal) => {
      const res = await fetch(`${hubBase}/mcp`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "register_agent",
            arguments: {
              name: agentName!,
              role: args.role,
              capabilities: args.capabilities,
            },
          },
        }),
      });
      const text = await res.text();
      // The HTTP transport emits SSE frames; pull the data line when present.
      const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
      const rpcResp = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text || "{}");
      const body = rpcResp?.result?.content?.[0]?.text
        ? JSON.parse(rpcResp.result.content[0].text)
        : rpcResp;
      return { status: res.status, body };
    });
  };

  // --- Step 4: register (handle 401 → prompt for secret → retry once) ---
  let result: { status: number; body: any };
  try {
    result = await attemptRegister();
  } catch (err) {
    process.stderr.write(
      `relay pair: register_agent request failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  if (result.status === 401 || (result.body?.auth_error === true && !secret)) {
    if (args.yes || !process.stdin.isTTY) {
      process.stderr.write(NEEDS_SECRET);
      return 2;
    }
    process.stdout.write("The hub requires its secret.\n");
    secret = await promptHidden("Hub secret (not shown): ");
    if (!secret) {
      process.stderr.write("relay pair: no secret provided\n");
      return 1;
    }
    try {
      result = await attemptRegister();
    } catch (err) {
      process.stderr.write(
        `relay pair: retry after secret failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 1;
    }
  }

  if (result.status === 401 || result.body?.auth_error === true) {
    process.stderr.write(
      result.body?.error_code === "MINT_SECRET_REQUIRED"
        ? `relay pair: the hub rejected the secret.\n${NEEDS_SECRET}`
        : `relay pair: hub rejected authentication. Check the --secret-file / RELAY_HTTP_SECRET value.\n`
    );
    return 2;
  }

  if (result.body?.success !== true || typeof result.body?.agent_token !== "string") {
    process.stderr.write(
      `relay pair: register_agent failed — ${
        result.body?.error || `unexpected response (status ${result.status})`
      }\n`
    );
    return 2;
  }

  const token: string = result.body.agent_token;

  // --- Step 5: emit config snippet ---
  // Shape matches what ~/.claude.json under `mcpServers` expects for the
  // HTTP transport. Clients that use a different key ("mcp-servers" etc)
  // can move the inner object freely; this is the canonical MCP-over-HTTP
  // shape.
  const snippet = {
    "bot-relay": {
      type: "http",
      url: `${hubBase}/mcp`,
      headers: {
        "X-Agent-Token": token,
        // PR-D: the secret goes into the client config ONLY when the hub gates EVERY call with it
        // (/health auth_required, a hub with http_secret). Otherwise it was needed once, to register the
        // name, and the agent's own token is its credential from now on: the secret stays out of the file.
        ...(secret && healthBody?.auth_required === true ? { "X-Relay-Secret": secret } : {}),
      },
    },
  };
  const snippetText = JSON.stringify(snippet, null, 2);

  if (args.output) {
    try {
      const parent = path.dirname(args.output);
      if (parent && parent !== "." && !fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      fs.writeFileSync(args.output, snippetText + "\n", { mode: 0o600 });
      process.stdout.write(`\nWrote MCP client config snippet to ${args.output} (mode 0600)\n`);
    } catch (err) {
      process.stderr.write(
        `relay pair: could not write --output ${args.output}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
      return 1;
    }
  } else {
    process.stdout.write("\n--- MCP client config snippet ---\n");
    process.stdout.write(snippetText + "\n");
    process.stdout.write("--- end snippet ---\n");
  }

  // --- Step 6: next-steps guidance ---
  process.stdout.write(
    `\nPaired "${agentName}" with ${hubBase}.\n\n` +
      "Next steps:\n" +
      "  1. Paste the snippet above into your MCP client config:\n" +
      "     - Claude Code:  ~/.claude.json   (under \"mcpServers\")\n" +
      "     - Cursor:       ~/.cursor/mcp.json\n" +
      "     - Custom:       consult your client's MCP config docs\n" +
      "  2. Persist the token for SessionStart / hook flows:\n" +
      `       export RELAY_AGENT_TOKEN=${token}\n` +
      "     (append to your ~/.zshrc / ~/.bashrc for persistence)\n" +
      `  3. Verify the connection:\n` +
      `       relay doctor --remote ${hubBase}\n` +
      "\nThe token is shown ONCE — the hub stores only a bcrypt hash.\n" +
      "Save it now; lost tokens require 'relay recover <agent>' on the hub.\n"
  );

  return 0;
}
