// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.11 — secret-register-guard rebuilt on the shared structural helper.
 *
 * v1 regexed the function's raw body TEXT for BOTH halves, so a
 * `// TODO: registerPersistedSecret(n,t)` comment satisfied it. Both halves now
 * resolve a real CallExpression, including ONE HOP through a direct relative
 * named import — because #145's primitives are IMPORTED into src/db.ts
 * (`./auth.js`, `./secret-registry.js`), unlike auth-gen-guard's, which are
 * declared in the file it analyses. That environmental difference was verified
 * for THIS file rather than inherited: the same-file-only bar recognised 0 of 5
 * legitimate units and would have failed every build.
 *
 * ⚠ FIXTURES ARE WRITTEN TO A REAL TEMP DIRECTORY WITH REAL SIBLING MODULES.
 * One-hop resolution reads the filesystem, so an in-memory fixture would prove
 * nothing about the thing under test. Do not "simplify" these into bare strings.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { findSecretRegisterViolations } = await import("../scripts/secret-register-guard.mjs");
const { findUnresolvablePrimitives } = await import("../scripts/lib/guard-ast.mjs");

let dir: string;
const IMP =
  `import { generateToken } from "./auth.js";\n` +
  `import { registerPersistedSecret } from "./secret-registry.js";\n`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-reg-guard-"));
  fs.writeFileSync(path.join(dir, "auth.ts"), `export function generateToken(): string { return "x"; }\n`);
  fs.writeFileSync(
    path.join(dir, "secret-registry.ts"),
    `export function registerPersistedSecret(p: string, ...v: unknown[]): void {}\n`,
  );
  // A barrel that RE-EXPORTS. One hop only — this must NOT be followed.
  fs.writeFileSync(
    path.join(dir, "barrel.ts"),
    `export { registerPersistedSecret } from "./secret-registry.js";\n`,
  );
  fs.writeFileSync(path.join(dir, "other.ts"), `export function somethingElse(): string { return "y"; }\n`);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Analyse `src` as db.ts sitting next to the real sibling modules. */
const names = (src: string): string[] => {
  const f = path.join(dir, "db.ts");
  fs.writeFileSync(f, src);
  return findSecretRegisterViolations(src, f).map((v: { name: string }) => v.name);
};

describe("v2.24.11 secret-register-guard — required-call side is structural", () => {
  it("v1 KILLER: a TODO comment for the register is not a register", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); persist(t); /* TODO: registerPersistedSecret(n,t) */ }`)).toContain("mint");
  });

  it("a STRING literal mentioning the register is not a register", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); log("call registerPersistedSecret(n,t)"); }`)).toContain("mint");
  });

  it("a register only inside a NEVER-INVOKED closure does not count", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); const cb = () => registerPersistedSecret(n,t); }`)).toContain("mint");
  });

  it("a register on an unrelated RECEIVER does not count", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); metrics.registerPersistedSecret(n,t); }`)).toContain("mint");
  });

  it("a register name SHADOWED by a local does not count", () => {
    expect(names(`${IMP}export function mint(n: string){ const registerPersistedSecret = () => {}; const t = generateToken(); registerPersistedSecret(); }`)).toContain("mint");
  });

  it("a let alias reassigned before use does not count", () => {
    expect(names(`${IMP}export function mint(n: string){ let r = registerPersistedSecret; r = () => {}; const t = generateToken(); r(n,t); }`)).toContain("mint");
  });
});

