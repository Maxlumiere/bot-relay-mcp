// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-D, the CONDITION on which stdio stays out of the registration gate (ruling f885e674 Q6): a local process
 * that can spawn the server can already open the DB, so stdio needs no secret ONLY IF the relay's private
 * files are private to their owner. POSIX: directories 0700; the DB, its -wal and -shm, and the registration
 * secret 0600. Windows (ruling efb48600 Q12): NO allow ACE for Everyone, Users or Authenticated Users, checked
 * by SID (account names are localized). Runs on all three CI operating systems.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-d-perms-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "inst", "relay.db");
delete process.env.RELAY_ALLOW_LEGACY;

const db = await import("../src/db.js");
const { privacyFaults, FORBIDDEN_SIDS } = await import("../src/fs-perms.js");
const { ensureMintSecret, mintSecretDir, mintSecretPath } = await import("../src/mint-secret.js");

afterAll(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the relay's private files are private to their owner (Q6, on every OS)", () => {
  it("the instance dir, the DB, its -wal and -shm, the secrets dir and the registration secret", () => {
    db.getDb();
    db.registerAgent("perm-probe", "worker", []); // a write: WAL mode creates -wal and -shm
    const inst = path.join(ROOT, "inst");
    ensureMintSecret(inst);
    const dbPath = path.join(inst, "relay.db");
    for (const f of [`${dbPath}-wal`, `${dbPath}-shm`]) expect(fs.existsSync(f), `${f} exists (WAL mode)`).toBe(true);
    const faults = [
      ...privacyFaults(inst, 0o700),
      ...privacyFaults(dbPath, 0o600),
      ...privacyFaults(`${dbPath}-wal`, 0o600),
      ...privacyFaults(`${dbPath}-shm`, 0o600),
      ...privacyFaults(mintSecretDir(inst), 0o700),
      ...privacyFaults(mintSecretPath(inst), 0o600),
    ];
    expect(faults).toEqual([]);
  });

  it("the check itself SEES a world-readable file (a known-bad control)", () => {
    const open = path.join(ROOT, "open.txt");
    fs.writeFileSync(open, "x");
    if (process.platform === "win32") {
      // Grant Everyone read by SID, then the check must name it.
      expect(spawnSync("icacls", [open, "/grant", "*S-1-1-0:R"], { windowsHide: true }).status).toBe(0);
      expect(privacyFaults(open, 0o600).join("\n")).toMatch(new RegExp(FORBIDDEN_SIDS["S-1-1-0"]));
    } else {
      fs.chmodSync(open, 0o644);
      expect(privacyFaults(open, 0o600)).toHaveLength(1);
    }
  });
});

describe("the SDDL reader (the Windows ACL check's parser, unit-tested on every OS)", () => {
  it("maps the forbidden aliases to their SIDs and keeps only ALLOW aces", async () => {
    const { sddlAllowSids } = await import("../src/fs-perms.js");
    // owner-only (a SID), SYSTEM (SY) and Administrators (BA): none forbidden
    expect(sddlAllowSids("D:PAI(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")).toEqual(["S-1-5-21-1-2-3-1001", "SY", "BA"]);
    // Everyone, Users, Authenticated Users as aliases AND as raw SIDs
    expect(sddlAllowSids("D:(A;;FR;;;WD)(A;;FR;;;BU)(A;;FR;;;AU)(A;;FR;;;S-1-1-0)")).toEqual(["S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-1-0"]);
    // a DENY ace for Everyone is not an allow; a SACL part after the DACL is ignored
    expect(sddlAllowSids("O:BAG:SYD:(D;;FA;;;WD)(A;;FA;;;S-1-5-21-9)S:(AU;SA;FA;;;WD)")).toEqual(["S-1-5-21-9"]);
  });
});
