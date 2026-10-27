// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay backup` must never write an archive that `relay restore` will refuse. Restore caps the decompressed archive
 * (MAX_DECOMPRESSED_BYTES) and each member (MAX_MEMBER_BYTES) in src/backup-archive.ts; export checks the SAME caps
 * before it writes anything, so a too-large backup fails loudly at backup time, not silently at restore time (when it
 * is needed). The caps are lowered here through the module (a real 4 GiB DB cannot be made in a test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const CAPS = vi.hoisted(() => ({ total: 4 * 1024 ** 3, manifest: 1024 ** 2, config: 1024 ** 2 }));
vi.mock("../src/backup-archive.js", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("../src/backup-archive.js");
  return {
    ...real,
    get MAX_DECOMPRESSED_BYTES() {
      return CAPS.total;
    },
    get MAX_MEMBER_BYTES() {
      return { "relay.db": CAPS.total, "manifest.json": CAPS.manifest, "config.json": CAPS.config };
    },
  };
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "backup-export-cap-"));
process.env.RELAY_DB_PATH = path.join(ROOT, "db", "relay.db");
process.env.RELAY_CONFIG_PATH = path.join(ROOT, "db", "config.json");
for (const k of ["RELAY_AGENT_TOKEN", "RELAY_AGENT_NAME", "RELAY_AGENT_ROLE", "RELAY_AGENT_CAPABILITIES", "RELAY_ALLOW_LEGACY"]) delete process.env[k];

beforeEach(async () => {
  CAPS.total = 4 * 1024 ** 3;
  CAPS.config = 1024 ** 2;
  const db = await import("../src/db.js");
  db.closeDb();
  await db.initializeDb();
  db.registerAgent("alpha", "r", []);
});
afterEach(async () => {
  (await import("../src/db.js")).closeDb();
  fs.rmSync(path.join(ROOT, "db", "config.json"), { force: true });
});

describe("export refuses what restore would refuse, BEFORE it writes an archive", () => {
  it("HARM: an archive over the restore cap is refused, and no archive is written", async () => {
    CAPS.total = 1024; // smaller than any real relay.db
    const dest = path.join(ROOT, "db", "over.tar.gz");
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/restore would refuse it/);
    expect(fs.existsSync(dest)).toBe(false);
  });
  it("HARM: a config.json over its member cap is refused, and no archive is written", async () => {
    CAPS.config = 16;
    fs.writeFileSync(path.join(ROOT, "db", "config.json"), JSON.stringify({ padding: "x".repeat(64) }));
    const dest = path.join(ROOT, "db", "config-over.tar.gz");
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/config\.json.*restore would refuse it/);
    expect(fs.existsSync(dest)).toBe(false);
  });
  it("known-good twin: under the caps the archive is written", async () => {
    const dest = path.join(ROOT, "db", "ok.tar.gz");
    const { exportRelayState } = await import("../src/backup.js");
    const r = await exportRelayState({ destinationPath: dest });
    expect(fs.existsSync(r.archive_path)).toBe(true);
  });
});
