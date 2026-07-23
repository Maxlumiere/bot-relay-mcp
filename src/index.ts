#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { loadConfig, validateConfigAndEnv, InvalidConfigError, readConfigFileKeys } from "./config.js";
import { startStdioServer } from "./transport/stdio.js";
import { startHttpServer } from "./transport/http.js";
import { closeDb, initializeDb } from "./db.js";
import { assertInstanceResolution } from "./instance.js";
import { startOutboxTail, stopOutboxTail } from "./outbox-tail.js";
import { log } from "./logger.js";
import { parseCliFlags, applyCliToEnv, usage } from "./cli.js";
import { VERSION } from "./version.js";
import type { Server as HttpServer } from "http";
import { PassThrough } from "node:stream";

const MIN_NODE_MAJOR = 18;

function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `bot-relay-mcp requires Node.js ${MIN_NODE_MAJOR}+ (you have ${process.versions.node}).\n` +
      `Install a newer Node from https://nodejs.org/ or use nvm.\n`
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkNodeVersion();

  // v2.2.1 B1: CLI flag parsing. Must run BEFORE loadConfig so CLI values
  // win precedence (CLI > env > file > default). `applyCliToEnv` injects
  // CLI values into process.env so the existing loadConfig env-read path
  // sees them transparently — zero structural change to loadConfig itself.
  const parsed = parseCliFlags(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`${parsed.error.message}\n`);
    process.exit(parsed.error.exitCode);
  }
  if (parsed.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (parsed.version) {
    process.stdout.write(`bot-relay-mcp ${VERSION}\n`);
    process.exit(0);
  }
  // v2.2.1 L2 (Codex audit): pass file-keys set so CLI/env/config/default
  // source tracking labels config-file-won values correctly in the
  // startup log. `readConfigFileKeys()` is a cheap re-parse; the full
  // `loadConfig()` call below picks up the same file content.
  const fileKeys = readConfigFileKeys();
  const sources = applyCliToEnv(parsed.flags, process.env, fileKeys);

  const config = loadConfig();

  // B1: emit a source-log line per resolved value so operators can see which
  // layer won for each knob. Helps diagnose "I set --port=3777 but it's
  // still on 3777 default, why?" confusion by making the resolution path
  // explicit. Written to stderr so stdio transport's stdout stays clean.
  log.info(
    `[config] transport=${config.transport} (source: ${sources.transport}), ` +
      `http_port=${config.http_port} (source: ${sources.http_port}), ` +
      `http_host=${config.http_host} (source: ${sources.http_host}), ` +
      `config_path=${process.env.RELAY_CONFIG_PATH ?? "(default ~/.bot-relay/config.json)"} ` +
      `(source: ${sources.config_path})`
  );

  // v2.0 final (#18): validate config + env BEFORE any init side effects
  // (DB open, port bind, wasm load). Clear aggregate error messages.
  try {
    validateConfigAndEnv(config);
  } catch (err) {
    if (err instanceof InvalidConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // STDIO DAEMON-LAUNCH GUARD — third discriminator, and the history matters
  // because this is the second time the previous one misfired on a legitimate
  // caller. Do not invent a fourth proxy without reading this.
  //
  // INTENT (v2.2.1 B3, unchanged and still correct): `node dist/index.js` from a
  // systemd unit or a background tab defaults to stdio, and stdio dies the
  // moment stdin closes — so the operator's "daemon" vanishes for no visible
  // reason. LOUD REFUSAL BEATS SILENT DAEMON DEATH. The guard is right; only its
  // discriminator has ever been wrong.
  //
  // v2.2.1 asked "is stdin a TTY?" — and over-fired on EVERY real MCP client,
  // because clients pipe stdin rather than attach a terminal.
  // v2.4.2 asked "did bytes arrive within 1500ms?" — better, but still a TIMING
  // PROXY for "is there a client", and it over-fires on any client that connects
  // slowly: a container, a supervisor, an MCP proxy. Measured against the
  // published binary, a client connecting at 3000ms — an entirely ordinary
  // orchestrator — got exit 3 at ~1675ms. v2.4.2's own test list encoded that
  // case as intended ("pipe-but-parent-never-writes exits"), so every test
  // agreed with the defect.
  //
  // WHY NO TIMEOUT CAN WORK: "will a client ever connect?" cannot be decided by
  // waiting. Inside any window, a slow client and an absent one are identical,
  // so a longer window only moves the threshold. Attaching an irreversible
  // action (exit 3) to a predicate observation cannot settle is the same defect
  // this codebase has produced in several unrelated subsystems.
  //
  // NOW: trigger on a DECIDABLE event — stdin reaching EOF having never carried
  // a single byte. A real client holds stdin OPEN however slow it is, so it can
  // never trip this. The daemon mistake yields EOF essentially instantly
  // (measured: ~3ms from /dev/null), so it trips at once — faster AND correct.
  //
  // RELAY_SKIP_TTY_CHECK=1 still bypasses entirely: it is now a no-op safety
  // valve rather than the fix, kept because deployments already depend on it.
  let stdinForMcp: import("node:stream").Readable | undefined;
  if (
    config.transport === "stdio" &&
    !process.stdin.isTTY &&
    process.env.RELAY_SKIP_TTY_CHECK !== "1"
  ) {
    // RELAY_TTY_GRACE_MS is GONE along with the grace window it configured.
    // There is no timer left to tune: the trigger is an event, not a deadline.
    const TTY_GUARD_ERROR =
      `bot-relay exited: the stdio transport received no MCP client, and stdin ` +
      `closed immediately.\n\n` +
      `This usually means the server was started as a background service. The ` +
      `stdio transport is designed to live and die with a connected client, so ` +
      `it cannot run as a daemon.\n\n` +
      `For a long-running service, use HTTP instead:\n` +
      `    RELAY_TRANSPORT=http RELAY_HTTP_PORT=3777 node dist/index.js\n` +
      `  or: node dist/index.js --transport=http --port=3777\n\n` +
      `If a client WAS meant to connect here, it closed stdin without sending ` +
      `anything — check how it was launched. A client that merely connects ` +
      `SLOWLY is fine and will not trigger this.\n\n` +
      `See docs/deployment.md. Bypass with RELAY_SKIP_TTY_CHECK=1.\n`;
    // PassThrough proxy: process.stdin is piped through; the SDK transport
    // consumes from this same stream so a buffered first chunk is delivered
    // intact. 'readable' (not 'data') is non-consuming, so the chunk stays in
    // the proxy's internal buffer for the SDK to read.
    //
    // NOTE: no timer, and no blocking await. The guard is a passive watcher —
    // startup proceeds immediately so a slow client meets a fully-started
    // server, and the SDK reads the first frame out of the proxy whenever it
    // arrives.
    const stdinProxy = new PassThrough();
    process.stdin.pipe(stdinProxy);
    // The decision MUST be reached before the stream is handed to the SDK.
    // A non-blocking watcher loses a race: the SDK sees the same EOF, treats it
    // as an ordinary session end, and exits 0 before the guard ever decides —
    // measured, the daemon mistake exited 0 instead of 3. So we await, but on
    // an EVENT rather than a deadline. There is no timeout: a slow client keeps
    // stdin open and we simply keep waiting, which is the correct behaviour and
    // the entire point of the change.
    await new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        stdinProxy.removeListener("readable", onReadable);
        stdinProxy.removeListener("end", onEnd);
      };
      const onReadable = (): void => {
        if (settled) return;
        if (stdinProxy.readableLength <= 0) {
          // EMPTY 'readable' — this is EOF-with-no-data knocking. A paused
          // stream will NOT emit 'end' until a read() returns null, so without
          // this the EOF branch below never fires at all. Verified: with the
          // read() the daemon case ends at ~4ms; without it, no 'end' ever
          // arrives and only the old timer was catching that case — meaning the
          // previous EOF branch was dead code the timer was covering for.
          // Safe: read() on an empty buffer consumes nothing.
          stdinProxy.read();
          return;
        }
        // Bytes are sitting in the proxy's buffer. Do NOT read them — the SDK
        // drains them when it attaches, so the first frame is never lost.
        settled = true;
        cleanup();
        resolve(); // a client spoke: proceed, and never fire the guard again
      };
      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // EOF having never carried a byte: stdin was never a client. This is
        // the daemon-launch mistake, and it is now DECIDED rather than guessed.
        process.stderr.write(TTY_GUARD_ERROR);
        process.exit(3);
      };
      stdinProxy.on("readable", onReadable);
      stdinProxy.once("end", onEnd);
    });
    stdinForMcp = stdinProxy;
  }

  // REFUSE TO RUN MUTE. Must come BEFORE initializeDb(): if instance resolution
  // is ambiguous we would otherwise create/open the wrong DB and only then fail,
  // leaving a stray empty legacy DB behind as a decoy. Announces the resolved
  // instance + DB path on success so no agent is ever running on a database
  // nobody can identify. See assertInstanceResolution() for why this keys on the
  // multi-instance CONTRADICTION rather than on a missing RELAY_INSTANCE_ID.
  assertInstanceResolution((msg) => log.info(msg));

  // Pre-initialize the DB so schema + purge run up front.
  // v1.11: async init supports both native (sync under hood) and wasm (async wasm load).
  await initializeDb();

  let httpServer: HttpServer | null = null;

  if (config.transport === "http" || config.transport === "both") {
    httpServer = startHttpServer(config.http_port, config.http_host);
    // v2.7 / Tether Phase 3b — cross-process notification tail. Only the
    // HTTP daemon needs it: stdio sessions have direct access to the
    // in-process bus, and there is no supported topology where one stdio
    // process subscribes to another stdio process's inbox. Starting the
    // tail here (after startHttpServer) ensures the daemon is reachable
    // by the time we begin pushing notifications.
    startOutboxTail();
  }

  if (config.transport === "stdio" || config.transport === "both") {
    await startStdioServer(stdinForMcp);
  }

  if (config.transport === "http" && !httpServer) {
    throw new Error("Failed to start HTTP server");
  }

  const shutdown = () => {
    stopOutboxTail();
    if (httpServer) {
      httpServer.close();
    }
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal error:", err);
  closeDb();
  process.exit(1);
});
