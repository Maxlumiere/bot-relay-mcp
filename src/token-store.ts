// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.1 — TokenStore abstraction + FileTokenStore default impl.
 *
 * Local-machine credential vault for agent identity. The bug this closes:
 * when a child terminal spawned without a pre-minted token, the SessionStart
 * hook called `register_agent` over HTTP, the relay correctly minted a fresh
 * `agent_token` and returned it in the response body — and the script
 * discarded the response. 3-minute spawn-to-broken-state.
 *
 * The vault makes identity persistent + bootstrap automatic:
 *
 *   - **First spawn** of a fresh agent name. Hook checks the vault, miss,
 *     calls `register_agent`, captures `agent_token` from the response,
 *     writes `<instanceDir>/agents/<name>.token` (chmod 0o600, parent dir
 *     0o700), exports `RELAY_AGENT_TOKEN`. First MCP call authenticates.
 *
 *   - **Re-spawn** of the same agent (terminal closed + reopened). Hook
 *     finds the file, reads, exports. No re-registration. Same identity,
 *     same mailbox, no operator mediation.
 *
 *   - **Lost / corrupted file** is treated as cache miss. Hook calls
 *     `register_agent`. The daemon refuses with `NAME_COLLISION_ACTIVE`
 *     (the row exists from the first registration); the hook's stderr path
 *     points the operator at `relay recover <name>`.
 *
 *   - **Token revoked elsewhere**. Hook reads stale file, exports, the
 *     agent's first MCP call fails `AUTH_FAILED`. Recovery flow resets
 *     vault file via `relay recover`.
 *
 * Pluggable interface so future v2.9+ can plug in OS-specific credential
 * helpers (macOS Keychain, Windows Credential Manager, libsecret, 1Password,
 * Vault) without breaking changes. Same shape as `docker credential-helpers`,
 * `git credential helper`, `gh auth`, `aws configure`, `kubectl config`.
 *
 * Cross-platform parity from day one (per `feedback_cross_platform_parity.md`):
 *   - macOS / Linux: POSIX perms (0o600 file, 0o700 parent).
 *   - Windows: NTFS profile-dir defaults inherit user-restricted ACL from
 *     `%USERPROFILE%`. We do not (and cannot, without `icacls` shell-out)
 *     verify ACL at write time. Operator-visible note in
 *     `docs/agents/local-identity.md` + `SECURITY.md`.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { resolveInstanceDbPath } from "./instance.js";

/** Pluggable credential vault interface. v2.9+ may add Keychain / Vault impls. */
export interface TokenStore {
  read(agentName: string): Promise<string | null>;
  write(agentName: string, token: string): Promise<void>;
  delete(agentName: string): Promise<void>;
}

/**
 * Token shape allowlist — mirrors the regex in `src/spawn/validation.ts:164`
 * (`isValidTokenShape`) and the bash mirror in `bin/spawn-agent.sh:101`
 * + `hooks/check-relay.sh` vault read. Same defense-in-depth pattern as the
 * other places: any one of them could drift, but a malformed token reaching
 * the env or the AppleScript embedding could smuggle characters through
 * downstream escaping. Keep in sync.
 */
const TOKEN_SHAPE_RE = /^[A-Za-z0-9_=.-]{8,128}$/;

/** Sanitize agent name for filesystem use. Mirrors `register_agent` allowlist. */
const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function assertValidAgentName(name: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `TokenStore: invalid agent name "${name}" — must match /^[A-Za-z0-9_.-]{1,64}$/`
    );
  }
}

/**
 * Resolve the vault directory for the active instance. Mirrors
 * `resolveInstanceDbPath()` so DB and vault always live together — no
 * split-brain where the daemon serves per-instance DB while the vault sits
 * in legacy.
 *
 * Returns: `<instanceDir>/agents` for multi-instance, or
 * `~/.bot-relay/agents` in single-instance legacy mode.
 */
export function resolveAgentVaultDir(): string {
  const dbPath = resolveInstanceDbPath();
  return path.join(path.dirname(dbPath), "agents");
}

export class FileTokenStore implements TokenStore {
  /** Override for tests. Production uses `resolveAgentVaultDir()`. */
  private readonly vaultDir: string;

  constructor(opts: { vaultDir?: string } = {}) {
    this.vaultDir = opts.vaultDir ?? resolveAgentVaultDir();
  }

  /** Vault file path for a given agent name. */
  pathFor(agentName: string): string {
    assertValidAgentName(agentName);
    return path.join(this.vaultDir, `${agentName}.token`);
  }

