// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay remote set-mint-secret <host:port>` (#433 Codex R1 P1-2, as ruled): store a REMOTE relay's registration
 * secret for this machine's hooks, at <instance dir>/agents/remote-<host>-<port>/mint.secret (the remote's own vault
 * scope, the same name the hooks compute). A remote registration presents ONLY this file, never the local instance's
 * secret; without it the hooks name this command.
 * - The secret is read from STDIN only (a secret on argv is refused: argv is readable by every local user).
 * - The file is written through ONE descriptor: created exclusively (O_EXCL|O_NOFOLLOW, 0600) as a temp beside it,
 *   made private (POSIX fchmod; Windows an owner-only ACL, verified), checked to be the file its name names, then
 *   written, fsync'd and renamed into place. A planted symlink or a foreign directory is refused. It is never printed.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { restrictToOwnerWindows, privacyFaults } from "../fs-perms.js";
import { sameFileIdentity } from "../file-identity.js";

const USAGE = "Usage: relay remote set-mint-secret <host:port>   (the secret on STDIN)\n";
/** The hooks' scope name for a remote (hooks/_vault-helpers.sh relay_scope_vault_to_remote): keep them identical. */
export const remoteScope = (host: string, port: string): string => `remote-${host.replace(/[^A-Za-z0-9_.-]/g, "_")}-${port.replace(/[^0-9]/g, "")}`;

function fail(why: string, code = 1): number {
  process.stderr.write(`relay remote: ${why}\n`);
  return code;
}
async function readStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error("the input is too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
/** A private directory this user owns, no symlink, no group/other write (POSIX): created 0700 when absent. */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real directory`);
  if (process.platform !== "win32") {
    if (typeof process.geteuid === "function" && st.uid !== process.geteuid()) throw new Error(`${dir} is not owned by you`);
    fs.chmodSync(dir, 0o700);
  }
}
/** The trusted-writer pattern (as the owner record's): one descriptor from O_EXCL create to fsync, then rename. */
function writePrivateFile(file: string, data: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  let ok = false;
  try {
    if (process.platform === "win32") {
      const faults = [...restrictToOwnerWindows(tmp, false), ...privacyFaults(tmp, 0o600)];
      if (faults.length > 0) throw new Error(`the file could not be made private (${faults.join("; ")})`);
    } else {
      fs.fchmodSync(fd, 0o600);
    }
    const st = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(tmp, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || !sameFileIdentity(st, named)) throw new Error("the new file is not the one its name names");
    if (process.platform !== "win32" && (st.mode & 0o077n) !== 0n) throw new Error("the new file is not private");
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) fs.rmSync(tmp, { force: true });
  }
  // The target must not be a symlink (or anything but a regular file): rename never follows one, but refuse loudly.
  try {
    const cur = fs.lstatSync(file);
    if (cur.isSymbolicLink() || !cur.isFile()) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`${file} exists and is not a regular file (a symlink?): refusing to replace it`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.renameSync(tmp, file);
}

export async function run(argv: string[]): Promise<number> {
  const [sub, target, ...rest] = argv;
  if (sub !== "set-mint-secret") return fail(`unknown subcommand ${JSON.stringify(sub ?? "")}\n${USAGE}`, 2);
  if (rest.length > 0) return fail(`the secret is read from STDIN, never argv (got ${rest.length} extra argument(s))\n${USAGE}`, 2);
  const m = /^([A-Za-z0-9_.:-]{1,253}):([0-9]{1,5})$/.exec(target ?? "");
  if (!m) return fail(`a <host:port> is required\n${USAGE}`, 2);
  const [, host, port] = m as unknown as [string, string, string];
  let secret: string;
  try {
    secret = (await readStdin(4096)).replace(/[\r\n]+$/, "");
  } catch (err) {
    return fail((err as Error).message);
  }
  // The shape the hooks accept (relay_mint_secret_curl_config): one line, >= 32 printable ASCII, no quote or backslash.
  if (secret.length < 32 || !/^[!-~]+$/.test(secret) || /["\\]/.test(secret)) return fail("the secret must be one line of at least 32 printable characters (no quote or backslash)");
  const { resolveInstance } = await import("../instance.js");
  const r = resolveInstance({});
  if (r.kind === "error") return fail(`no relay instance to store it in (${r.reason})`);
  const dir = path.join(path.dirname(r.dbPath), "agents", remoteScope(host, port));
  try {
    ensurePrivateDir(dir);
    writePrivateFile(path.join(dir, "mint.secret"), `${secret}\n`);
  } catch (err) {
    return fail((err as Error).message);
  }
  process.stdout.write(`relay remote: the mint secret for ${host}:${port} is stored (${path.join(dir, "mint.secret")})\n`);
  return 0;
}
