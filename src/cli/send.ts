// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.1 — `relay send <to> <content>` subcommand.
 *
 * Collapses the whole "reverse-engineer /api/send-message by hand" flow (mint or
 * load a token, then craft the HTTP POST) into ONE line. Born from the transient-
 * send retro: a non-relay-connected session took ~10 manual steps to send one
 * message.
 *
 * AUTH: this does NOT bypass the relay's impersonation gate. It resolves the
 * `--from` agent's own token (env RELAY_AGENT_TOKEN → the per-instance file vault
 * → mint via `--mint-if-missing`) and sends it as `from_agent_token`, so the
 * daemon authenticates the sender exactly as it would for an MCP send_message.
 * If no token can be resolved and `--mint-if-missing` is not set, it REFUSES
 * (never sends unauthenticated). Same operator-authority trust model as
 * `relay mint-token`: filesystem access to the vault is the authority.
 */
import { isValidTokenShape } from "../spawn/validation.js";

interface Args {
  to: string | null;
  content: string | null;
  from: string | null;
  priority: "normal" | "high";
  mintIfMissing: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    to: null,
    content: null,
    from: null,
    priority: "normal",
    mintIfMissing: false,
    json: false,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--mint-if-missing") out.mintIfMissing = true;
    else if (a === "--json") out.json = true;
    else if (a === "--from") {
      const v = argv[++i];
      if (!v) throw new Error("--from requires an agent name");
      out.from = v;
    } else if (a === "--priority") {
      const v = argv[++i];
      if (v !== "normal" && v !== "high") throw new Error('--priority must be "normal" or "high"');
      out.priority = v;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  // Positional: <to> <content>. Content may be a single quoted arg.
  if (positional.length > 0) out.to = positional[0];
  if (positional.length > 1) out.content = positional.slice(1).join(" ");
  return out;
}

function usage(requested = false): void {
  // STREAM DISCIPLINE: usage is diagnostic on the ERROR path, so it goes to
  // STDERR. On stdout it poisoned command substitutions — a failed
  // $(relay mint-token ... --json) captured the help text and the agent
  // launched with a garbage token that LOOKED like a value. `requested`
  // (an explicit --help) is the one case where the text IS the data.
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay send <to> <content> [--from NAME] [--priority normal|high]\n" +
      "                                [--mint-if-missing] [--json]\n\n" +
      "Send a relay message in one line — resolves the sender's token and POSTs\n" +
      "to the local daemon's /api/send-message (fires webhooks, dedup, etc.).\n\n" +
      "  <to>              Recipient agent name.\n" +
      "  <content>         Message body (quote it; multiple words are joined).\n" +
      "  --from NAME       Sender agent (default: $RELAY_AGENT_NAME).\n" +
      "  --priority P      normal (default) | high.\n" +
      "  --mint-if-missing Mint+vault a token for --from if none exists (new agent\n" +
      "                    or an existing one with a matching vault). Refuses on a\n" +
      "                    vault mismatch — use `relay mint-token --force` instead.\n" +
      "  --json            Emit the JSON response on stdout.\n" +
      "  --help            Show this message.\n\n" +
      "Token resolution (in order): $RELAY_AGENT_TOKEN → per-instance vault →\n" +
      "  --mint-if-missing. The token is sent as from_agent_token — the relay's\n" +
      "  impersonation gate still applies; this never sends unauthenticated.\n"
  );
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay send: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 1;
  }
  if (args.help) {
    usage(true);
    return 0;
  }

  const from = args.from || process.env.RELAY_AGENT_NAME || null;
  if (!from) {
    process.stderr.write("relay send: no sender — pass --from NAME or set RELAY_AGENT_NAME\n");
    return 1;
  }
  if (!args.to) {
    process.stderr.write("relay send: missing <to> (recipient agent name)\n");
    return 1;
  }
  if (args.content === null || args.content.length === 0) {
    process.stderr.write("relay send: missing <content> (message body)\n");
    return 1;
  }

  // --- Resolve + LOCALLY VALIDATE the sender's token (never send a bad cred) ---
  // Precedence: $RELAY_AGENT_TOKEN (operator-explicit — trusted as-provided,
  // since it may target a remote hub whose agent isn't in the local DB) → the
  // per-instance vault, which MUST authenticate against the local DB BEFORE we
  // POST. A stale / missing / mismatched vault token for a registered agent is a
  // LOCAL refusal (exit 2, NO POST) on EVERY path (not just --mint-if-missing) —
  // same discipline as `relay mint-token`; a mismatched credential is never sent
  // to the daemon and mapped to a confusing exit 1 (codex v2.17.1 fix).
  let token: string | null = null;
  const envToken = process.env.RELAY_AGENT_TOKEN;
  if (isValidTokenShape(envToken)) {
    token = envToken;
  } else {
    try {
      const { resolveInstanceDbPath } = await import("../instance.js");
      if (!process.env.RELAY_DB_PATH) process.env.RELAY_DB_PATH = resolveInstanceDbPath();
    } catch {
      /* fall back to db default */
    }
    let dbOpen = false;
    try {
      const { initializeDb, getAgentAuthData } = await import("../db.js");
      await initializeDb();
      dbOpen = true;
      const { defaultTokenStore } = await import("../token-store.js");
      const vaultToken = await defaultTokenStore().read(from);
      const authData = getAgentAuthData(from);
      if (authData && authData.token_hash) {
        // Registered agent — the vault token MUST authenticate. Even with
        // --mint-if-missing a mismatch is NOT silently rotated (that needs
        // `mint-token --force`); it refuses locally with NO POST.
        const bcrypt = (await import("bcryptjs")).default;
        if (vaultToken && bcrypt.compareSync(vaultToken, authData.token_hash)) {
          token = vaultToken;
        } else {
          process.stderr.write(
            `relay send: the vault token for "${from}" does not authenticate against the DB ` +
              "(missing / stale / mismatched). NOT sending a mismatched credential.\n" +
              `  • Rotate deliberately (invalidates the old token): relay mint-token ${from} --force\n` +
              `  • Or reset the identity: relay recover ${from}\n`
          );
          return 2;
        }
      } else if (args.mintIfMissing) {
        // Not registered locally → mint + vault a fresh identity, then send.
        const { stableMintOrReuse } = await import("../mint-reuse.js");
        const r = await stableMintOrReuse(from, "agent", []);
        if (r.status === "mismatch") {
          process.stderr.write(
            `relay send: agent "${from}" is in a mismatched state — use \`relay mint-token ${from} --force\`.\n`
          );
          return 2;
        }
        token = r.token;
      } else {
        process.stderr.write(
          `relay send: no usable token for "${from}" — not registered locally, env RELAY_AGENT_TOKEN unset/invalid, and no vault entry.\n` +
            "  Pass --mint-if-missing to register + mint, or export RELAY_AGENT_TOKEN.\n"
        );
        return 2;
      }
    } catch (err) {
      process.stderr.write(
        `relay send: could not resolve a token: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 2;
    } finally {
      if (dbOpen) {
        try {
          const { closeDb } = await import("../db.js");
          closeDb();
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!token) {
    // Defensive: every branch above set token or returned; never POST tokenless.
    process.stderr.write(`relay send: could not resolve a sender token for "${from}".\n`);
    return 2;
  }

  // --- Resolve host/port + optional dashboard secret ---
  let host = "127.0.0.1";
  let port = 3777;
  let secret: string | null = process.env.RELAY_DASHBOARD_SECRET || process.env.RELAY_HTTP_SECRET || null;
  try {
    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig();
    host = cfg.http_host || host;
    port = cfg.http_port || port;
    if (!secret) secret = cfg.http_secret || null;
  } catch {
    host = process.env.RELAY_HTTP_HOST || host;
    port = process.env.RELAY_HTTP_PORT ? parseInt(process.env.RELAY_HTTP_PORT, 10) : port;
  }

  const url = `http://${host}:${port}/api/send-message`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  const payload = JSON.stringify({
    from,
    to: args.to,
    content: args.content,
    priority: args.priority,
    from_agent_token: token,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: payload });
  } catch (err) {
    process.stderr.write(
      `relay send: could not reach the daemon at ${url} — is it running? (${err instanceof Error ? err.message : String(err)})\n`
    );
    return 2;
  }

  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok || (parsed && parsed.success === false)) {
    process.stderr.write(
      `relay send: daemon returned ${res.status} — ${parsed?.error ?? text.slice(0, 300)}\n`
    );
    return 1;
  }

  if (args.json) {
    process.stdout.write((parsed ? JSON.stringify(parsed) : text.trim()) + "\n");
  } else {
    const id = parsed?.message_id ? ` (id ${parsed.message_id})` : "";
    process.stdout.write(`✓ sent ${args.priority} message from "${from}" to "${args.to}"${id}\n`);
  }
  return 0;
}
