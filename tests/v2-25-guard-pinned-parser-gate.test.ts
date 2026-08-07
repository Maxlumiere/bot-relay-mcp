// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #47 — PINNED-PARSER GATE (companion safety for the typescript-legacy pin).
 *
 * The AST guards are pinned to a classic-compiler TypeScript (typescript-legacy)
 * so the build's own `typescript` can bump to 7 (Corsa) freely. The hazard that
 * pin introduces: `ts.createSourceFile` is ERROR-TOLERANT — on syntax it does
 * not understand it returns a PARTIAL tree with error nodes and does NOT throw
 * (measured: 4 parse diagnostics, 0 exceptions). A guard walking that partial
 * tree could silently UNDER-detect the construct it polices and report CLEAN on
 * a file it could not read — the exact hole the auth-generation guard exists to
 * prevent, re-created by an aging pin.
 *
 * These are the EXECUTED fixtures that prove the gate closes it: any parse
 * diagnostic on a scanned file must make the guard fail LOUD — throw at the
 * library boundary, and exit non-zero at the CLI. Silence-as-failure is the
 * enemy; a guard that cannot fully parse a file must SAY SO, never pass.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Syntax the pinned parser cannot parse — stands in for "source newer than the
// pin." Measured to yield parse diagnostics (not an exception) from createSourceFile.
const UNPARSEABLE = "const x = ;\nfunction f(] { return @@@ }\n";
const CLEAN = "export function f() { return 1; }\n";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

describe("#47 pinned-parser gate — a file the pinned parser cannot fully parse fails LOUD", () => {
  it("parseGuardSource THROWS on parse diagnostics (never returns a partial tree)", async () => {
    const { parseGuardSource, GuardParseError } = await import("../scripts/lib/guard-parse.mjs");
    expect(() => parseGuardSource("bad.ts", UNPARSEABLE)).toThrow(GuardParseError);
    // and it returns a usable SourceFile for a clean file
    const sf = parseGuardSource("ok.ts", CLEAN);
    expect(sf.statements.length).toBe(1);
  });

  it("each guard's find* REFUSES to certify an unparseable file (throws, never returns a verdict)", async () => {
    const { findAuthGenViolations } = await import("../scripts/auth-gen-guard.mjs");
    const { findSecretRegisterViolations } = await import("../scripts/secret-register-guard.mjs");
    const { findAgentClassViolations } = await import("../scripts/agent-class-guard.mjs");
    // The danger is a SILENT clean verdict ([]). Each must throw instead.
    expect(() => findAuthGenViolations(UNPARSEABLE, "db.ts")).toThrow();
    expect(() => findSecretRegisterViolations(UNPARSEABLE, "db.ts")).toThrow();
    expect(() => findAgentClassViolations(UNPARSEABLE, "f.ts")).toThrow();
    // Sanity: on clean input they return an array (a verdict), not a throw.
    expect(Array.isArray(findAgentClassViolations(CLEAN, "f.ts"))).toBe(true);
  });

  it.each([
    ["scripts/agent-class-guard.mjs"],
    ["scripts/cli-profile-guard.mjs"],
    ["scripts/auth-gen-guard.mjs"],
    ["scripts/secret-register-guard.mjs"],
  ])("the guard CLI %s exits RED (non-zero), never CLEAN, on an unparseable file", (guard) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-gate-"));
    const bad = path.join(dir, "bad.ts");
    fs.writeFileSync(bad, UNPARSEABLE);
    let code = 0;
    try {
      execFileSync("node", [path.join(REPO_ROOT, guard), bad], { stdio: "pipe", cwd: REPO_ROOT });
    } catch (e: any) {
      code = e.status ?? 1;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // exit 2 = parse/usage error per each guard's convention; the point is NOT 0.
    expect(code).not.toBe(0);
  });
});
