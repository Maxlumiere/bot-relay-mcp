// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #182 supply-chain posture — verify what SHIPS for our native dependency.
 *
 * better-sqlite3 v13 ships a bundled prebuild and no longer compiles at install;
 * the guarantee moved from "we compiled it" to "the exact tarball is pinned by an
 * integrity hash". These tests pin the two properties that now carry it:
 *   - checkLockfileIntegrity: exact version + registry-sourced integrity hash.
 *   - checkBundledPrebuildLoads: the binary actually loads and answers a query.
 *
 * The integrity check is exercised against FIXTURES (a missing/loose pin must red)
 * as well as the real lockfile, so it cannot silently pass on an unpinned tarball.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { checkLockfileIntegrity, checkBundledPrebuildLoads } from "../scripts/verify-native-binary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REGISTRY = "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz";
const good = () => ({
  lockfileVersion: 3,
  packages: { "node_modules/better-sqlite3": { version: "13.0.3", resolved: REGISTRY, integrity: "sha512-RbOBxxxxxxxxxxxxxxxxxxxxxx==" } },
});

describe("#182 — native binary: lockfile integrity pin", () => {
  it("PASSes an exact version pinned by a registry integrity hash", () => {
    const r = checkLockfileIntegrity(good());
    expect(r.ok).toBe(true);
    expect(r.version).toBe("13.0.3");
  });

  it("FAILs when the integrity hash is missing (tarball not pinned)", () => {
    const l = good();
    delete l.packages["node_modules/better-sqlite3"].integrity;
    const r = checkLockfileIntegrity(l);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/integrity/i);
  });

  it("FAILs on a non-exact version", () => {
    const l = good();
    l.packages["node_modules/better-sqlite3"].version = "^13.0.3";
    expect(checkLockfileIntegrity(l).ok).toBe(false);
  });

  it("FAILs when resolved from a non-registry source (git/file/tarball URL)", () => {
    const l = good();
    l.packages["node_modules/better-sqlite3"].resolved = "git+https://github.com/x/better-sqlite3.git#deadbeef";
    const r = checkLockfileIntegrity(l);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-registry/i);
  });

  it("FAILs when there is no lockfile entry at all", () => {
    expect(checkLockfileIntegrity({ lockfileVersion: 3, packages: {} }).ok).toBe(false);
  });

  it("the REAL package-lock.json pins better-sqlite3 by integrity", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"));
    const r = checkLockfileIntegrity(lock);
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(r.integrity).toMatch(/^sha(256|384|512)-/);
  });
});

describe("#182 — native binary: the bundled prebuild loads on this platform", () => {
  it("resolves, loads, and answers a query", () => {
    const r = checkBundledPrebuildLoads();
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(r.sqlite).toMatch(/^\d+\.\d+/); // a real sqlite version string
  });
});
