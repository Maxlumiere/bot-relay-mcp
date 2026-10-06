// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE REGISTRATION SECRET (PR-D; architect rulings 3414e98a and f885e674).
 *
 * Registering a NEW agent name over HTTP requires this instance's registration secret.
 * Without it, any process that can reach the loopback port could mint an identity: an
 * injection channel into the fleet and a name-squatting vector. An identity that already
 * exists is authenticated by its own token, and is unaffected.
 *
 *   - ONE file per instance: `<instance dir>/secrets/mint.secret`, the directory 0700 and the
 *     file 0600. It is the single source: never copied into config.json, never printed by a
 *     doctor or config verb, never put in argv or an exported env by a client.
 *   - The daemon MINTS it at start when absent (zero-concept), and says so once; `relay init`
 *     mints it too, idempotently. An existing file is never overwritten: a malformed one is a
 *     loud fault, not a silent replacement (operator data).
 *   - Clients read it AT USE TIME, never cached, so a rotation needs no restart.
 *   - Every open is no-follow: a symlink planted at the path is refused, never followed.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

export const MINT_SECRET_DIR = "secrets";
export const MINT_SECRET_FILE = "mint.secret";
/** The same floor as http_secret (config.ts): 32 characters. Minted secrets are 43 (32 random bytes, base64url). */
export const MIN_MINT_SECRET_LENGTH = 32;
/**
 * Allowed characters: printable ASCII except `"` and `\` (and no space or control character), so the value is
 * a valid HTTP header value AND sits safely inside the quoted value of a curl config line (the hooks pass it to
 * `curl -K -`). Wide enough that a legacy http_secret can SEED it (ruling Q8: MEASURED, an http_secret ending
 * in "!!!" failed the old, narrower shape and left the daemon refusing every new name).
 */
const SECRET_SHAPE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export class MintSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintSecretError";
  }
}

export function mintSecretDir(instanceDir: string): string {
  return path.join(instanceDir, MINT_SECRET_DIR);
}
export function mintSecretPath(instanceDir: string): string {
  return path.join(mintSecretDir(instanceDir), MINT_SECRET_FILE);
}

/** Why a secret's TEXT is unusable, or null. Never echoes the text. */
export function mintSecretFault(text: string): string | null {
  if (text.length < MIN_MINT_SECRET_LENGTH) return `shorter than ${MIN_MINT_SECRET_LENGTH} characters`;
  if (!SECRET_SHAPE.test(text)) return "contains a space, a control character, a quote or a backslash";
  return null;
}

/** lstat that answers null for "absent", and throws anything else. */
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The secrets directory: created 0700 when absent; refused when it is a symlink or not a directory.
 * Two starters racing both see it absent: the loser's mkdir answers EEXIST, which is success here
 * once the winner's entry is checked like any existing one.
 */
function ensureSecretsDir(instanceDir: string): string {
  const dir = mintSecretDir(instanceDir);
  // The instance dir itself may not exist yet (an embedder starting HTTP before the DB is opened): create it
  // 0700, as the DB's own init would, instead of failing the secret for the daemon's whole life.
  if (!lstatOrNull(instanceDir)) fs.mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  if (!lstatOrNull(dir)) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new MintSecretError(`${dir} is not a directory (a symlink or another type): refusing to keep the registration secret there`);
  }
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Read the secret AT USE TIME. null when the file is absent. Throws MintSecretError when it
 * is not a regular file (a symlink included: the open is no-follow) or its text is unusable.
 */
export function readMintSecret(instanceDir: string): string | null {
  const file = mintSecretPath(instanceDir);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new MintSecretError(`${file} is a symlink: refusing to read the registration secret through it`);
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new MintSecretError(`${file} is not a regular file`);
    const text = fs.readFileSync(fd, "utf-8").trim();
    const fault = mintSecretFault(text);
    if (fault) throw new MintSecretError(`${file} is unusable: ${fault}`);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Tighten an existing secret file to 0600 through a no-follow descriptor (never loosens, never follows a link). */
function tightenMintSecretMode(file: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Make sure the instance has a registration secret. Creates it only when ABSENT; an existing file is
 * validated, never replaced. The secret is PUBLISHED ATOMICALLY: written in full to a private temporary
 * file (O_EXCL, no-follow, 0600, fsync), then hard-linked to its final name, which fails if the name
 * exists. So the final path never holds a partial secret, and of two starters racing exactly one links:
 * the other finds the winner's complete file and reads it. Returns whether THIS call created it (the
 * caller announces). `seed`: the value to publish instead of a fresh one (the legacy http_secret, ruling Q8).
 */
export function ensureMintSecret(instanceDir: string, seed?: string): { path: string; created: boolean } {
  ensureSecretsDir(instanceDir);
  const file = mintSecretPath(instanceDir);
  if (readMintSecret(instanceDir) !== null) {
    tightenMintSecretMode(file);
    return { path: file, created: false };
  }
  if (seed !== undefined) {
    const fault = mintSecretFault(seed);
    if (fault) throw new MintSecretError(`the legacy http_secret cannot seed the registration secret: ${fault}`);
  }
  const secret = seed ?? crypto.randomBytes(32).toString("base64url");
  const tmp = path.join(path.dirname(file), `.${MINT_SECRET_FILE}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try {
      fs.writeSync(fd, `${secret}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (readMintSecret(instanceDir) === null) throw new MintSecretError(`${file} appeared and vanished while it was being created`);
      return { path: file, created: false }; // another starter won the race: its file is complete
    }
    return { path: file, created: true };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Constant-time comparison of a presented value against the secret (length is not secret). */
export function mintSecretMatches(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(secret, "utf-8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
