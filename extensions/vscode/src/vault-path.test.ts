// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.5.0 — vault-path resolver tests. The load-bearing case (per-instance path):
// with an active per-instance setup, a tempting STALE token in the FLAT vault
// must NOT be chosen — the resolver keys on the SAME rule the relay uses.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveVaultTokenPath,
  readVaultToken,
  type EnvRecord,
} from "./vault-path.js";

let home: string;
const GOOD = "G".repeat(40); // valid token shape, the CURRENT instance token
const STALE = "S".repeat(40); // valid shape, but the WRONG (flat) token

function plantVault(dir: string, name: string, token: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.token`), token + "\n");
}
function logs() {
  const out: string[] = [];
  return { log: (l: string) => out.push(l), out };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "v050-vault-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("resolveVaultTokenPath — mirrors resolveInstanceDbPath", () => {
  it("RELAY_DB_PATH explicit → vault sits next to that DB", () => {
    const env: EnvRecord = { RELAY_DB_PATH: "/custom/place/relay.db" };
    const r = resolveVaultTokenPath("a1", env, home);
    expect(r).toEqual({ tokenPath: "/custom/place/agents/a1.token" });
  });

  it("no instance configured (no env, no active-instance) → flat vault", () => {
    const env: EnvRecord = { RELAY_HOME: home };
    const r = resolveVaultTokenPath("a1", env, home);
    expect(r).toEqual({ tokenPath: path.join(home, "agents", "a1.token") });
  });

  it("RELAY_INSTANCE_ID env → per-instance vault", () => {
    const env: EnvRecord = { RELAY_HOME: home, RELAY_INSTANCE_ID: "inst-x" };
    const r = resolveVaultTokenPath("a1", env, home);
    expect(r).toEqual({ tokenPath: path.join(home, "instances", "inst-x", "agents", "a1.token") });
  });

  it("(1) LOAD-BEARING — active-instance file + a tempting STALE flat vault → the INSTANCE vault wins", () => {
    // active-instance pointer file → instance "abc"
    fs.writeFileSync(path.join(home, "active-instance"), "abc\n");
    // plant BOTH: the correct instance token AND a stale flat token
    plantVault(path.join(home, "instances", "abc", "agents"), "watcher", GOOD);
    plantVault(path.join(home, "agents"), "watcher", STALE);

    const env: EnvRecord = { RELAY_HOME: home };
    const { log, out } = logs();
    const tok = readVaultToken("watcher", env, home, log);
    expect(tok, "must read the per-instance token, never the tempting flat one").toBe(GOOD);
    expect(tok).not.toBe(STALE);
    expect(out).toEqual([]); // clean resolution, no warning
  });

  it("active-instance SYMLINK → per-instance vault (mirrors relay lstat-no-follow)", () => {
    fs.mkdirSync(path.join(home, "instances", "sy"), { recursive: true });
    fs.symlinkSync("sy", path.join(home, "active-instance"));
    const r = resolveVaultTokenPath("a1", { RELAY_HOME: home }, home);
    expect(r).toEqual({ tokenPath: path.join(home, "instances", "sy", "agents", "a1.token") });
  });
});

describe("readVaultToken — fail-closed + shape + absent", () => {
  it("FAIL CLOSED on a malformed active-instance (empty pointer) → null + log, NOT the flat vault", () => {
    fs.writeFileSync(path.join(home, "active-instance"), "   \n"); // empty after trim
    plantVault(path.join(home, "agents"), "w", STALE); // a flat token that must NOT be read
    const { log, out } = logs();
    const tok = readVaultToken("w", { RELAY_HOME: home }, home, log);
    expect(tok).toBeNull();
    expect(out.join(" ")).toMatch(/fail-closed|empty/i);
  });

  it("FAIL CLOSED on an invalid instance id in the pointer → null, not flat", () => {
    fs.writeFileSync(path.join(home, "active-instance"), "bad/../id\n");
    plantVault(path.join(home, "agents"), "w", STALE);
    const tok = readVaultToken("w", { RELAY_HOME: home }, home, () => {});
    expect(tok).toBeNull();
  });

  it("absent vault file → null silently (caller falls back to SecretStorage/env)", () => {
    const { log, out } = logs();
    const tok = readVaultToken("w", { RELAY_HOME: home }, home, log);
    expect(tok).toBeNull();
    expect(out, "absent is a normal miss, not a warning").toEqual([]);
  });

  it("present but wrong SHAPE → null + a log that NEVER contains the value", () => {
    plantVault(path.join(home, "agents"), "w", "short"); // < 8 chars → invalid shape
    const { log, out } = logs();
    const tok = readVaultToken("w", { RELAY_HOME: home }, home, log);
    expect(tok).toBeNull();
    expect(out.join(" ")).toMatch(/shape/i);
    expect(out.join(" ")).not.toContain("short"); // token value never logged
  });

  it("invalid agent name → miss", () => {
    expect(resolveVaultTokenPath("bad name!", { RELAY_HOME: home }, home)).toEqual({
      miss: expect.stringContaining("invalid agent name"),
    });
  });
});
