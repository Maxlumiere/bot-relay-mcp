// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-04 (security/invariants.json): the private chain is owner-only. LOAD-BEARING for SEC-01: a stdio register
 * needs no secret (PR-D Q6) ONLY because reaching the DB takes same-user file access, so if these fail, that
 * exclusion is void (ruled 13 Oct).
 *
 * The INSTALLED daemon starts in a fresh sandbox HOME with NO relay path set, so it resolves and creates its own
 * instance (the shipped default). Then, on POSIX: every directory from the relay home down to the DB's directory, and
 * the secrets directory, is owned by this user with no group/other bits; relay.db, -wal and -shm, and the mint
 * secret, likewise. Windows (ACLs) is not covered here yet: see the registry.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { sandbox, startHttpDaemon, type HttpDaemon } from "./_installed.js";

const daemons: HttpDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
});

/** Every file under `root` (any depth). */
function walk(root: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("SEC-04: the private chain is owner-only (POSIX)", () => {
  it("SEC-04.T1 HARM-guard the default instance chain, its DB files and the mint secret are owner-only", async (ctx) => {
    // POSIX modes only; the registry's `os` makes SEC-04 N/A on win32 (its ACL check is gate slice G2). A RUNTIME skip,
    // never describe.skipIf: `vitest list` drops every test under a skipIf'd describe, even when the condition is
    // false (vitest 5, measured), and the registry meta-test resolves test ids through that list.
    if (process.platform === "win32") ctx.skip("SEC-04's Windows ACL check is gate slice G2");
    const sb = sandbox("s04", { defaultPaths: true });
    const d = await startHttpDaemon(sb);
    daemons.push(d);
    // A write makes the WAL sidecars exist.
    await d.rpc("register_agent", { name: "s04-agent", role: "worker", capabilities: [] }, d.mintHeaders());
    const files = walk(sb.relayHome);
    const dbs = files.filter((f) => path.basename(f) === "relay.db");
    expect(dbs.length, `the daemon's own DB under ${sb.relayHome}: ${files.join(", ")}`).toBe(1);
    const db = dbs[0]!;
    const uid = process.getuid!();
    const bad: string[] = [];
    const check = (p: string) => {
      const st = fs.statSync(p);
      if (st.uid !== uid) bad.push(`${p}: owner uid ${st.uid}, not ${uid}`);
      if (st.mode & 0o077) bad.push(`${p}: mode 0${(st.mode & 0o777).toString(8)} (group/other bits)`);
    };
    for (let dir = path.dirname(db); ; dir = path.dirname(dir)) {
      check(dir);
      if (dir === sb.relayHome) break;
    }
    for (const sidecar of ["", "-wal", "-shm"]) {
      expect(fs.existsSync(db + sidecar), `${db + sidecar} exists`).toBe(true);
      check(db + sidecar);
    }
    const secret = files.find((f) => path.basename(f) === "mint.secret");
    expect(secret, `a registration secret under ${sb.relayHome}`).toBeDefined();
    check(path.dirname(secret!));
    check(secret!);
    expect(bad, bad.join("\n")).toEqual([]);
    // CONTROL: the same checker flags a widened file, or a green above proves nothing.
    const widened = path.join(sb.home, "control-widened");
    fs.writeFileSync(widened, "x", { mode: 0o644 });
    fs.chmodSync(widened, 0o644);
    check(widened);
    expect(bad, "the checker sees group/other bits").toEqual([expect.stringMatching(/control-widened: mode 0644/)]);
  });
});
