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
    // ABSOLUTE path, deliberately. #145's primitives are IMPORTED into db.ts,
    // so the guard resolves them ONE HOP through ./auth.js and
    // ./secret-registry.js — which needs a real path. Passing "db.ts" here made
    // resolution fail, the trigger never fire, and this assertion pass
    // VACUOUSLY on an empty result. A green that proves nothing is worse than a red.
    expect(findSecretRegisterViolations(src, DB_TS)).toEqual([]);
  });

  it("HARM: a mutator that mints a token and OMITS the register is flagged (else the guard is decoration)", () => {
    // The primitives are declared IN the fixture: the guard resolves a real
    // call, so a fixture with free-floating names would never trigger.
    const omit = `
      export function generateToken(): string { return "x"; }
      export function registerPersistedSecret(n: string, ...v: unknown[]): void {}
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
      export function generateToken(): string { return "x"; }
      export function registerPersistedSecret(n: string, ...v: unknown[]): void {}
      export const mintArrow = (name: string) => {
        const t = generateToken();
        return t;
      };
    `;
    const v = findSecretRegisterViolations(arrow, "arrow.ts").map((x: { name: string }) => x.name);
    expect(v).toContain("mintArrow");
  });

  it("INNOCENT TWIN: a mutator that mints AND registers is clean", () => {
    // The primitives are declared IN the fixture on purpose. Without them the
    // trigger cannot resolve, no register is ever demanded, and this assertion
    // passes on an EMPTY result — green while proving nothing about whether the
    // register is recognised. That is the same false-coverage trap as a harm
    // fixture that passes on the broken code.
    const good = `
      export function generateToken(): string { return "x"; }
      export function registerPersistedSecret(n: string, ...v: unknown[]): void {}
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

  it("NEGATIVE CONTROL on that twin: remove the register and the SAME fixture flags", () => {
    // Proves the twin above is green because the register is RECOGNISED, not
    // because the trigger silently failed to fire.
    const bad = `
      export function generateToken(): string { return "x"; }
      export function registerPersistedSecret(n: string, ...v: unknown[]): void {}
      export function mintSomethingNew(name: string) {
        const t = generateToken();
        const h = hashToken(t);
        db.prepare("INSERT INTO agents (token_hash) VALUES (?)").run(h);
        return t;
      }
    `;
    expect(findSecretRegisterViolations(bad, "bad.ts").map((x: { name: string }) => x.name)).toContain("mintSomethingNew");
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
