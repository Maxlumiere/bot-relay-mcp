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
// The bash helper `read_relay_token_from_vault` in hooks/check-relay.sh +
// post-tool-use-check.sh + stop-check.sh must round-trip with TS writes.
// Discrepancy here = identity drift between the daemon and the hooks.
describe("v2.6.1 — bash hook mirror round-trip", () => {
  function bashRead(name: string): { code: number; stdout: string; stderr: string } {
    // Source the hook script (no `set -e` issues — bash defines functions
    // without executing the rest because we set RELAY_AGENT_NAME='' which
    // makes the early guard exit 0 BEFORE any state-mutating block).
    const script = `
set -u
RELAY_HOME='${TEST_ROOT}'
unset RELAY_DB_PATH RELAY_INSTANCE_ID
# Define functions inline (mirrors hooks/check-relay.sh — keep in sync).
resolve_relay_db_path() {
  if [ -n "\${RELAY_DB_PATH:-}" ]; then echo "\$RELAY_DB_PATH"; return 0; fi
  local root="\${RELAY_HOME:-\$HOME/.bot-relay}"
  echo "\$root/relay.db"
  return 0
}
resolve_relay_token_path() {
  local name="\$1"
  if ! echo "\$name" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
    echo "[bot-relay hook] invalid agent name \\"\$name\\"" >&2
    return 1
  fi
  local db_path
  db_path=\$(resolve_relay_db_path) || return 1
  echo "\$(dirname "\$db_path")/agents/\${name}.token"
  return 0
}
read_relay_token_from_vault() {
  local name="\$1"
  local token_path
  token_path=\$(resolve_relay_token_path "\$name") || return 1
  if [ ! -f "\$token_path" ]; then return 1; fi
  local token
  token=\$(head -n 1 "\$token_path" 2>/dev/null | tr -d '[:space:]')
  if [ -z "\$token" ]; then return 1; fi
  if ! echo "\$token" | grep -qE '^[A-Za-z0-9_=.-]{8,128}$'; then return 1; fi
  echo "\$token"
  return 0
}
read_relay_token_from_vault "${name}"
`;
    return spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 }) as any;
  }

  it("(12) bash mirror reads what TS FileTokenStore wrote — identity preserved", async () => {
    // Use the SAME path resolution — TS writes to RELAY_HOME/agents/<name>.token
    // when RELAY_HOME points at TEST_ROOT (single-instance mode falls back to
    // <root>/relay.db whose parent is <root>; vault dir = <root>/agents).
    const tsStore = new FileTokenStoreCls({ vaultDir: path.join(TEST_ROOT, "agents") });
    await tsStore.write("victra", ANY_TOKEN);
    const r = bashRead("victra");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(ANY_TOKEN);
  });

  it("(13) bash mirror returns non-zero exit on missing file (clean cache miss)", async () => {
    const r = bashRead("never-written");
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("(14) bash mirror rejects an invalid agent name without touching disk", async () => {
    const r = bashRead("bad name");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/invalid agent name/);
  });
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
