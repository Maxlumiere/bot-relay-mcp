// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.7 — the redact-by-value register drift guard's OWN harm test.
 *
 * A guard that looks right can enforce almost nothing (the #143 lesson: a grep
 * that read one token, a path check sidesteppable by a directory). ADR-0015
 * applies to this guard exactly as to the code it protects: it is only real if it
 * FAILS on a genuine omission. So this suite proves the guard flags a mutator
 * that mints a token and omits registerPersistedSecret — including the arrow
 * shape that evaded the auth-gen guard's first version — and passes the innocent
 * twin. It also runs the guard against the REAL src/db.ts (the live enforcement).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { findSecretRegisterViolations } = await import("../scripts/secret-register-guard.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_TS = path.resolve(HERE, "..", "src", "db.ts");

describe("v2.24.7 redact-by-value register drift guard", () => {
  it("the real src/db.ts: every token-minting function registers the persisted secret", () => {
    const src = fs.readFileSync(DB_TS, "utf-8");
    expect(findSecretRegisterViolations(src, "db.ts")).toEqual([]);
  });

  it("HARM: a mutator that mints a token and OMITS the register is flagged (else the guard is decoration)", () => {
    const omit = `
      export function mintSomethingNew(name: string) {
        const t = generateToken();
        const h = hashToken(t);
        db.prepare("INSERT INTO agents (token_hash) VALUES (?)").run(h);
        return t;
      }
    `;
    const v = findSecretRegisterViolations(omit, "omit.ts").map((x: { name: string }) => x.name);
    expect(v).toContain("mintSomethingNew");
  });

  it("HARM via the arrow-function shape (the evasion class codex found on the auth-gen guard)", () => {
    const arrow = `
      export const mintArrow = (name: string) => {
        const t = generateToken();
        return t;
      };
    `;
    const v = findSecretRegisterViolations(arrow, "arrow.ts").map((x: { name: string }) => x.name);
    expect(v).toContain("mintArrow");
  });

  it("INNOCENT TWIN: a mutator that mints AND registers is clean", () => {
    const good = `
      export function mintSomethingNew(name: string) {
        const t = generateToken();
        const h = hashToken(t);
        db.prepare("INSERT INTO agents (token_hash) VALUES (?)").run(h);
        registerPersistedSecret(name, t);
        return t;
      }
    `;
    expect(findSecretRegisterViolations(good, "good.ts")).toEqual([]);
  });

  it("no false positive: a function that never mints a token is not required to register", () => {
    const noMint = `
      export function justReads(name: string) {
        return db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
      }
    `;
    expect(findSecretRegisterViolations(noMint, "read.ts")).toEqual([]);
  });
});
