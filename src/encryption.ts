// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v1.7 / v2.1 Phase 4b.3: keyring-aware AES-256-GCM encryption for
 * sensitive content fields at rest.
 *
 * Scope: messages.content, tasks.description, tasks.result,
 * audit_log.params_json, webhook_subscriptions.secret (Phase 4p).
 * NOT scope: agent names, tool names, timestamps, priorities, statuses.
 *
 * Storage formats (both recognized forever):
 *   - "enc:<key_id>:<iv_b64>:<payload_b64>"  — v2 versioned (Phase 4b.3).
 *                                              Always written on encrypt.
 *   - "enc1:<iv_b64>:<payload_b64>"           — legacy v1 (Phase 4p).
 *                                              Read-only; never written.
 *   - unprefixed                              — plaintext (no-key mode).
 *
 * Key management: the relay now loads a KEYRING rather than a single key.
 * Keyring sources (pick EXACTLY ONE — multi-set rejected at startup):
 *   1. RELAY_ENCRYPTION_KEYRING          JSON blob in env var.
 *   2. RELAY_ENCRYPTION_KEYRING_PATH     filesystem path to JSON file.
 *   3. RELAY_ENCRYPTION_KEY              legacy single-key (deprecated).
 *                                        Auto-wraps to keyring shape.
 *
 * Legacy-format rows (enc1:...) decrypt via
 * RELAY_ENCRYPTION_LEGACY_KEY_ID (default "k1"). Operators upgrading
 * from Phase 4p deployments get transparent continuity.
 *
 * Ciphertext format is FROZEN — both prefixes are stable-forever. A new
 * cipher (e.g. post-quantum) would introduce a new top-level prefix
 * rather than bumping the version inside the existing namespace.
 */

import crypto from "crypto";
import fs from "fs";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;            // 96 bits, GCM recommended
const TAG_LEN = 16;           // 128 bits
const V2_PREFIX = "enc:";     // v2 versioned (Phase 4b.3)
const V1_PREFIX = "enc1:";    // legacy v1 (Phase 4p), read-only
const KEY_ID_RE = /^[a-zA-Z0-9_.-]+$/;
const DEFAULT_LEGACY_KEY_ID = "k1";

export interface Keyring {
  current: string;
  keys: Record<string, Buffer>;
  /**
   * Which `enc1:` ciphertext rows are assumed to belong to. Defaults to
   * `RELAY_ENCRYPTION_LEGACY_KEY_ID` or "k1" if unset.
   */
  legacyKeyId: string;
}

interface CacheState {
  keyring: Keyring | null;
  sourceSignature: string | null;
}

const state: CacheState = { keyring: null, sourceSignature: null };

/** Compute a signature of the config sources so we know when to reload. */
function sourceSignature(): string {
  return [
    process.env.RELAY_ENCRYPTION_KEYRING ?? "",
    process.env.RELAY_ENCRYPTION_KEYRING_PATH ?? "",
    process.env.RELAY_ENCRYPTION_KEY ?? "",
    process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID ?? "",
  ].join("\x00");
}

function parseKeysMap(source: string, raw: Record<string, string>): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const [keyId, b64] of Object.entries(raw)) {
    if (!KEY_ID_RE.test(keyId)) {
      throw new Error(
        `Invalid key_id "${keyId}" in ${source}: must match ${KEY_ID_RE.source}`
      );
    }
    if (typeof b64 !== "string") {
      throw new Error(`Invalid key value for "${keyId}" in ${source}: expected string`);
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      throw new Error(`Malformed base64 for key_id "${keyId}" in ${source}`);
    }
    if (buf.length !== 32) {
      throw new Error(
        `Key "${keyId}" in ${source} decodes to ${buf.length} bytes; expected 32. ` +
          `Generate with: openssl rand -base64 32`
      );
    }
    out[keyId] = buf;
  }
  return out;
}

