// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * File identity is EXACT (as asked at #418 verify): every fd↔path / dev+ino identity compare in src/ uses BigInt stats.
 * Node's numeric ino is a double; an NTFS 64-bit file id exceeds 2^53, so two different files can round to one number
 * (a Windows CI run passed a swap the check had to refuse). A deterministic row proves the BigInt path matters on
 * every OS, and a structural scan (the TS checker) refuses any `.ino` read from a numeric fs.Stats in src/.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("file identity is exact (BigInt dev + ino)", () => {
  it("two inos that differ only above 2^53 are DIFFERENT files (the numeric path would collide: the control)", async () => {
    const { sameFileIdentity, fileIdentityKey } = (await import("../src/file-identity.js")) as {
      sameFileIdentity: (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => boolean;
      fileIdentityKey: (s: { dev: bigint; ino: bigint }) => string;
    };
    const a = { dev: 1n, ino: 2n ** 53n };
    const b = { dev: 1n, ino: 2n ** 53n + 1n };
    expect(Number(a.ino) === Number(b.ino), "control: as Numbers they collide").toBe(true);
    expect(sameFileIdentity(a, b), "as BigInts they are different files").toBe(false);
    expect(fileIdentityKey(a)).not.toBe(fileIdentityKey(b));
    expect(sameFileIdentity(a, { dev: 1n, ino: 2n ** 53n }), "the same file is the same").toBe(true);
    expect(sameFileIdentity(a, { dev: 2n, ino: 2n ** 53n }), "another device is another file").toBe(false);
  });

  it("STRUCTURAL: no `.ino` (or `.dev` compared with one) is read from a numeric fs.Stats in src/ (the TS checker)", async () => {
    const { srcProgram } = await import("./_helpers/ts-binding.js");
    const ts = (await import("typescript-legacy")).default;
    const program = srcProgram();
    const checker = program.getTypeChecker();
    const hits: string[] = [];
    let seen = 0;
    for (const sf of program.getSourceFiles()) {
      const rel = path.relative(REPO, sf.fileName).split(path.sep).join("/");
      if (!rel.startsWith("src/") || sf.isDeclarationFile) continue;
      const visit = (n: import("typescript-legacy").Node): void => {
        if (ts.isPropertyAccessExpression(n) && n.name.text === "ino") {
          seen++;
          const t = checker.getTypeAtLocation(n);
          if (t.flags & ts.TypeFlags.NumberLike) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            hits.push(`${rel}:${line + 1}: ${n.getText(sf)} is a number`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(seen, "precondition: the scan saw the ino reads in src/ (more than 15 today)").toBeGreaterThan(15);
    expect(hits, "every ino in src/ is a bigint (stat with { bigint: true })").toEqual([]);
  }, 120_000);
});
