// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.0 (gate 9) — the LOAD-BEARING token-safety guarantees.
 *
 * Part A (token-blind, codex constraint 1): `relay init` must NOT mint,
 * register, rotate, recover, or write/delete a token — it must import NO
 * token/db module and reference NO token function. Proven statically on BOTH
 * the source and the compiled artifact (what actually ships).
 *
 * Part B (token-safety regression, codex constraint 2): seed an existing agent
 * with a MATCHING vault (bcrypt(vault) == token_hash), run `relay init` twice
 * (+ a simulated bounce = the DB/vault are untouched by a restart), and assert
 * BOTH the token_hash AND the plaintext vault are byte-stable AND still
 * authenticate — not merely "still authenticates" (rotation grace could mask a
 * bug). The negative control shows the assertion actually CATCHES a rotate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

// ---------------------------------------------------------------------------
// Part A — token-blind static guard (source + compiled).
// ---------------------------------------------------------------------------
describe("v2.16.0 — `relay init` is TOKEN-BLIND (constraint 1)", () => {
  const SRC = path.join(REPO_ROOT, "src", "cli", "init.ts");
  const OUT = path.join(REPO_ROOT, "dist", "cli", "init.js");

  // Any of these appearing in init means it touches tokens — forbidden.
  const FORBIDDEN = [
    /mintAgentToken/,
    /\bregisterAgent\b/,
    /rotate_?[Tt]oken/,
    /recoverAgent|teardownAgent/,
    /FileTokenStore|defaultTokenStore/,
    /token_hash/,
    /mint-token/,
    // no import of the db or token-store modules
    /from\s+["']\.\.\/db(\.js)?["']/,
    /from\s+["']\.\.\/token-store(\.js)?["']/,
  ];

  it("(source) src/cli/init.ts imports no token/db module and calls no token function", () => {
    const body = fs.readFileSync(SRC, "utf-8");
    for (const re of FORBIDDEN) {
      expect(re.test(body), `init.ts must not match ${re} (token-blind by construction)`).toBe(false);
    }
  });

  it("(compiled) dist/cli/init.js (what ships) is likewise token-blind", () => {
    expect(fs.existsSync(OUT), `missing ${OUT} — run npm run build first`).toBe(true);
    const body = fs.readFileSync(OUT, "utf-8");
    for (const re of FORBIDDEN) {
      expect(re.test(body), `compiled init must not match ${re}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Part B — token-safety regression (runtime).
// ---------------------------------------------------------------------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v2160-tokensafe-"));
const DB_PATH = path.join(ROOT, "relay.db");
process.env.RELAY_HOME = ROOT;
process.env.RELAY_DB_PATH = DB_PATH;
process.env.RELAY_CONFIG_PATH = path.join(ROOT, "config.json");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { defaultTokenStore } = await import("../src/token-store.js");

const AGENT = "safety-agent";

function tokenHashOf(name: string): string {
  return (db.getDb().prepare("SELECT token_hash FROM agents WHERE name = ?").get(name) as { token_hash: string })
    .token_hash;
}
function vaultPath(): string {
  return path.join(ROOT, "agents", `${AGENT}.token`);
}
function runInit(): number {
  const r = spawnSync("node", [RELAY_BIN, "init", "--yes"], {
    encoding: "utf-8",
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: ROOT,
      RELAY_HOME: ROOT,
      RELAY_DB_PATH: DB_PATH,
      RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
      RELAY_CLAUDE_HOME: ROOT,
      RELAY_SKIP_DAEMON: "1",
    },
  });
  return r.status ?? -1;
}

afterAll(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("v2.16.0 — init/deploy/bounce PRESERVE an existing token (constraint 2)", () => {
  let plaintext: string;
  let hashBefore: string;
  let vaultBefore: string;

  beforeAll(async () => {
    // Seed a working install: mint a token (DB gets token_hash) + write the
    // matching plaintext to the vault. This is a live agent's credential.
    const minted = db.mintAgentToken(AGENT, "builder", []);
    plaintext = minted.plaintext_token;
    await defaultTokenStore().write(AGENT, plaintext);
    hashBefore = tokenHashOf(AGENT);
    vaultBefore = fs.readFileSync(vaultPath(), "utf-8");
    // sanity: the seed is internally consistent (vault authenticates).
    expect(bcrypt.compareSync(plaintext, hashBefore)).toBe(true);
  });

  it("running `relay init` TWICE leaves token_hash AND the plaintext vault byte-stable + authenticating", () => {
    expect(runInit()).toBe(0);
    expect(runInit()).toBe(0); // idempotent second run (a re-deploy)

    const hashAfter = tokenHashOf(AGENT);
    const vaultAfter = fs.readFileSync(vaultPath(), "utf-8");

    // BOTH halves stable — not just "still authenticates".
    expect(hashAfter, "DB token_hash must be untouched by init").toBe(hashBefore);
    expect(vaultAfter, "plaintext vault must be untouched by init").toBe(vaultBefore);
    // And they still form a valid credential.
    expect(bcrypt.compareSync(plaintext, hashAfter), "vault token must still authenticate against the DB hash").toBe(
      true,
    );
  });

  it("NEGATIVE CONTROL — a force-rotate DOES desync, proving the assertion catches a rotate", () => {
    // If init (or anything on the deploy path) had rotated the token_hash, the
    // ORIGINAL vault plaintext would no longer authenticate. Demonstrate that
    // the check above is load-bearing by actually rotating.
    db.mintAgentToken(AGENT, "builder", [], { force: true });
    const rotatedHash = tokenHashOf(AGENT);
    expect(rotatedHash).not.toBe(hashBefore);
    expect(
      bcrypt.compareSync(plaintext, rotatedHash),
      "after a rotate the old vault must FAIL to authenticate — this is what init must never cause",
    ).toBe(false);
  });
});
