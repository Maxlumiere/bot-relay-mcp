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
    // Codex R1 #2: every alias is mapped to its SID, so the owner-only ALLOWLIST compares SIDs only (SYSTEM, then
    // Administrators: the second is NOT on the allowlist)
    expect(sddlAllowSids("D:PAI(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")).toEqual(["S-1-5-21-1-2-3-1001", "S-1-5-18", "S-1-5-32-544"]);
    // an alias the map does not know stays as written: never equal to the owner's SID or SYSTEM, so never a pass
    expect(sddlAllowSids("D:(A;;FA;;;ZZ)")).toEqual(["ZZ"]);
    // Everyone, Users, Authenticated Users as aliases AND as raw SIDs
    expect(sddlAllowSids("D:(A;;FR;;;WD)(A;;FR;;;BU)(A;;FR;;;AU)(A;;FR;;;S-1-1-0)")).toEqual(["S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-1-0"]);
    // a DENY ace for Everyone is not an allow; a SACL part after the DACL is ignored
    expect(sddlAllowSids("O:BAG:SYD:(D;;FA;;;WD)(A;;FA;;;S-1-5-21-9)S:(AU;SA;FA;;;WD)")).toEqual(["S-1-5-21-9"]);
  });
});

/**
 * Codex R1 #2: the registration secret is usable ONLY when the chain that controls its bytes (the instance dir, the
 * secrets dir, the file) is private to this user. A foreign write anywhere in it lets that principal plant a known
 * value. Every element is tested, each with a known-good twin, so a refusal cannot come from a broken fixture.
 */
describe("the registration secret's chain fails CLOSED when any element is not private (Codex R1 #2)", () => {
  const fresh = () => {
    const inst = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, "chain-")));
    ensureMintSecret(inst);
    return inst;
  };
  const chain = (inst: string) => [
    { label: "the instance dir", p: inst, dir: true },
    { label: "the secrets dir", p: mintSecretDir(inst), dir: true },
    { label: "the secret file", p: mintSecretPath(inst), dir: false },
  ];

  it("the known-good chain: the secret is read", async () => {
    const { readMintSecret, mintSecretChainFaults } = await import("../src/mint-secret.js");
    const inst = fresh();
    expect(mintSecretChainFaults(inst)).toEqual([]);
    expect(readMintSecret(inst)).not.toBeNull();
  });

  if (process.platform !== "win32") {
    it("POSIX: group or other bits on ANY element → refused, naming that element; ensureMintSecret tightens what this user owns", async () => {
      const { readMintSecret } = await import("../src/mint-secret.js");
      for (const el of chain(fresh())) {
        const inst = el.label === "the instance dir" ? el.p : el.dir ? path.dirname(el.p) : path.dirname(path.dirname(el.p));
        fs.chmodSync(el.p, el.dir ? 0o770 : 0o640);
        expect(() => readMintSecret(inst), el.label).toThrow(new RegExp(`${el.p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has mode`));
        ensureMintSecret(inst); // the daemon-start path: this user owns it, so it is tightened back
        expect(readMintSecret(inst), `${el.label} tightened`).not.toBeNull();
      }
    });

    it("POSIX: an element owned by ANOTHER uid → refused (the ownership seam), never chmod'ed, and the gate reports unavailable", async () => {
      const { readMintSecret, mintChainSeams } = await import("../src/mint-secret.js");
      const inst = fresh();
      const real = mintChainSeams.euid;
      const realUid = real()!;
      mintChainSeams.euid = () => realUid + 1;
      try {
        expect(() => readMintSecret(inst)).toThrow(new RegExp(`owned by uid ${realUid}, not by this relay's uid ${realUid + 1}`));
        expect(() => ensureMintSecret(inst)).toThrow(/not private to this user/);
      } finally {
        mintChainSeams.euid = real;
      }
      expect(readMintSecret(inst), "the twin: the real owner reads it").not.toBeNull();
    });

    it("POSIX: the file is checked through its OPENED descriptor (a 0644 file is refused even when the path looks fine afterwards)", async () => {
      const { mintSecretChainFaults } = await import("../src/mint-secret.js");
      const inst = fresh();
      const fd = fs.openSync(mintSecretPath(inst), "r");
      try {
        fs.fchmodSync(fd, 0o644);
        expect(mintSecretChainFaults(inst, fd).join("\n")).toMatch(/mint\.secret has mode 0644/);
      } finally {
        fs.closeSync(fd);
      }
    });
  } else {
    // An arbitrary non-owner SID (BUILTIN\Power Users), planted on EACH element, then the SYSTEM twin.
    const grant = (p: string, sid: string, dir: boolean) =>
      expect(spawnSync("icacls", [p, "/grant", `*${sid}:${dir ? "(OI)(CI)" : ""}F`], { windowsHide: true }).status).toBe(0);

    it("Windows: a foreign SID planted on ANY element → refused naming it; ensureMintSecret REMOVES it; the SYSTEM twin stays usable", async () => {
      const { readMintSecret } = await import("../src/mint-secret.js");
      for (const el of chain(fresh())) {
        const inst = el.label === "the instance dir" ? el.p : el.dir ? path.dirname(el.p) : path.dirname(path.dirname(el.p));
        // The DISCRIMINATING observation for the verdict cache (src/mint-secret.ts windowsFaults): a clean read FIRST,
        // so every element's clean verdict is cached; then the ACL write; then a read AT ONCE must see it. If an ACL
        // write did not move the cache key (ino, ctime, mtime), the cached clean verdict would answer: this fails.
        expect(readMintSecret(inst), `${el.label}: clean, and now cached`).not.toBeNull();
        grant(el.p, "S-1-5-32-547", el.dir);
        expect(() => readMintSecret(inst), `${el.label}: the ACE added after a cached clean verdict is seen at once`).toThrow(/S-1-5-32-547/);
        ensureMintSecret(inst);
        expect(readMintSecret(inst), `${el.label}: the foreign ACE was removed`).not.toBeNull();
        grant(el.p, "S-1-5-18", el.dir); // SYSTEM: tolerated
        expect(readMintSecret(inst), `${el.label}: SYSTEM is tolerated`).not.toBeNull();
      }
    });

    it("Windows: the owner probe learns how icacls spells THIS user (a SID, or an alias such as LA)", async () => {
      const fsPerms = await import("../src/fs-perms.js");
      const token = fsPerms.windowsOwnerSddlToken();
      expect(token, `owner probe: ${fsPerms.windowsOwnerProbeNote}`).not.toBeNull();
    });

    it("Windows: Administrators is NOT on the allowlist", async () => {
      const { readMintSecret } = await import("../src/mint-secret.js");
      const inst = fresh();
      grant(mintSecretPath(inst), "S-1-5-32-544", false);
      expect(() => readMintSecret(inst)).toThrow(/S-1-5-32-544/);
    });
  }
});
