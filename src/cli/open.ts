// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 C1 — `relay open` subcommand.
 *
 * Opens the dashboard URL in the operator's default browser. Reads
 * RELAY_HTTP_HOST + RELAY_HTTP_PORT (or ~/.bot-relay/config.json),
 * probes the daemon, and shells to the platform-native opener:
 *   darwin  → open <url>
 *   linux   → xdg-open <url>  (or $BROWSER if set)
 *   win32   → start "" <url>  (via cmd.exe /c)
 *
 * Daemon-down is a warning, not a hard failure: the URL prints to
 * stdout + the browser still opens (operator can start the daemon,
 * then refresh). `--url <u>` overrides auto-detection.
 */
import net from "net";
import { spawn } from "child_process";

interface Args {
  url: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { url: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--url") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--url requires a URL argument\n");
        throw new Error("missing --url value");
      }
      out.url = v;
    } else if (a.startsWith("--url=")) {
      out.url = a.slice("--url=".length);
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: relay open [--url <url>]\n\n" +
      "Opens the bot-relay dashboard in the default browser. Auto-detects\n" +
      "host + port from config ($RELAY_HTTP_HOST, $RELAY_HTTP_PORT, or\n" +
      "~/.bot-relay/config.json; defaults to http://127.0.0.1:3777).\n\n" +
      "Options:\n" +
      "  --url <url>   Open <url> instead of the auto-detected dashboard URL.\n" +
      "  --help        Show this message.\n"
  );
}

async function daemonListening(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => { clearTimeout(t); done(true); });
    sock.once("error", () => { clearTimeout(t); done(false); });
  });
}

export interface OpenDriver {
  command: string;
  args: string[];
}

export function pickDriver(platform: NodeJS.Platform, url: string, env = process.env): OpenDriver {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    // `start` is a cmd built-in; `""` is the title placeholder so the URL
    // isn't mis-parsed as the window title.
    return { command: "cmd.exe", args: ["/c", "start", "", url] };
  }
  // Linux / BSDs: prefer $BROWSER when set, else xdg-open.
  if (env.BROWSER && env.BROWSER.length > 0) {
    return { command: env.BROWSER, args: [url] };
  }
  return { command: "xdg-open", args: [url] };
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

  let url: string;
  let host: string;
  let port: number;
  if (args.url) {
    url = args.url;
    try {
      const u = new URL(url);
      host = u.hostname || "127.0.0.1";
      port = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
    } catch {
      process.stderr.write(`relay open: invalid --url value: ${args.url}\n`);
      return 1;
    }
  } else {
    try {
      const { loadConfig } = await import("../config.js");
      const cfg = loadConfig();
      host = cfg.http_host;
      port = cfg.http_port;
    } catch (err) {
      process.stderr.write(
        `relay open: could not load config: ${err instanceof Error ? err.message : String(err)}\n`
      );
      // Fall back to defaults rather than bail — the dashboard URL is still
      // useful to print + open.
      host = process.env.RELAY_HTTP_HOST || "127.0.0.1";
      port = process.env.RELAY_HTTP_PORT ? parseInt(process.env.RELAY_HTTP_PORT, 10) : 3777;
    }
    // When the bind is 0.0.0.0 / :: the dashboard isn't actually reachable
    // via those hosts from a browser — use loopback instead.
    const loopback = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    url = `http://${loopback}:${port}/`;
  }

  const listening = await daemonListening(host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, port);
  process.stdout.write(`Opening ${url}\n`);
  if (!listening) {
    process.stdout.write(
      `Heads-up: the daemon does not appear to be listening on ${host}:${port}.\n` +
      `  Start it with \`bot-relay-mcp --transport http\` (or \`both\`) and refresh.\n`
    );
  }

  const driver = pickDriver(process.platform, url);
  try {
    const child = spawn(driver.command, driver.args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (err) => {
      process.stderr.write(
        `relay open: failed to launch "${driver.command}": ${err.message}\n` +
        `  URL copied below — open it manually:\n  ${url}\n`
      );
    });
    child.unref();
  } catch (err) {
    process.stderr.write(
      `relay open: launch failed: ${err instanceof Error ? err.message : String(err)}\n` +
      `  URL:\n  ${url}\n`
    );
    return 2;
  }
  return 0;
}
