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

interface Args {
  hubUrl: string | null;
  name: string | null;
  role: string;
  capabilities: string[];
  output: string | null;
  secret: string | null;
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
    secret: null,
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
    } else if (a === "--secret") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--secret requires a value\n");
        throw new Error("missing --secret");
      }
      out.secret = v;
    } else if (!a.startsWith("-") && !out.hubUrl) {
      out.hubUrl = a;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: relay pair <hub-url> [--name NAME] [--role ROLE] [--capabilities CAPS]\n" +
      "                     [--output PATH] [--secret SECRET] [--yes]\n\n" +
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
      "  --secret SECRET        Hub's shared secret if required (or set RELAY_HTTP_SECRET env)\n" +
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

/** 5s timeout fetch wrapper. Returns Response or throws. */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function promptInteractive(msg: string, hidden = false): Promise<string> {
  void hidden; // readline/promises doesn't provide hidden input natively; keep API simple
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
    printUsage();
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
    const res = await fetchWithTimeout(`${hubBase}/health`);
    if (!res.ok) {
      process.stderr.write(
        `relay pair: hub health probe returned HTTP ${res.status}. ` +
          `Hub may be down or URL may be wrong.\n`
      );
      return 1;
    }
    healthBody = await res.json().catch(() => ({}));
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
  // Precedence: --secret > RELAY_HTTP_SECRET env > none (try unauthed first,
  // re-prompt on 401)
  let secret: string | null = args.secret ?? process.env.RELAY_HTTP_SECRET ?? null;

  const attemptRegister = async (): Promise<{
    status: number;
    body: any;
  }> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (secret) headers["X-Relay-Secret"] = secret;
    const res = await fetchWithTimeout(
      `${hubBase}/mcp`,
      {
        method: "POST",
        headers,
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
      },
      10_000
    );
    const text = await res.text();
    // The HTTP transport emits SSE frames; pull the data line when present.
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    const rpcResp = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text || "{}");
    const body = rpcResp?.result?.content?.[0]?.text
      ? JSON.parse(rpcResp.result.content[0].text)
      : rpcResp;
    return { status: res.status, body };
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
    if (args.yes) {
      process.stderr.write(
        "relay pair: hub requires a shared secret (401). Pass --secret or set RELAY_HTTP_SECRET.\n"
      );
      return 2;
    }
    process.stdout.write("Hub requires RELAY_HTTP_SECRET.\n");
    secret = await promptInteractive("Hub shared secret: ");
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
      `relay pair: hub rejected authentication. Check --secret / RELAY_HTTP_SECRET value.\n`
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
        ...(secret ? { "X-Relay-Secret": secret } : {}),
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
