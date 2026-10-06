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
/** Allowed characters: what a header value and a curl config line can carry without quoting. */
const SECRET_SHAPE = /^[A-Za-z0-9_\-.~+/=]+$/;

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
  if (!SECRET_SHAPE.test(text)) return "contains characters outside [A-Za-z0-9_-.~+/=]";
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

/** The secrets directory: created 0700 when absent; refused when it is a symlink or not a directory. */
function ensureSecretsDir(instanceDir: string): string {
  const dir = mintSecretDir(instanceDir);
  const st = lstatOrNull(dir);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    throw new MintSecretError(`${dir} is not a directory (a symlink or another type): refusing to keep the registration secret there`);
  }
  if (!st) fs.mkdirSync(dir, { mode: 0o700 });
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

/**
 * Make sure the instance has a registration secret. Creates it (O_EXCL, no-follow, 0600) only
 * when ABSENT; an existing file is validated, never replaced. Two starters racing: one creates,
 * the other finds it and reads it. Returns whether THIS call created it (the caller announces).
 */
export function ensureMintSecret(instanceDir: string): { path: string; created: boolean } {
  ensureSecretsDir(instanceDir);
  const file = mintSecretPath(instanceDir);
  if (readMintSecret(instanceDir) !== null) {
    if (process.platform !== "win32") fs.chmodSync(file, 0o600); // tighten a widened mode; never loosen
    return { path: file, created: false };
  }
  const secret = crypto.randomBytes(32).toString("base64url");
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (readMintSecret(instanceDir) === null) throw new MintSecretError(`${file} appeared and vanished while it was being created`);
      return { path: file, created: false }; // another starter won the race
    }
    throw err;
  }
  try {
    fs.writeSync(fd, `${secret}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return { path: file, created: true };
}

/** Constant-time comparison of a presented value against the secret (length is not secret). */
export function mintSecretMatches(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(secret, "utf-8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