  /**
   * Read the cached token for `agentName`. Returns null on miss, malformed
   * content, or any IO error. Never throws on the read path — every failure
   * mode is treated as a cache miss so the caller falls through to the
   * `register_agent` path cleanly.
   *
   * Token shape is validated to defense-in-depth against a tampered file
   * (an attacker-writable home dir is already game-over, but we don't want
   * a malformed string flowing through to AppleScript embedding or HTTP
   * headers downstream).
   */
  async read(agentName: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.pathFor(agentName), "utf-8");
    } catch {
      return null;
    }
    const trimmed = raw.trim();
    if (!TOKEN_SHAPE_RE.test(trimmed)) return null;
    return trimmed;
  }

  /**
   * v2.6.1 R1 — sync read variant for the daemon hot path
   * (`src/server.ts:resolveToken`). Codex caught that v2.6.1 R0 wrote to the
   * vault but never CONSUMED it on the daemon side: stdio MCP servers fork
   * with whatever env they inherit, and the SessionStart hook's `export
   * RELAY_AGENT_TOKEN` only mutates the hook subprocess. The daemon must
   * fall through to a vault read when the env-supplied token is empty.
   *
   * Sync to avoid cascading every auth-gated tool to async — vault read is
   * a single-line file (microseconds). Same shape semantics as `read`:
   * never throws on miss/malformed/IO error; always returns null in those
   * cases so the caller falls cleanly through to "no token".
   */
  readSync(agentName: string): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.pathFor(agentName), "utf-8");
    } catch {
      return null;
    }
    const trimmed = raw.trim();
    if (!TOKEN_SHAPE_RE.test(trimmed)) return null;
    return trimmed;
  }

  /**
   * Atomic write: tmp file + rename. The rename step is atomic on POSIX
   * filesystems and on NTFS for same-volume operations (always true here —
   * tmp is a sibling of the target). Concurrent spawns of the same agent
   * name converge on the last-writer's value without the file ever appearing
   * partially written.
   *
   * Perms: file 0o600, parent dir 0o700. On Windows, `chmod` is a best-effort
   * no-op; the parent dir under `%USERPROFILE%` already inherits a user-
   * restricted ACL by default (documented in SECURITY.md). v2.9+ Windows
   * Credential Manager helper will move beyond profile-dir defaults.
   */
  async write(agentName: string, token: string): Promise<void> {
    if (!TOKEN_SHAPE_RE.test(token)) {
      throw new Error(
        `TokenStore.write: token shape invalid for "${agentName}" — must match /^[A-Za-z0-9_=.-]{8,128}$/`
      );
    }
    const target = this.pathFor(agentName);
    const dir = path.dirname(target);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // Best-effort chmod after mkdir — handles the case where the dir already
    // existed at a looser mode (e.g. legacy ~/.bot-relay created at 0o755
    // pre-v2.1 Phase 4c.4). On Windows, this is a no-op.
    try { await fs.promises.chmod(dir, 0o700); } catch { /* Windows / EPERM */ }
    const tmp = path.join(dir, `.${agentName}.token.tmp.${randomBytes(4).toString("hex")}`);
    try {
      await fs.promises.writeFile(tmp, token + "\n", { mode: 0o600 });
      try { await fs.promises.chmod(tmp, 0o600); } catch { /* Windows */ }
      await fs.promises.rename(tmp, target);
    } catch (err) {
      // Best-effort cleanup of tmp on failure.
      try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Delete the cached token. Idempotent — missing file returns clean.
   * Used by `relay recover` to scrub stale credentials before the operator
   * re-bootstraps.
   */
  async delete(agentName: string): Promise<void> {
    try {
      await fs.promises.unlink(this.pathFor(agentName));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw err;
    }
  }

  /**
   * v2.6.2 R1 — sync delete variant for synchronous handler call sites
   * (`src/tools/identity.ts:handleRevokeToken`). Mirrors the readSync ↔ read
   * pair. Same idempotent ENOENT-swallow semantics. Using sync here avoids
   * cascading the revoke_token handler to async (which would propagate
   * through the dispatcher and into every test that exercises revoke). Sync
   * unlink of a single file is microseconds — no perf concern.
   */
  deleteSync(agentName: string): void {
    try {
      fs.unlinkSync(this.pathFor(agentName));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw err;
    }
  }
}

/** Module-level singleton for callers that don't need to inject. */
let _default: FileTokenStore | null = null;
export function defaultTokenStore(): FileTokenStore {
  if (!_default) _default = new FileTokenStore();
  return _default;
}

/** Test seam: drop the cached singleton so the next call re-resolves. */
export function _resetDefaultTokenStoreForTests(): void {
  _default = null;
}
