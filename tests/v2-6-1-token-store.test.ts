// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.1 — TokenStore + FileTokenStore tests.
 *
 * Unit-level: read / write / delete on a tmp dir, atomic-write under
 * concurrent access, chmod perms (POSIX), shape-validation rejects
 * malformed tokens.
 *
 * Integration: bash hook helpers (resolve_relay_token_path,
 * read_relay_token_from_vault, write_relay_token_to_vault) round-trip
 * with TS FileTokenStore writes — byte-identical mirror discipline.
 *
 * Test path matches shipped path per `feedback_test_path_must_match_shipped_path.md`:
 * the bash mirror is exercised by sourcing the actual hook script and
 * invoking the real shell function, not a TS reimplementation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-token-store-test-" + process.pid);

let store: import("../src/token-store.js").FileTokenStore;
let FileTokenStoreCls: typeof import("../src/token-store.js").FileTokenStore;

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

beforeEach(async () => {
  resetRoot();
  const mod = await import("../src/token-store.js");
  FileTokenStoreCls = mod.FileTokenStore;
  store = new FileTokenStoreCls({ vaultDir: path.join(TEST_ROOT, "agents") });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

const ANY_TOKEN = "Xy0z_Test_Token-WithAllowedChars.123=ab";

describe("v2.6.1 — FileTokenStore unit", () => {
  it("(1) write + read round-trip preserves the token", async () => {
    await store.write("victra", ANY_TOKEN);
    const back = await store.read("victra");
    expect(back).toBe(ANY_TOKEN);
  });

  it("(2) read on a missing agent returns null (cache miss → caller falls through)", async () => {
    const back = await store.read("ghost");
    expect(back).toBeNull();
  });

  it("(3) read on a malformed file returns null (treats as miss, never throws)", async () => {
    const p = store.pathFor("malformed");
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, "this contains spaces and \\funky chars\n");
    const back = await store.read("malformed");
    expect(back).toBeNull();
  });

  it("(4) write rejects malformed token shape", async () => {
    await expect(store.write("bad", "has spaces and stuff")).rejects.toThrow(/shape invalid/);
  });

  it("(5) write rejects too-short token (must be ≥8 chars)", async () => {
    await expect(store.write("short", "abc")).rejects.toThrow(/shape invalid/);
  });

  it("(6) write rejects too-long token (must be ≤128 chars)", async () => {
    const tooLong = "a".repeat(129);
    await expect(store.write("long", tooLong)).rejects.toThrow(/shape invalid/);
  });

  it.skipIf(process.platform === "win32")(
    "(7) POSIX: write produces 0o600 file under 0o700 parent dir",
    async () => {
      await store.write("perms", ANY_TOKEN);
      const fileMode = fs.statSync(store.pathFor("perms")).mode & 0o777;
      const parentMode = fs.statSync(path.dirname(store.pathFor("perms"))).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(parentMode).toBe(0o700);
    }
  );

  it("(8) atomic write: tmp file is gone after rename", async () => {
    await store.write("atomic", ANY_TOKEN);
    const dir = path.dirname(store.pathFor("atomic"));
    const ents = fs.readdirSync(dir);
    // Only the canonical file remains; no stale .tmp.* sibling.
    expect(ents).toEqual(["atomic.token"]);
  });

  it("(9) concurrent writes converge — last writer wins, no half-files", async () => {
    const tokenA = "TokenAAAAAAA-aaa.bbb";
    const tokenB = "TokenBBBBBBBB-ccc.ddd";
    await Promise.all([
      store.write("race", tokenA),
      store.write("race", tokenB),
    ]);
    const back = await store.read("race");
    // Either token is acceptable (race winner) — the failure mode we're
    // guarding against is a corrupt half-file that fails shape validation.
    expect([tokenA, tokenB]).toContain(back);
    // No leftover tmp siblings.
    const dir = path.dirname(store.pathFor("race"));
    const ents = fs.readdirSync(dir).sort();
    expect(ents).toEqual(["race.token"]);
  });

  it("(10) delete is idempotent (missing file is a clean return)", async () => {
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
    await store.write("present", ANY_TOKEN);
    await expect(store.delete("present")).resolves.toBeUndefined();
    expect(await store.read("present")).toBeNull();
  });

  it("(11) pathFor rejects names outside the AGENT_NAME_RE allowlist", () => {
    expect(() => store.pathFor("has space")).toThrow(/invalid agent name/);
    expect(() => store.pathFor("has/slash")).toThrow(/invalid agent name/);
    expect(() => store.pathFor("a".repeat(65))).toThrow(/invalid agent name/);
    // Allowed shape works.
    expect(store.pathFor("ok-name_v1.2")).toMatch(/ok-name_v1\.2\.token$/);
  });
});

// --- Bash hook mirror discipline ---
//
// v2.6.1 R1: tests source the SHIPPED hooks/_vault-helpers.sh — same file the
// 3 hooks + the migration script source. Drift between bash and TS surfaces
// directly as a real test failure (no inline-copy hide-out, per
// memory/feedback_test_path_must_match_shipped_path.md). Codex R0 caught the
// inline-copy weakness; this file closes the contract.
describe("v2.6.1 — bash hook mirror round-trip (sources shipped helper)", () => {
  const HELPER = path.join(REPO_ROOT, "hooks", "_vault-helpers.sh");

  function bashRead(name: string): { status: number; stdout: string; stderr: string } {
    // Source the SHIPPED helper file. RELAY_HOME points at TEST_ROOT so the
    // resolved vault dir is TEST_ROOT/agents — same layout the TS
    // FileTokenStore writes to.
    const script = `
set -u
RELAY_HOME='${TEST_ROOT}'
unset RELAY_DB_PATH RELAY_INSTANCE_ID
. '${HELPER}'
read_relay_token_from_vault '${name}'
`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function bashWriteThenReadViaTs(name: string, token: string): {
    bashStatus: number;
    bashStderr: string;
    tsRead: string | null;
  } {
    // Inverse direction: bash WRITES the vault, then TS FileTokenStore reads
    // back. Closes the dispatch contract — drift in EITHER direction surfaces.
    const script = `
set -u
RELAY_HOME='${TEST_ROOT}'
unset RELAY_DB_PATH RELAY_INSTANCE_ID
. '${HELPER}'
write_relay_token_to_vault '${name}' '${token}'
`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
    // Read with a NEW FileTokenStore instance pointed at the same vault dir.
    const tsStoreLocal = new FileTokenStoreCls({ vaultDir: path.join(TEST_ROOT, "agents") });
    // Sync read for parity with the daemon's resolveToken path.
    return {
      bashStatus: r.status ?? -1,
      bashStderr: r.stderr ?? "",
      tsRead: tsStoreLocal.readSync(name),
    };
  }

  it("(12) shipped helper reads what TS FileTokenStore wrote (TS-write → bash-read)", async () => {
    const tsStore = new FileTokenStoreCls({ vaultDir: path.join(TEST_ROOT, "agents") });
    await tsStore.write("victra", ANY_TOKEN);
    const r = bashRead("victra");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(ANY_TOKEN);
  });

  it("(12b) shipped helper write is read by TS (bash-write → TS-read) — bidirectional contract", () => {
    const r = bashWriteThenReadViaTs("inverse", ANY_TOKEN);
    expect(r.bashStatus).toBe(0);
    expect(r.tsRead).toBe(ANY_TOKEN);
  });

  it("(13) shipped helper returns non-zero exit on missing file (clean cache miss)", () => {
    const r = bashRead("never-written");
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("(14) shipped helper rejects an invalid agent name without touching disk", () => {
    const r = bashRead("bad name");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/invalid agent name/);
  });

  it("(14b) all 3 hooks + migration script source the same helper file AND do not redefine its functions", () => {
    // Drift guard: every hook script + migration script must `source` the
    // helper. Inline copies would silently drift and recreate the v2.4.5
    // R2 split-brain class of bug.
    //
    // v2.6.1 R2 strengthening (codex P2): the previous test only asserted
    // that consumers REFERENCE _vault-helpers.sh. A consumer could source
    // the helper AND ALSO define its own copy of `read_relay_token_from_vault`
    // (or any of the four helpers) inline, and the test would still pass —
    // recreating the split-brain risk one inline override at a time. The
    // body search below rejects any consumer-side function definition for
    // the four helper functions; only `hooks/_vault-helpers.sh` may define
    // them.
    const consumers = [
      "hooks/check-relay.sh",
      "hooks/post-tool-use-check.sh",
      "hooks/stop-check.sh",
      "scripts/migrate-existing-tokens-to-vault.sh",
    ];
    const FORBIDDEN_DEFS = [
      /^resolve_relay_db_path\s*\(\s*\)/m,
      /^resolve_relay_token_path\s*\(\s*\)/m,
      /^read_relay_token_from_vault\s*\(\s*\)/m,
      /^write_relay_token_to_vault\s*\(\s*\)/m,
    ];
    for (const c of consumers) {
      const body = fs.readFileSync(path.join(REPO_ROOT, c), "utf-8");
      expect(body).toMatch(/_vault-helpers\.sh/);
      for (const re of FORBIDDEN_DEFS) {
        expect(
          body,
          `${c} re-defines a vault helper function inline — must source hooks/_vault-helpers.sh and NOT shadow it. Pattern matched: ${re}`,
        ).not.toMatch(re);
      }
    }
    // And the helper itself must define every function the consumers expect.
    const helper = fs.readFileSync(HELPER, "utf-8");
    expect(helper).toMatch(/^resolve_relay_db_path\(\)/m);
    expect(helper).toMatch(/^resolve_relay_token_path\(\)/m);
    expect(helper).toMatch(/^read_relay_token_from_vault\(\)/m);
    expect(helper).toMatch(/^write_relay_token_to_vault\(\)/m);
  });
});

// --- FIX 1 macOS prelude: launching shell hydrates RELAY_AGENT_TOKEN from vault ---
describe("v2.6.1 R1 — FIX 1 launching-shell vault prelude (macOS spawn-agent.sh)", () => {
  it.skipIf(process.platform !== "darwin")(
    "(16) spawn-agent.sh CMD includes a vault-read prelude AND running it sets RELAY_AGENT_TOKEN to the vault content",
    async () => {
      // Pre-write the vault file the prelude will read.
      const SPAWN_TEST_ROOT = path.join(os.tmpdir(), "v2-6-1-prelude-" + process.pid);
      if (fs.existsSync(SPAWN_TEST_ROOT)) fs.rmSync(SPAWN_TEST_ROOT, { recursive: true, force: true });
      fs.mkdirSync(SPAWN_TEST_ROOT, { recursive: true, mode: 0o700 });
      const VAULT_DIR = path.join(SPAWN_TEST_ROOT, "agents");
      fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
      const VAULT_FILE = path.join(VAULT_DIR, "prelude-agent.token");
      const KNOWN_TOKEN = "Prelude_Token-FromVaultFile.123_abc";
      fs.writeFileSync(VAULT_FILE, KNOWN_TOKEN + "\n", { mode: 0o600 });

      // Run spawn-agent.sh in DRY_RUN mode to capture the assembled CMD
      // string. The prelude must use this exact vault path.
      const SPAWN_SCRIPT = path.join(REPO_ROOT, "bin", "spawn-agent.sh");
      const dry = spawnSync(
        SPAWN_SCRIPT,
        // cwd must be "/tmp" specifically (not os.tmpdir(), which on macOS
        // resolves to /private/var/folders — outside spawn-agent.sh's
        // approved-roots case statement).
        ["prelude-agent", "builder", "", "/tmp"],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: {
            // Pass through HOME + PATH (spawn-agent.sh runs `set -u` and
            // touches $HOME during cwd resolution at line ~185 + line ~190).
            HOME: process.env.HOME || os.tmpdir(),
            PATH: process.env.PATH || "/usr/bin:/bin",
            RELAY_HOME: SPAWN_TEST_ROOT,
            RELAY_SPAWN_DRY_RUN: "1",
            // Avoid colliding with the operator's real instance.
            RELAY_INSTANCE_ID: "",
            RELAY_DB_PATH: "",
          },
        }
      );
      if (dry.status !== 0) {
        // surface the failure reason (stderr) so the test message is useful
        // when debugging cross-platform regressions.
        throw new Error(
          `spawn-agent.sh exited ${dry.status}\nstderr: ${dry.stderr}\nstdout: ${dry.stdout}`
        );
      }
      const cmdLine = (dry.stdout || "")
        .split("\n")
        .find((l) => l.startsWith("CMD="));
      expect(cmdLine).toBeDefined();
      const cmd = cmdLine!.replace(/^CMD=/, "");
      // The prelude must reference the resolved vault path AND include
      // `export RELAY_AGENT_TOKEN`. Both verbatim per spawn-agent.sh.
      expect(cmd).toContain(VAULT_FILE);
      expect(cmd).toMatch(/export RELAY_AGENT_TOKEN/);
      expect(cmd).toMatch(/grep -Eq '\^\[A-Za-z0-9_=\.-\]\{8,128\}\$'/);

      // Now invoke the prelude in a tmp shell, replacing the `claude ...`
      // call with a printenv. Strip everything from `cd ` onwards (the
      // launch tail) and append our probe.
      const cdIdx = cmd.indexOf("cd ");
      expect(cdIdx).toBeGreaterThan(0);
      const preludeOnly = cmd.slice(0, cdIdx).trim();
      // `printenv RELAY_AGENT_TOKEN` exits non-zero when the var is unset.
      // Mask with `|| true` so the negative case (vault missing) doesn't
      // confuse the test assertion — we check stdout content for both
      // positive (token from vault) and negative (empty) cases.
      const probe = `${preludeOnly} printenv RELAY_AGENT_TOKEN || true`;
      const r = spawnSync("bash", ["-lc", probe], {
        encoding: "utf-8",
        timeout: 5000,
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          // Crucially: NO RELAY_AGENT_TOKEN in env. The prelude must
          // populate it from the vault file alone.
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(KNOWN_TOKEN);

      // Negative case: deleting the vault file makes the prelude a no-op.
      fs.unlinkSync(VAULT_FILE);
      const r2 = spawnSync("bash", ["-lc", probe], {
        encoding: "utf-8",
        timeout: 5000,
        env: { PATH: process.env.PATH || "/usr/bin:/bin" },
      });
      expect(r2.status).toBe(0);
      expect(r2.stdout.trim()).toBe(""); // env stays empty when vault is missing

      fs.rmSync(SPAWN_TEST_ROOT, { recursive: true, force: true });
    }
  );
});

// --- FIX 2 v2 daemon-side: vault fallback is STDIO-ONLY, never HTTP ---
//
// v2.6.1 R2 background: codex caught (msg d1fbbdde, 2026-05-05) that the R1
// implementation let HTTP callers reach the vault by passing args.agent_name
// — turning the local file vault into a network-reachable auth oracle. R2
// gates the fallback on `currentContext().transport === "stdio"` and drops
// the args.agent_name path entirely. These two tests pin both halves of the
// security boundary: stdio path WORKS (positive), HTTP path REFUSES (negative).
describe("v2.6.1 R2 — FIX 2 v2 daemon resolveToken vault fallback (stdio-only)", () => {
  it("(17) stdio MCP server authenticates from vault when env/args/header all empty (RELAY_AGENT_NAME set at fork)", async () => {
    // Strategy: spawn an HTTP daemon transiently to register the agent + capture
    // a real token (mints `agents.token_hash`), kill it, write the token to the
    // vault file, then spawn a real stdio MCP subprocess pointed at the SAME DB
    // with RELAY_AGENT_NAME set + RELAY_AGENT_TOKEN explicitly empty. Drive the
    // subprocess via stdin/stdout JSON-RPC (newline-delimited, per MCP spec).
    // resolveToken's stdio-gated vault fallback must consult the file and auth
    // the get_messages call from the disk token alone.
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-1-r2-test17-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");

    // Phase 1 — HTTP daemon: register the agent, capture its real token.
    const httpChild = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let TOKEN: string;
    try {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/health`);
          if (r.ok) break;
        } catch {
          /* not up yet */
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      const regBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "register_agent",
          arguments: { name: "stdio-vault-agent", role: "tester", capabilities: [] },
        },
      };
      const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(regBody),
      });
      const text = await resp.text();
      const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
      const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
      const rpc = JSON.parse(payload);
      const inner = JSON.parse(rpc.result.content[0].text);
      expect(inner.success).toBe(true);
      TOKEN = inner.agent_token;
      expect(TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
    } finally {
      httpChild.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { httpChild.kill("SIGKILL"); } catch { /* already dead */ }
    }

    // Brief settle so the HTTP daemon fully releases the DB before the stdio
    // child opens it. better-sqlite3 in WAL mode releases on process exit.
    await new Promise((res) => setTimeout(res, 200));

    // Phase 2 — write the vault file the stdio resolveToken will consult.
    const VAULT_FILE = path.join(ROOT, "agents", "stdio-vault-agent.token");
    fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(VAULT_FILE, TOKEN + "\n", { mode: 0o600 });

    // Phase 3 — stdio MCP subprocess. Same DB. RELAY_AGENT_NAME set;
    // RELAY_AGENT_TOKEN is explicitly empty so the env precedence step
    // returns null and the vault fallback runs.
    const stdioChild = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "stdio",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_NAME: "stdio-vault-agent",
        RELAY_AGENT_TOKEN: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      // Buffer stdout, parse newline-delimited JSON-RPC messages.
      let outBuf = "";
      const responses: any[] = [];
      stdioChild.stdout!.on("data", (chunk: Buffer) => {
        outBuf += chunk.toString("utf-8");
        let idx;
        while ((idx = outBuf.indexOf("\n")) !== -1) {
          const line = outBuf.slice(0, idx).trim();
          outBuf = outBuf.slice(idx + 1);
          if (line) {
            try {
              responses.push(JSON.parse(line));
            } catch {
              /* not JSON-RPC, ignore */
            }
          }
        }
      });

      async function awaitId(id: number, timeoutMs: number): Promise<any> {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const r = responses.find((x) => x.id === id);
          if (r) return r;
          await new Promise((res) => setTimeout(res, 50));
        }
        throw new Error(
          `timeout waiting for JSON-RPC id ${id}; responses so far: ${JSON.stringify(responses)}`
        );
      }

      // MCP handshake: initialize → notifications/initialized → tools/call.
      stdioChild.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "v2-6-1-r2-test", version: "0" },
          },
        }) + "\n"
      );
      await awaitId(1, 5000);

      stdioChild.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }) + "\n"
      );

      // The actual auth probe: get_messages with NO agent_token in args,
      // NO X-Agent-Token (stdio has no headers), NO RELAY_AGENT_TOKEN env.
      // resolveToken must fall through stdio gate → readSync vault → match.
      stdioChild.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_messages",
            arguments: { agent_name: "stdio-vault-agent", status: "pending", limit: 5 },
          },
        }) + "\n"
      );

      const callResp = await awaitId(2, 5000);
      expect(callResp.result).toBeDefined();
      const inner = JSON.parse(callResp.result.content[0].text);
      // Auth succeeded → structured response with messages array.
      expect(Array.isArray(inner.messages)).toBe(true);
      expect(inner.count).toBe(0);
      // Belt-and-suspenders: confirm no auth_error envelope leaked through.
      expect(inner.auth_error).toBeUndefined();
    } finally {
      stdioChild.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { stdioChild.kill("SIGKILL"); } catch { /* already dead */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);

  it("(17b) HTTP daemon REFUSES vault fallback even with a valid vault file present (R2 security boundary)", async () => {
    // The R1 implementation honored args.agent_name in resolveCallerNameForVault
    // and let an HTTP caller bypass auth by naming any registered agent. Codex
    // flagged this as an auth oracle (msg d1fbbdde). R2 gates resolveToken on
    // ctx.transport === "stdio" AND drops the args.agent_name path entirely.
    //
    // This test pins the negative case end-to-end: write a valid vault file
    // for a real agent, then POST get_messages over HTTP with args.agent_name
    // set + NO TOKEN through any channel. R2 must respond AUTH_FAILED (the
    // vault is never consulted on the HTTP path). A control call with the
    // real X-Agent-Token confirms the daemon is healthy and the refusal is
    // due to the transport gate, not an unrelated bug.
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-1-r2-test17b-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");
    const child = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/health`);
          if (r.ok) break;
        } catch {
          /* not up yet */
        }
        await new Promise((res) => setTimeout(res, 100));
      }

      async function rpc(args: any, headers: Record<string, string> = {}): Promise<any> {
        const allHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        };
        const body = {
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 1e9),
          method: "tools/call",
          params: { name: args.name, arguments: args.arguments },
        };
        const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
          method: "POST",
          headers: allHeaders,
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
        const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
        const rpcResp = JSON.parse(payload);
        const inner = rpcResp.result?.content?.[0]?.text;
        return inner ? JSON.parse(inner) : rpcResp;
      }

      // Register the target — populates `agents` row with a real token_hash.
      const reg = await rpc({
        name: "register_agent",
        arguments: { name: "vault-agent", role: "tester", capabilities: [] },
      });
      expect(reg.success).toBe(true);
      const REAL_TOKEN = reg.agent_token;
      expect(REAL_TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);

      // Write the vault file with the REAL token. If R2 didn't gate, this
      // file would be readable by any HTTP caller naming "vault-agent".
      const VAULT_FILE = path.join(ROOT, "agents", "vault-agent.token");
      fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(VAULT_FILE, REAL_TOKEN + "\n", { mode: 0o600 });

      // ATTACK: HTTP caller passes args.agent_name with no token / header / env.
      // Must AUTH_FAILED — vault is stdio-only; transport gate short-circuits.
      const attack = await rpc({
        name: "get_messages",
        arguments: { agent_name: "vault-agent", status: "pending", limit: 5 },
      });
      expect(attack.auth_error).toBe(true);
      expect(attack.error_code).toBe("AUTH_FAILED");
      expect(attack.success).toBe(false);

      // CONTROL: same call with the real X-Agent-Token succeeds — confirms the
      // refusal above is due to the R2 transport gate, not an unrelated bug.
      const ok = await rpc(
        {
          name: "get_messages",
          arguments: { agent_name: "vault-agent", status: "pending", limit: 5 },
        },
        { "X-Agent-Token": REAL_TOKEN }
      );
      expect(Array.isArray(ok.messages)).toBe(true);
      expect(ok.auth_error).toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 15_000);

  it("(17d) health_check REFUSES env-token fallback on HTTP — info-disclosure oracle closed (R3 / v2.6.2 codex non-blocking note)", async () => {
    // health_check is no-auth, BUT if a token validates it returns agent_name
    // + auth_state (per src/server.ts:567 description). The R3 patch closed
    // resolveTokenForHealthCheck's env-token oracle in src/tools/status.ts
    // alongside the main resolveToken fix; codex flagged the missing
    // shipped-path test as a non-blocking residual on the R3 audit. v2.6.2
    // closes that gap. Pattern mirrors test 17c exactly but probes
    // health_check rather than get_messages.
    //
    // The leak shape: an HTTP caller with no creds calls health_check, the
    // daemon validates its own env-token, response carries agent_name +
    // auth_state of whoever owns that env token. Even though no
    // authenticated action runs, the caller learns "this daemon belongs to
    // <agent>" — same bug class as the resolveToken vault/env oracles.
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-2-test17d-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");

    async function rpc(
      port: number,
      args: any,
      headers: Record<string, string> = {},
    ): Promise<any> {
      const allHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      };
      const body = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name: args.name, arguments: args.arguments },
      };
      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
      const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
      const rpcResp = JSON.parse(payload);
      const inner = rpcResp.result?.content?.[0]?.text;
      return inner ? JSON.parse(inner) : rpcResp;
    }

    async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          if (r.ok) return;
        } catch {
          /* not up yet */
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
    }

    // Phase A — clean HTTP daemon, register health-oracle-agent, capture token, kill.
    let REAL_TOKEN: string;
    {
      const child = spawn("node", [DIST_INDEX], {
        env: {
          ...process.env,
          RELAY_TRANSPORT: "http",
          RELAY_HTTP_PORT: String(PORT),
          RELAY_HTTP_HOST: "127.0.0.1",
          RELAY_HOME: ROOT,
          RELAY_DB_PATH: path.join(ROOT, "relay.db"),
          RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
          RELAY_AGENT_TOKEN: "",
          RELAY_AGENT_NAME: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForHealth(PORT, 5000);
        const reg = await rpc(PORT, {
          name: "register_agent",
          arguments: { name: "health-oracle-agent", role: "tester", capabilities: [] },
        });
        expect(reg.success).toBe(true);
        REAL_TOKEN = reg.agent_token;
        expect(REAL_TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      } finally {
        child.kill("SIGTERM");
        await new Promise((res) => setTimeout(res, 200));
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }

    await new Promise((res) => setTimeout(res, 200));

    // Phase B — re-spawn the daemon with RELAY_AGENT_TOKEN baked into env.
    // If R3 didn't gate, an unauthenticated HTTP caller could probe
    // health_check and learn agent_name + auth_state for free.
    const child = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: REAL_TOKEN,
        RELAY_AGENT_NAME: "health-oracle-agent",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForHealth(PORT, 5000);

      // ATTACK: health_check with NO token through any caller-presented channel.
      // Must NOT include agent_name / auth_state in the response (because the
      // env-token gate refuses the read on HTTP and the no-token branch returns
      // a token_validated:false envelope instead).
      const attack = await rpc(PORT, {
        name: "health_check",
        arguments: {},
      });
      expect(attack.status).toBe("ok"); // health_check still succeeds (no-auth tool)
      expect(attack.agent_name).toBeUndefined();
      expect(attack.auth_state).toBeUndefined();
      // token_validated should NOT be true (either undefined or false — the
      // resolver returned null so the validation block didn't run).
      expect(attack.token_validated).not.toBe(true);

      // CONTROL: same call with the real X-Agent-Token. Response MUST include
      // agent_name + auth_state ('active') — proves the daemon is healthy AND
      // the env token belongs to this agent (so the attack refusal above is
      // the R3 transport gate, not an unrelated bug).
      const ok = await rpc(
        PORT,
        { name: "health_check", arguments: {} },
        { "X-Agent-Token": REAL_TOKEN },
      );
      expect(ok.status).toBe("ok");
      expect(ok.token_validated).toBe(true);
      expect(ok.agent_name).toBe("health-oracle-agent");
      expect(ok.auth_state).toBe("active");
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);

  it("(17c) HTTP daemon REFUSES env-token fallback — auth cannot bypass via daemon's own RELAY_AGENT_TOKEN env (R3 security boundary)", async () => {
    // Codex caught (msg 2cbe68a2, 2026-05-05) on R2 audit that R2 closed only
    // the vault half of the auth-oracle bug class. Item 3 of the precedence
    // chain (process.env.RELAY_AGENT_TOKEN) was still ungated: an HTTP daemon
    // launched with RELAY_AGENT_TOKEN in its env (a totally normal operator
    // pattern when the operator runs a stdio + HTTP combo) would let any
    // unauthenticated HTTP caller authenticate against the daemon's own env
    // token. R3 generalizes the rule: items 3 and 4 (daemon-side credentials)
    // are both gated on ctx.transport === "stdio". This test pins the
    // env-token half of the boundary; test 17b pins the vault half.
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-1-r3-test17c-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");

    async function rpc(
      port: number,
      args: any,
      headers: Record<string, string> = {},
    ): Promise<any> {
      const allHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      };
      const body = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name: args.name, arguments: args.arguments },
      };
      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
      const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
      const rpcResp = JSON.parse(payload);
      const inner = rpcResp.result?.content?.[0]?.text;
      return inner ? JSON.parse(inner) : rpcResp;
    }

    async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          if (r.ok) return;
        } catch {
          /* not up yet */
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
    }

    // Phase A — clean HTTP daemon (no env-token), register agent, capture
    // its real token, kill the daemon. The DB at ROOT/relay.db now carries
    // the agents row + token_hash for env-oracle-agent.
    let REAL_TOKEN: string;
    {
      const child = spawn("node", [DIST_INDEX], {
        env: {
          ...process.env,
          RELAY_TRANSPORT: "http",
          RELAY_HTTP_PORT: String(PORT),
          RELAY_HTTP_HOST: "127.0.0.1",
          RELAY_HOME: ROOT,
          RELAY_DB_PATH: path.join(ROOT, "relay.db"),
          RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
          RELAY_AGENT_TOKEN: "",
          RELAY_AGENT_NAME: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForHealth(PORT, 5000);
        const reg = await rpc(PORT, {
          name: "register_agent",
          arguments: { name: "env-oracle-agent", role: "tester", capabilities: [] },
        });
        expect(reg.success).toBe(true);
        REAL_TOKEN = reg.agent_token;
        expect(REAL_TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      } finally {
        child.kill("SIGTERM");
        await new Promise((res) => setTimeout(res, 200));
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }

    // Brief settle so the DB lock from phase A fully releases before phase B
    // opens the same DB.
    await new Promise((res) => setTimeout(res, 200));

    // Phase B — re-spawn the SAME daemon (same DB) WITH the real token
    // baked into RELAY_AGENT_TOKEN env. If R3 didn't gate, an HTTP caller
    // with no creds could authenticate against this env token by naming
    // env-oracle-agent in args.agent_name.
    const child = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        // The bug under test: this env exists, R2 would have honored it on
        // every HTTP call. R3 must refuse.
        RELAY_AGENT_TOKEN: REAL_TOKEN,
        RELAY_AGENT_NAME: "env-oracle-agent",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForHealth(PORT, 5000);

      // ATTACK: HTTP get_messages with args.agent_name set + NO token through
      // any caller-presented channel (no agent_token arg, no X-Agent-Token
      // header). R3 must refuse: env-token is daemon-side and stdio-only.
      const attack = await rpc(PORT, {
        name: "get_messages",
        arguments: { agent_name: "env-oracle-agent", status: "pending", limit: 5 },
      });
      expect(attack.auth_error).toBe(true);
      expect(attack.error_code).toBe("AUTH_FAILED");
      expect(attack.success).toBe(false);

      // CONTROL: same call with the real X-Agent-Token succeeds — confirms
      // the refusal is the R3 gate, not an unrelated bug. The control proves
      // the daemon is healthy AND that the env token is the right one for
      // this agent (so the gate, not a token mismatch, is what blocks the
      // attack call).
      const ok = await rpc(
        PORT,
        {
          name: "get_messages",
          arguments: { agent_name: "env-oracle-agent", status: "pending", limit: 5 },
        },
        { "X-Agent-Token": REAL_TOKEN },
      );
      expect(Array.isArray(ok.messages)).toBe(true);
      expect(ok.auth_error).toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);
});

// --- handleSpawnAgent integration: vault is written before driver dispatch ---
describe("v2.6.1 — spawn-flow vault integration", () => {
  it("(15) handleSpawnAgent writes the vault BEFORE the driver runs (DRY_RUN=1 capture)", async () => {
    // Re-import with TEST_ROOT-scoped DB and vault; this runs in a separate
    // process boundary from the unit tests above so we don't conflict with
    // their default-singleton state.
    process.env.RELAY_DB_PATH = path.join(TEST_ROOT, "spawn-relay.db");
    process.env.RELAY_HOME = TEST_ROOT;
    process.env.RELAY_SPAWN_DRY_RUN = "1";
    delete process.env.RELAY_AGENT_TOKEN;
    delete process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_AGENT_ROLE;

    const { handleSpawnAgent } = await import("../src/tools/spawn.js");
    const { closeDb } = await import("../src/db.js");
    const { _resetDefaultTokenStoreForTests } = await import("../src/token-store.js");
    closeDb();
    _resetDefaultTokenStoreForTests();

    const result = await handleSpawnAgent({
      name: "spawn-vault-child",
      role: "builder",
      capabilities: ["build"],
    } as any);
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.agent_token).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);

    // Vault file should exist on disk and contain the same plaintext token.
    const vp = path.join(TEST_ROOT, "agents", "spawn-vault-child.token");
    expect(fs.existsSync(vp)).toBe(true);
    expect(fs.readFileSync(vp, "utf-8").trim()).toBe(parsed.agent_token);

    delete process.env.RELAY_SPAWN_DRY_RUN;
    delete process.env.RELAY_HOME;
    closeDb();
  });
});
