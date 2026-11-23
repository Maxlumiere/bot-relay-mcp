// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Item 0b (Codex #442 R1 P2-3): explicit provisioning never follows a link below the relay home.
 *
 * The trust boundary is the relay home ROOT (resolved once with realpath: it MAY be a link). Below it, instances/,
 * instances/<id>/ and instance.json are never followed: a linked directory is refused by ROLE, and a linked
 * instance.json is replaced (temp file + rename) without its target being written. Every refusal is asserted on the
 * harm: the link's TARGET is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInstance, readInstance, resolveInstance } from "../src/instance.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const NO_SYMLINKS = process.platform === "win32";
const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH"] as const;

let home: string;
let outside: string;
let saved: Record<string, string | undefined>;
const relayRoot = () => path.join(home, ".bot-relay");

/** Every entry under `dir`, recursively, with file contents: the "target untouched" fingerprint. */
function fingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out.push(`d ${path.relative(dir, p)} ${(fs.statSync(p).mode & 0o777).toString(8)}`);
        walk(p);
      } else out.push(`f ${path.relative(dir, p)} ${(fs.statSync(p).mode & 0o777).toString(8)} ${fs.readFileSync(p, "utf-8")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-home-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-outside-"));
  fs.chmodSync(outside, 0o755);
  fs.writeFileSync(path.join(outside, "keep.txt"), "untouched", { mode: 0o644 });
  process.env.HOME = home;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(NO_SYMLINKS)("createInstance never follows a link below the relay home (item 0b)", () => {
  it("a LINKED instances/ is refused by role; the link's target is untouched", () => {
    fs.mkdirSync(relayRoot(), { mode: 0o700 });
    fs.symlinkSync(outside, path.join(relayRoot(), "instances"));
    const before = fingerprint(outside);
    expect(() => createInstance("x", "t")).toThrow(/the instances directory is not a real directory/);
    expect(fingerprint(outside), "nothing created, written or chmod'ed through the link").toBe(before);
  });

  it("a LINKED instances/<id>/ is refused by role; the link's target is untouched", () => {
    fs.mkdirSync(path.join(relayRoot(), "instances"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.join(relayRoot(), "instances", "x"));
    const before = fingerprint(outside);
    expect(() => createInstance("x", "t")).toThrow(/the instance directory is not a real directory/);
    expect(fingerprint(outside)).toBe(before);
  });

  it("an instances/<id> that is a regular FILE is refused by role (not a directory)", () => {
    fs.mkdirSync(path.join(relayRoot(), "instances"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(relayRoot(), "instances", "x"), "file");
    expect(() => createInstance("x", "t")).toThrow(/the instance directory is not a real directory/);
  });

  it("a LINKED instance.json is REPLACED by a real file; its target is never written", () => {
    fs.mkdirSync(path.join(relayRoot(), "instances", "x"), { recursive: true, mode: 0o700 });
    const target = path.join(outside, "keep.txt");
    fs.symlinkSync(target, path.join(relayRoot(), "instances", "x", "instance.json"));
    const before = fingerprint(outside);
    const meta = createInstance("x", "t");
    expect(meta.instance_id).toBe("x");
    const st = fs.lstatSync(path.join(relayRoot(), "instances", "x", "instance.json"));
    expect(st.isSymbolicLink(), "the link was replaced").toBe(false);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(fingerprint(outside), "the link's target was neither read into nor written").toBe(before);
    expect(fs.readdirSync(path.join(relayRoot(), "instances", "x")), "no temp file left").toEqual(["instance.json"]);
  });

  it("a LINKED instance.json is not a provisioning record (the reader does not follow it)", () => {
    fs.mkdirSync(path.join(relayRoot(), "instances", "x"), { recursive: true, mode: 0o700 });
    const real = path.join(outside, "instance.json");
    fs.writeFileSync(real, JSON.stringify({ instance_id: "x" }));
    fs.symlinkSync(real, path.join(relayRoot(), "instances", "x", "instance.json"));
    expect(readInstance("x")).toBeNull();
    process.env.RELAY_INSTANCE_ID = "x";
    expect(resolveInstance()).toMatchObject({ kind: "error", unprovisioned: true });
  });

  it("a LINKED relay home ROOT is ALLOWED (the trust boundary): the instance lands in the link's real directory", () => {
    const realHome = path.join(outside, "relay-home");
    fs.mkdirSync(realHome, { mode: 0o700 });
    fs.symlinkSync(realHome, relayRoot());
    const meta = createInstance("x", "t", "lbl");
    expect(meta.label).toBe("lbl");
    expect(fs.lstatSync(path.join(realHome, "instances", "x", "instance.json")).isFile()).toBe(true);
    expect(readInstance("x")?.instance_id).toBe("x");
  });

  it("existing real directories are narrowed to 0700 (through a no-follow descriptor)", () => {
    fs.mkdirSync(path.join(relayRoot(), "instances", "x"), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(relayRoot(), "instances"), 0o755);
    fs.chmodSync(path.join(relayRoot(), "instances", "x"), 0o755);
    createInstance("x", "t");
    expect(fs.statSync(path.join(relayRoot(), "instances")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(relayRoot(), "instances", "x")).mode & 0o777).toBe(0o700);
  });

  it("relay init --instance-id over a LINKED instances/ exits non-zero naming the role; the target is untouched", () => {
    fs.mkdirSync(relayRoot(), { mode: 0o700 });
    fs.symlinkSync(outside, path.join(relayRoot(), "instances"));
    const before = fingerprint(outside);
    const r = spawnSync(process.execPath, [RELAY_BIN, "init", "--yes", "--config-only", "--instance-id", "x"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), RELAY_HTTP_PORT: "1" },
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stderr).toContain("the instances directory is not a real directory");
    expect(fingerprint(outside)).toBe(before);
  });
});
