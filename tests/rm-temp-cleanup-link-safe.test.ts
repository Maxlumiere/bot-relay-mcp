// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Codex #472 R1 (ruling bac8abd5): a trusted writer's CLEANUP after it refused a replaced temp must remove whatever
 * now sits at the temp NAME, a link included. On Node v24.13.0 (the Node the live daemon runs) fs.rmSync on a DANGLING
 * symlink returns without error and LEAVES it (MEASURED on macOS and on the Linux 24.13.0 CI leg); fs.unlinkSync
 * removes the link itself. These rows DISCRIMINATE only on Node 24.13.0 (this Mac, or the 24.13.0 CI leg); on a Node
 * that removes the link either way they pass before and after the fix.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-temp-link-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** The temp's name now names a DANGLING link (the replaced-temp case the writer refuses). */
const danglingSwap = (tmp: string) => {
  fs.unlinkSync(tmp);
  fs.symlinkSync(path.join(ROOT, "no-such-target"), tmp);
};
const leftovers = (dir: string, re: RegExp) => fs.readdirSync(dir).filter((n) => re.test(n));

describe.skipIf(process.platform === "win32")("a refused temp leaves NOTHING at its name, a dangling link included", () => {
  it("owner-endpoint: the record's temp replaced by a dangling link → the write refuses, and the link is GONE", async () => {
    const m = await import("../src/owner-endpoint.js");
    const dir = fs.mkdtempSync(path.join(ROOT, "owner-"));
    const db = path.join(dir, "relay.db");
    fs.writeFileSync(db, "");
    m._setWriterHookForTests(danglingSwap);
    try {
      expect(() => m.writeOwnerEndpoint(db, 1234, "http")).toThrow();
    } finally {
      m._setWriterHookForTests(null);
    }
    expect(leftovers(dir, /\.tmp$/), "no temp name left behind (a dangling link would survive rmSync on Node 24.13.0)").toEqual([]);
  });
  it("cli/remote: the secret's temp replaced by a dangling link → the write refuses, and the link is GONE", async () => {
    const m = (await import("../src/cli/remote.js")) as unknown as { writeRemoteMintSecret: (dir: string, secret: string) => string; _setCreateHookForTests: (fn: ((tmp: string) => void) | null) => void };
    const dir = path.join(fs.mkdtempSync(path.join(ROOT, "remote-")), "scope");
    m._setCreateHookForTests(danglingSwap);
    try {
      expect(() => m.writeRemoteMintSecret(dir, "a-secret-for-the-test")).toThrow();
    } finally {
      m._setCreateHookForTests(null);
    }
    expect(leftovers(dir, /\.tmp$/), "no temp name left behind").toEqual([]);
    expect(fs.existsSync(path.join(dir, "mint.secret")), "no secret published").toBe(false);
  });
});

/** The temp's name now names a DIRECTORY: its cleanup (unlinkSync) fails with EPERM / EISDIR. */
const dirSwap = (tmp: string) => {
  fs.unlinkSync(tmp);
  fs.mkdirSync(tmp);
};

describe.skipIf(process.platform === "win32")("ruling 81d038ab: a cleanup that FAILS (a directory at the temp name) never replaces the primary refusal; it is ATTACHED, naming the path left behind", () => {
  it("owner-endpoint: the refusal is still the writer's own, and it names the temp left behind", async () => {
    const m = await import("../src/owner-endpoint.js");
    const dir = fs.mkdtempSync(path.join(ROOT, "owner-dir-"));
    const db = path.join(dir, "relay.db");
    fs.writeFileSync(db, "");
    let tmp = "";
    m._setWriterHookForTests((t) => {
      tmp = t;
      dirSwap(t);
    });
    let msg = "";
    try {
      m.writeOwnerEndpoint(db, 1234, "http");
    } catch (err) {
      msg = (err as Error).message;
    } finally {
      m._setWriterHookForTests(null);
    }
    expect(msg, "the primary refusal, not the cleanup's error").not.toMatch(/^(EPERM|EISDIR)/);
    expect(msg).toMatch(/record's temp file/);
    expect(msg, "the path left behind is named").toContain(tmp);
    expect(msg).toMatch(/left behind/);
  });
  it("cli/remote: the refusal is still the writer's own, and it names the temp left behind", async () => {
    const m = (await import("../src/cli/remote.js")) as unknown as { writeRemoteMintSecret: (dir: string, secret: string) => string; _setCreateHookForTests: (fn: ((tmp: string) => void) | null) => void };
    const dir = path.join(fs.mkdtempSync(path.join(ROOT, "remote-dir-")), "scope");
    let tmp = "";
    m._setCreateHookForTests((t) => {
      tmp = t;
      dirSwap(t);
    });
    let msg = "";
    try {
      m.writeRemoteMintSecret(dir, "a-secret-for-the-test");
    } catch (err) {
      msg = (err as Error).message;
    } finally {
      m._setCreateHookForTests(null);
    }
    expect(msg, "the primary refusal, not the cleanup's error").not.toMatch(/^(EPERM|EISDIR)/);
    expect(msg).toMatch(/the new file is not the one its name names/);
    expect(msg, "the path left behind is named").toContain(tmp);
    expect(msg).toMatch(/left behind/);
  });
});

describe("review R2 P3 (ruling 276d0f4b): the temp's cleanup covers its WHOLE post-create lifetime", () => {
  it("cli/remote: the RENAME into place fails (EIO) → the write throws, and its temp is removed (every Node)", async () => {
    const m = (await import("../src/cli/remote.js")) as unknown as { writeRemoteMintSecret: (dir: string, secret: string) => string };
    const dir = path.join(fs.mkdtempSync(path.join(ROOT, "remote-rn-")), "scope");
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      if (String(a).endsWith(".tmp") && String(b).endsWith("mint.secret")) throw Object.assign(new Error("EIO: i/o error, rename (injected)"), { code: "EIO" });
      return real(a, b);
    }) as typeof fs.renameSync);
    try {
      expect(() => m.writeRemoteMintSecret(dir, "a-secret-for-the-test")).toThrow(/EIO/);
    } finally {
      spy.mockRestore();
    }
    expect(leftovers(dir, /\.tmp$/), "the temp does not outlive a failed rename").toEqual([]);
  });
});