function validateKeyring(kr: { current?: string; keys?: Record<string, unknown> }, source: string): Keyring {
  if (!kr || typeof kr !== "object") {
    throw new Error(`Keyring from ${source} must be a JSON object with { current, keys }`);
  }
  if (typeof kr.current !== "string" || !kr.current) {
    throw new Error(`Keyring from ${source} missing "current" field`);
  }
  if (!KEY_ID_RE.test(kr.current)) {
    throw new Error(
      `Keyring from ${source}: "current" key_id "${kr.current}" must match ${KEY_ID_RE.source}`
    );
  }
  if (!kr.keys || typeof kr.keys !== "object") {
    throw new Error(`Keyring from ${source} missing "keys" object`);
  }
  const keys = parseKeysMap(source, kr.keys as Record<string, string>);
  if (!keys[kr.current]) {
    throw new Error(
      `Keyring from ${source}: "current" = "${kr.current}" does not appear in keys map`
    );
  }
  return {
    current: kr.current,
    keys,
    legacyKeyId: process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID || DEFAULT_LEGACY_KEY_ID,
  };
}

function loadKeyring(): Keyring | null {
  const sig = sourceSignature();
  if (state.keyring && state.sourceSignature === sig) return state.keyring;

  const envJson = process.env.RELAY_ENCRYPTION_KEYRING;
  const envPath = process.env.RELAY_ENCRYPTION_KEYRING_PATH;
  const envLegacy = process.env.RELAY_ENCRYPTION_KEY;

  const sourcesSet = [envJson, envPath, envLegacy].filter((x) => x && x.length > 0);
  if (sourcesSet.length > 1) {
    const names: string[] = [];
    if (envJson) names.push("RELAY_ENCRYPTION_KEYRING");
    if (envPath) names.push("RELAY_ENCRYPTION_KEYRING_PATH");
    if (envLegacy) names.push("RELAY_ENCRYPTION_KEY");
    throw new Error(
      `[config] Multiple encryption key sources detected: ${names.join(", ")}. ` +
        `Set exactly one. See docs/key-rotation.md.`
    );
  }

  if (envJson) {
    let parsed: any;
    try {
      parsed = JSON.parse(envJson);
    } catch (err) {
      throw new Error(
        `RELAY_ENCRYPTION_KEYRING: malformed JSON — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const kr = validateKeyring(parsed, "RELAY_ENCRYPTION_KEYRING");
    state.keyring = kr;
    state.sourceSignature = sig;
    return kr;
  }

  if (envPath) {
    let raw: string;
    try {
      raw = fs.readFileSync(envPath, "utf-8");
    } catch (err) {
      throw new Error(
        `RELAY_ENCRYPTION_KEYRING_PATH="${envPath}": cannot read — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `RELAY_ENCRYPTION_KEYRING_PATH="${envPath}": malformed JSON — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    const kr = validateKeyring(parsed, `RELAY_ENCRYPTION_KEYRING_PATH (${envPath})`);
    // Soft-warn on wider-than-0600 perms, matching Phase 4c.4 discipline.
    try {
      const mode = fs.statSync(envPath).mode & 0o777;
      if (mode !== 0o600 && process.platform !== "win32") {
        process.stderr.write(
          `[encryption] Keyring file ${envPath} has mode 0${mode.toString(8)}. ` +
            `Recommended 0600. Run: chmod 600 "${envPath}"\n`
        );
      }
    } catch {
      /* ignore stat errors — not a blocker */
    }
    state.keyring = kr;
    state.sourceSignature = sig;
    return kr;
  }

  if (envLegacy) {
    // Legacy single-key: auto-wrap as { current: "<legacy_id>", keys: { <legacy_id>: <value> } }.
    // The legacy key_id comes from RELAY_ENCRYPTION_LEGACY_KEY_ID (default "k1"),
    // ensuring consistency between the in-memory keyring and the on-disk
    // `enc1:` rows (which are decrypted via the same legacy_key_id).
    const legacyId = process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID || DEFAULT_LEGACY_KEY_ID;
    let buf: Buffer;
    try {
      buf = Buffer.from(envLegacy, "base64");
    } catch {
      throw new Error(`RELAY_ENCRYPTION_KEY: malformed base64`);
    }
    if (buf.length !== 32) {
      throw new Error(
        `RELAY_ENCRYPTION_KEY must be 32 bytes base64-encoded. Got ${buf.length} bytes. ` +
          `Generate with: openssl rand -base64 32`
      );
    }
    const kr: Keyring = {
      current: legacyId,
      keys: { [legacyId]: buf },
      legacyKeyId: legacyId,
    };
    state.keyring = kr;
    state.sourceSignature = sig;
    return kr;
  }

  state.keyring = null;
  state.sourceSignature = sig;
  return null;
}

/** True if the keyring is loaded + has at least one key (encryption active). */
export function isEncryptionActive(): boolean {
  try {
    return loadKeyring() !== null;
  } catch {
    return false;
  }
}

/**
 * v2.1 Phase 7p MED #2: eager startup validation for the keyring config.
 *
 * Pre-7p, keyring validation was purely lazy — `loadKeyring()` ran on first
 * encrypt/decrypt, and `getKeyringInfo()` swallowed errors as "encryption
 * inactive". Ambiguous configs (e.g. both `RELAY_ENCRYPTION_KEYRING` and
 * `RELAY_ENCRYPTION_KEY` set) let the daemon boot and only surfaced on the
 * first encrypted-column code path. The documented contract is "reject at
 * startup"; this makes the contract actually load-bearing.
 *
 * Called from `validateConfigAndEnv()` in src/config.ts. Throws on any
 * config error — multi-source, malformed JSON, bad key size, unreadable
 * path, etc. Returns silently when the config is valid (or when no
 * encryption is configured at all — that's a legitimate "plaintext mode"
 * choice, not an error).
 */
export function validateKeyringStrict(): void {
  // Force a load. loadKeyring() throws on any config problem. We don't care
  // about the return value — just that the validation ran.
  loadKeyring();
}

/** Return keyring info suitable for dashboards — NEVER exposes raw keys. */
export function getKeyringInfo(): { current: string | null; known_key_ids: string[]; legacy_key_id: string } {
  try {
    const kr = loadKeyring();
    if (!kr) return { current: null, known_key_ids: [], legacy_key_id: DEFAULT_LEGACY_KEY_ID };
    return {
      current: kr.current,
      known_key_ids: Object.keys(kr.keys).sort(),
      legacy_key_id: kr.legacyKeyId,
    };
  } catch {
    return { current: null, known_key_ids: [], legacy_key_id: DEFAULT_LEGACY_KEY_ID };
  }
}

/**
 * Whether `RELAY_ENCRYPTION_KEY` is being used — flag so callers can emit
 * the one-time deprecation warning at startup.
 */
export function isLegacyEnvKeyInUse(): boolean {
  return (
    !process.env.RELAY_ENCRYPTION_KEYRING &&
    !process.env.RELAY_ENCRYPTION_KEYRING_PATH &&
    !!process.env.RELAY_ENCRYPTION_KEY
  );
}

/** Whether the runtime has opted into RELAY_LAZY_REENCRYPT (reserved signal). */
export function isLazyReencryptEnabled(): boolean {
  return process.env.RELAY_LAZY_REENCRYPT === "1";
}

/**
 * Encrypt a plaintext string for at-rest storage. Emits the v2 versioned
 * prefix `enc:<key_id>:<iv>:<payload>` using the keyring's current key.
 * Returns plaintext unchanged when no keyring is configured.
 */
export function encryptContent(plaintext: string): string {
  const kr = loadKeyring();
  if (!kr) return plaintext;
  const key = kr.keys[kr.current];
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([enc, tag]);
  return `${V2_PREFIX}${kr.current}:${iv.toString("base64")}:${payload.toString("base64")}`;
}

/**
 * Decrypt an at-rest string. Handles v2 versioned (enc:key_id:...),
 * legacy v1 (enc1:...), and plaintext pass-through uniformly. READ paths
 * stay pure — no side effects, no writes. See devlog 052 "READ paths stay
 * pure" discipline note.
 */
export function decryptContent(stored: string | null): string | null {
  if (stored === null) return null;
  if (stored.startsWith(V2_PREFIX)) {
    // v2 versioned: enc:<key_id>:<iv_b64>:<payload_b64>
    const body = stored.slice(V2_PREFIX.length);
    const firstSep = body.indexOf(":");
    if (firstSep < 0) throw new Error("Malformed v2 ciphertext: missing key_id separator");
    const keyId = body.slice(0, firstSep);
    const rest = body.slice(firstSep + 1);
    const secondSep = rest.indexOf(":");
    if (secondSep < 0) throw new Error("Malformed v2 ciphertext: missing iv separator");
    const ivB64 = rest.slice(0, secondSep);
    const payloadB64 = rest.slice(secondSep + 1);
    return decryptWithKeyId(keyId, ivB64, payloadB64);
  }
  if (stored.startsWith(V1_PREFIX)) {
    // Legacy v1: enc1:<iv_b64>:<payload_b64> — implicit key_id from legacyKeyId.
    const kr = loadKeyring();
    const legacyId = kr ? kr.legacyKeyId : DEFAULT_LEGACY_KEY_ID;
    const body = stored.slice(V1_PREFIX.length);
    const sep = body.indexOf(":");
    if (sep < 0) throw new Error("Malformed v1 ciphertext: missing iv separator");
    return decryptWithKeyId(legacyId, body.slice(0, sep), body.slice(sep + 1));
  }
  // Plaintext pass-through — pre-encryption row.
  return stored;
}

function decryptWithKeyId(keyId: string, ivB64: string, payloadB64: string): string {
  const kr = loadKeyring();
  if (!kr) {
    throw new Error(
      `Row is encrypted (key_id="${keyId}") but no keyring is configured. ` +
        `Set RELAY_ENCRYPTION_KEYRING or RELAY_ENCRYPTION_KEYRING_PATH.`
    );
  }
  const key = kr.keys[keyId];
  if (!key) {
    throw new Error(
      `Row is encrypted with key_id="${keyId}" but that key is not in the keyring. ` +
        `Add it back to decrypt, or run \`relay re-encrypt\` from an environment that has it.`
    );
  }
  const iv = Buffer.from(ivB64, "base64");
  const payload = Buffer.from(payloadB64, "base64");
  if (iv.length !== IV_LEN || payload.length < TAG_LEN + 1) {
    throw new Error(`Malformed ciphertext: bad iv or payload length (key_id="${keyId}")`);
  }
  const ct = payload.subarray(0, payload.length - TAG_LEN);
  const tag = payload.subarray(payload.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * Re-encrypt an existing ciphertext row with a target key_id. Used by
 * `relay re-encrypt` for the migration pipeline. Parses the input, decrypts
 * via its native key_id (handles both v2 and legacy v1 inputs), re-encrypts
 * with the target.
 *
 * The target key MUST be in the current keyring. Caller is responsible for
 * ensuring the source key is also resolvable (error will surface otherwise).
 */
export function reencryptRow(stored: string, toKeyId: string): string {
  const kr = loadKeyring();
  if (!kr) {
    throw new Error(`reencryptRow requires a keyring. None is configured.`);
  }
  if (!kr.keys[toKeyId]) {
    throw new Error(
      `reencryptRow target key_id="${toKeyId}" is not in the keyring.`
    );
  }
  const plaintext = decryptContent(stored);
  if (plaintext === null) return stored;
  // Encrypt against the target key_id. Temporarily swap keyring.current to
  // avoid duplicating the cipher logic.
  const originalCurrent = kr.current;
  kr.current = toKeyId;
  try {
    return encryptContent(plaintext);
  } finally {
    kr.current = originalCurrent;
  }
}

/**
 * Reset cached state — used exclusively by tests that mutate the env
 * between cases. Not exported in the public API contract.
 */
export function _resetKeyringCacheForTests(): void {
  state.keyring = null;
  state.sourceSignature = null;
}
