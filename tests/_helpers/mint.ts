// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-D shared test helper (architect fd2f6b9f Q-D): send the instance's REGISTRATION SECRET, so the suite
 * exercises the REAL gate on every HTTP register of a new name. A test daemon creates the secret at start,
 * beside its DB: `<dir of the DB>/secrets/mint.secret`. Never the open-mint development flag in a test or harness
 * (tests/pr-d-no-open-mint-in-tests.test.ts enforces it).
 *
 * `dbPathOrDir`: the daemon's RELAY_DB_PATH (a .db file) or the directory holding it; default
 * process.env.RELAY_DB_PATH (an in-process daemon). THROWS when the secret is absent: a test that expected
 * a gated daemon and found none must fail loudly, never send nothing.
 */
import fs from "fs";
import path from "path";

export function mintSecretFor(dbPathOrDir: string | undefined = process.env.RELAY_DB_PATH): string {
  if (!dbPathOrDir) throw new Error("mintSecretFor: no DB path (pass the daemon's RELAY_DB_PATH or set it)");
  const dir = dbPathOrDir.endsWith(".db") ? path.dirname(dbPathOrDir) : dbPathOrDir;
  const file = path.join(dir, "secrets", "mint.secret");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8").trim();
  } catch (err) {
    throw new Error(`mintSecretFor: no registration secret at ${file} (did the daemon start?): ${(err as Error).message}`);
  }
  if (text.length < 32) throw new Error(`mintSecretFor: ${file} holds no usable secret`);
  return text;
}

/** `{ "X-Relay-Secret": <secret> }` for a fetch/http headers object. */
export function mintHeaders(dbPathOrDir?: string): Record<string, string> {
  return { "X-Relay-Secret": mintSecretFor(dbPathOrDir) };
}