describe("v2.24.11 one-hop import resolution — identity by declaration, not by specifier", () => {
  it("RENAMED import is refused — the local spelling is precisely not the imported thing", () => {
    expect(names(
      `import { generateToken } from "./auth.js";\n` +
        `import { somethingElse as registerPersistedSecret } from "./other.js";\n` +
        `export function mint(n: string){ const t = generateToken(); registerPersistedSecret(); }`,
    )).toContain("mint");
  });

  it("a BARREL / re-export chain is refused — ONE hop only, not chased", () => {
    expect(names(
      `import { generateToken } from "./auth.js";\n` +
        `import { registerPersistedSecret } from "./barrel.js";\n` +
        `export function mint(n: string){ const t = generateToken(); registerPersistedSecret(n,t); }`,
    )).toContain("mint");
  });

  it("TWIN: a direct relative named import that really declares it IS accepted", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); registerPersistedSecret(n,t); }`)).toEqual([]);
  });
});

describe("v2.24.11 node coverage — codex's original (c) evasion, still open in this file", () => {
  it("a class-field arrow minter is visited and flagged", () => {
    expect(names(`${IMP}export class C { mint = (n: string) => { const t = generateToken(); persist(t); }; }`)).toContain("mint");
  });

  it("an accessor minter is visited and flagged", () => {
    expect(names(`${IMP}export class C { get mint(){ const t = generateToken(); return t; } }`)).toContain("mint");
  });

  it("a constructor minter is visited and flagged", () => {
    expect(names(`${IMP}export class C { constructor(){ const t = generateToken(); persist(t); } }`)).toContain("constructor");
  });

  it("ROOT G: a unit merely SPELLED like the primitive is analysed, not exempt", () => {
    expect(names(`${IMP}export class C { registerPersistedSecret = (n: string) => { const t = generateToken(); persist(t); }; }`)).toContain("registerPersistedSecret");
  });

  it("TWIN: the REAL top-level primitive is still exempt from registering its own output", () => {
    expect(names(`${IMP}export function registerPersistedSecret(n: string){ const t = generateToken(); }`)).toEqual([]);
  });
});

describe("v2.24.11 innocent twins — breaking any of these fails honest code", () => {
  it("direct mint + direct register", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); registerPersistedSecret(n,t); }`)).toEqual([]);
  });
  it("register inside if", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); if(ok){ registerPersistedSecret(n,t); } }`)).toEqual([]);
  });
  it("register inside try", () => {
    expect(names(`${IMP}export function mint(n: string){ const t = generateToken(); try { registerPersistedSecret(n,t); } catch(e){} }`)).toEqual([]);
  });
  it("honest const alias of the register", () => {
    expect(names(`${IMP}export function mint(n: string){ const r = registerPersistedSecret; const t = generateToken(); r(n,t); }`)).toEqual([]);
  });
  it("a non-minting unit is never demanded", () => {
    expect(names(`${IMP}export function touch(n: string){ persist(n); }`)).toEqual([]);
  });
});

describe("v2.24.11 TRIGGER side — hardened too, with its boundary MEASURED and pinned", () => {
  it("TWIN: a LOCAL FAKE generateToken owes nothing — it is not the primitive", () => {
    expect(names(`${IMP}export function mint(n: string){ const generateToken = () => "fake"; const t = generateToken(); persist(t); }`)).toEqual([]);
  });

  it("STATED BOUNDARY (measured, NOT closed): a namespace-import mint escapes the trigger → UNDER-detect", () => {
    // `import * as auth` + `auth.generateToken()` IS a real mint. The resolver
    // refuses receiver forms, so no register is demanded and this passes.
    // src/db.ts uses a direct named import, so this is not live today — but it is
    // under-detection and it is pinned here so it cannot be rediscovered as new.
    expect(names(
      `import * as auth from "./auth.js";\n` +
        `import { registerPersistedSecret } from "./secret-registry.js";\n` +
        `export function mint(n: string){ const t = auth.generateToken(); persist(t); }`,
    )).toEqual([]);
  });
});

describe("v2.24.11 premise enforcement", () => {
  it("PREMISE: an unresolvable primitive is reported by name", async () => {
    // PINNED PARSER (#212): typescript-legacy, matching the guard under test — not the
    // bumpable `typescript`, which would parse with a different compiler once it bumps to 7.
    const ts = (await import("typescript-legacy")).default;
    const src = `import { registerPersistedSecret } from "./nope.js";\n`;
    const sf = ts.createSourceFile(path.join(dir, "db.ts"), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(findUnresolvablePrimitives(sf, new Set(["registerPersistedSecret"]))).toEqual(["registerPersistedSecret"]);
  });

  it("PREMISE: a real one-hop import satisfies it", async () => {
    // PINNED PARSER (#212): typescript-legacy, matching the guard under test.
    const ts = (await import("typescript-legacy")).default;
    const sf = ts.createSourceFile(path.join(dir, "db.ts"), IMP, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(findUnresolvablePrimitives(sf, new Set(["generateToken", "registerPersistedSecret"]))).toEqual([]);
  });
});
