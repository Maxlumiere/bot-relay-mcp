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

  it("(14b) all 3 hooks + migration script source the same helper file", () => {
    // Drift guard: every hook script + migration script must `source` the
    // helper. Inline copies would silently drift and recreate the v2.4.5
    // R2 split-brain class of bug.
    const consumers = [
      "hooks/check-relay.sh",
      "hooks/post-tool-use-check.sh",
      "hooks/stop-check.sh",
      "scripts/migrate-existing-tokens-to-vault.sh",
    ];
    for (const c of consumers) {
      const body = fs.readFileSync(path.join(REPO_ROOT, c), "utf-8");
      expect(body).toMatch(/_vault-helpers\.sh/);
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

// --- FIX 2 daemon-side: resolveToken falls back to vault when env is empty ---
describe("v2.6.1 R1 — FIX 2 daemon resolveToken vault fallback", () => {
  it("(17) HTTP daemon authenticates a get_messages call with no env / no header / no args.agent_token, using vault read", async () => {
    // Spawn an isolated HTTP daemon with its own DB + RELAY_HOME. Then
    // register an agent (which mints a token), write that token to the
    // vault file at the expected path, and make a follow-up get_messages
    // call WITHOUT providing the token through any of the three explicit
    // channels (args.agent_token / X-Agent-Token / RELAY_AGENT_TOKEN env).
    // resolveToken's vault fallback (FIX 2) must look up the agent name
    // from args.agent_name + read the vault file + match.
    const PORT = 39411;
    const ROOT = path.join(os.tmpdir(), "v2-6-1-fix2-" + process.pid);
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
        // Ensure no operator token leaks into the daemon's env — the
        // whole point is to verify resolveToken falls back to the vault.
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      // Wait for /health.
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

      async function rpc(args: any, token?: string): Promise<any> {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        };
        if (token) headers["X-Agent-Token"] = token;
        const body = {
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 1e9),
          method: "tools/call",
          params: { name: args.name, arguments: args.arguments },
        };
        const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        // Parse SSE-framed body or plain JSON.
        const dataLine = text
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("data:"));
        const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
        const rpcResp = JSON.parse(payload);
        const inner = rpcResp.result?.content?.[0]?.text;
        return inner ? JSON.parse(inner) : rpcResp;
      }

      // Register an agent — captures a fresh token.
      const reg = await rpc({
        name: "register_agent",
        arguments: {
          name: "fix2-agent",
          role: "tester",
          capabilities: [],
        },
      });
      expect(reg.success).toBe(true);
      const TOKEN = reg.agent_token;
      expect(TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);

      // Write the token to the vault path the daemon will resolve.
      // Single-instance mode: <ROOT>/agents/<name>.token.
      const VAULT_FILE = path.join(ROOT, "agents", "fix2-agent.token");
      fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(VAULT_FILE, TOKEN + "\n", { mode: 0o600 });

      // Make get_messages WITHOUT explicit token. Only agent_name in args
      // — the daemon's resolveToken must fall through to the vault.
      const got = await rpc({
        name: "get_messages",
        arguments: {
          agent_name: "fix2-agent",
          status: "pending",
          limit: 5,
          // explicitly no agent_token field
        },
      });
      // Auth succeeded if we got a structured response with messages
      // array (count: 0 is fine — agent is fresh). Auth failure would
      // return an error envelope with auth_error: true.
      expect(got).toBeDefined();
      expect(Array.isArray(got.messages)).toBe(true);
      expect(got.count).toBe(0);
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 15_000);
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
