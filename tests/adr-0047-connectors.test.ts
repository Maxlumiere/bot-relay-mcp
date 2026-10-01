// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 2: the `connectors` table (schema v26). One row per connector
 * PROCESS, one writer per row: each stdio connector writes only the row keyed by
 * its own (pid, start token), once at startup, with the window anchor it detected,
 * the realpath of the install it was loaded from, and the build it loaded.
 *
 * - Liveness is derived at READ time, from the pid AND its start token (the
 *   deploy-gate identity pattern): a dead or reused pid never counts as live.
 * - Dead rows are purged only by the daemon, only when POSITIVELY dead and older
 *   than 7 days; correctness never depends on the purge.
 * - Every key starts with edge_id, and a foreign edge is refused (ADR-0043).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0047-pr2-")));
const DB_FILE = path.join(ROOT, "relay.db");
process.env.RELAY_DB_PATH = DB_FILE;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = await import("../src/db.js");
const { processStartedAt, getOwnHostId, _resetOwnHostIdForTests } = await import("../src/liveness.js");
const { LOADED_BUILD } = await import("../src/loaded-build.js");
const { BUILD_INFO: DIST_STAMP } = await import("../dist/build-info.js");

beforeEach(async () => {
  db.closeDb();
  fs.rmSync(DB_FILE, { force: true });
  await db.initializeDb();
});

const edge = () => db.getLocalEdgeId(db.getDb());
const rows = () => db.getDb().prepare("SELECT * FROM connectors ORDER BY pid").all() as Array<Record<string, unknown>>;
const DAY = 24 * 60 * 60 * 1000;
/** A raw row (TEST ONLY: the product has no writer that takes a pid). */
function plant(r: { pid: number; pid_start: string; started_at?: string; host_id?: string | null; edge_id?: string }): void {
  db.getDb()
    .prepare(
      "INSERT INTO connectors (edge_id, pid, pid_start, parent_pid, parent_start, build_id, deps_id, deps_state, node, commit_sha, dirty, built_at, resolver_revision, install_dir, host_id, started_at) " +
        "VALUES (?, ?, ?, NULL, NULL, 'x', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '/i', ?, ?)",
    )
    .run(r.edge_id ?? edge(), r.pid, r.pid_start, r.host_id === undefined ? getOwnHostId() : r.host_id, r.started_at ?? new Date().toISOString());
}
/** A pid that WAS a process and is now gone, with its real start token. */
function deadPid(): { pid: number; start: string } {
  const r = spawnSync("sh", ["-c", 'sleep 0.3 & p=$!; LC_ALL=C ps -o lstart= -p $p; echo "$p"; wait'], { encoding: "utf-8" });
  const [start, pid] = r.stdout.trim().split("\n").map((s) => s.trim());
  return { pid: Number(pid), start };
}

describe("ADR-0047 PR 2 — schema v26: the connectors table", () => {
  it("a fresh DB is at v26 and has the table, keyed (edge_id, pid, pid_start)", () => {
    expect(db.getSchemaVersion()).toBe(26);
    const pk = db.getDb().prepare("SELECT name FROM pragma_table_info('connectors') WHERE pk > 0 ORDER BY pk").all() as Array<{ name: string }>;
    expect(pk.map((c) => c.name)).toEqual(["edge_id", "pid", "pid_start"]);
  });
  it("the migration is idempotent (a second open changes nothing)", async () => {
    db.recordOwnConnector({ parent: null, build: LOADED_BUILD });
    db.closeDb();
    await db.initializeDb();
    expect(db.getSchemaVersion()).toBe(26);
    expect(rows()).toHaveLength(1);
  });
  it("a FOREIGN edge is refused by the database (ADR-0043: rows are stamped from relay_edge only)", () => {
    expect(() => plant({ pid: 1, pid_start: "x", edge_id: "00000000-0000-4000-8000-000000000000" })).toThrow(/foreign edge_id refused/);
  });
});

describe("ADR-0047 PR 2 — the writer: a connector writes ONLY its own row", () => {
  it("the row is keyed by THIS process's pid and its own start token; the build is the one LOADED", () => {
    db.recordOwnConnector({ parent: { pid: 4242, startedAt: "Mon Sep 28 11:17:16 2026" }, build: LOADED_BUILD });
    const [r] = rows();
    expect(r.pid).toBe(process.pid);
    expect(r.pid_start).toBe(processStartedAt(process.pid));
    expect(r.edge_id).toBe(edge());
    expect(r.parent_pid).toBe(4242);
    expect(r.parent_start).toBe("Mon Sep 28 11:17:16 2026");
    expect(r.build_id).toBe(LOADED_BUILD.build_id);
    expect(r.deps_id).toBe(LOADED_BUILD.deps_id);
    expect(r.deps_state).toBe(LOADED_BUILD.deps_state);
    expect(r.node).toBe(process.version);
  });
  it("the writer takes NO pid (it cannot be aimed at another process's row)", () => {
    // A caller that tries to pass one is ignored: the row is still this process's.
    db.recordOwnConnector({ parent: null, build: LOADED_BUILD, pid: 1, pid_start: "forged" } as unknown as Parameters<typeof db.recordOwnConnector>[0]);
    expect(rows().map((r) => r.pid)).toEqual([process.pid]);
    expect(db.recordOwnConnector.length).toBe(1);
  });
  it("a detection miss writes a NULL parent (the window then reads UNKNOWN, never CURRENT)", () => {
    db.recordOwnConnector({ parent: null, build: LOADED_BUILD });
    const [r] = rows();
    expect(r.parent_pid).toBeNull();
    expect(r.parent_start).toBeNull();
  });
  it("install_dir is a REALPATH (a symlinked launch path is the same install)", () => {
    db.recordOwnConnector({ parent: null, build: LOADED_BUILD });
    const [r] = rows();
    expect(r.install_dir).toBe(fs.realpathSync(r.install_dir as string));
  });
});

describe("ADR-0047 PR 2 — liveConnectors: liveness from the pid AND its start token, at read time", () => {
  it("a live row is live; a DEAD pid and a REUSED pid (start token differs) never are", () => {
    db.recordOwnConnector({ parent: null, build: LOADED_BUILD });
    const d = deadPid();
    plant({ pid: d.pid, pid_start: d.start });
    plant({ pid: process.ppid, pid_start: "Thu Jan  1 00:00:00 1970" }); // a live pid, another incarnation
    const live = db.liveConnectors();
    expect(live.map((r) => r.pid)).toEqual([process.pid]);
  });
  it("a row from ANOTHER host is not live here (it cannot be probed from this host)", () => {
    plant({ pid: process.pid, pid_start: processStartedAt(process.pid) as string, host_id: "another-host" });
    expect(db.liveConnectors()).toEqual([]);
  });
  it("host identity is POSITIVE: a row with NO host id is never this host's (never live, never probed)", () => {
    plant({ pid: process.pid, pid_start: processStartedAt(process.pid) as string, host_id: null });
    expect(db.liveConnectors()).toEqual([]);
  });
  it("an UNKNOWN own host id probes nothing: no row is live, and the purger deletes nothing (Codex #295 R1 P2-3)", () => {
    const old = new Date(Date.now() - 8 * DAY).toISOString();
    const d = deadPid();
    plant({ pid: d.pid, pid_start: d.start, started_at: old, host_id: null }); // old + dead, origin unknown
    plant({ pid: process.pid, pid_start: processStartedAt(process.pid) as string, host_id: null });
    _resetOwnHostIdForTests(null);
    try {
      expect(db.liveConnectors()).toEqual([]);
      expect(db.purgeDeadConnectors().purged).toBe(0);
    } finally {
      _resetOwnHostIdForTests();
    }
    expect(rows()).toHaveLength(2);
  });
  it("an unreadable start token is NOT live (never assumed)", () => {
    db.recordOwnConnector({ parent: null, build: LOADED_BUILD });
    expect(db.liveConnectors({ startOf: () => null })).toEqual([]);
  });
});

describe("ADR-0047 PR 2 — purgeDeadConnectors: POSITIVELY dead and older than 7 days, nothing else", () => {
  it("purges an old dead row; keeps an old LIVE row, a YOUNG dead row, and an old row whose liveness cannot be read", () => {
    const old = new Date(Date.now() - 8 * DAY).toISOString();
    const d1 = deadPid();
    const d2 = deadPid();
    plant({ pid: d1.pid, pid_start: d1.start, started_at: old }); // old + dead → purged
    plant({ pid: process.pid, pid_start: processStartedAt(process.pid) as string, started_at: old }); // old + live → kept
    plant({ pid: d2.pid, pid_start: d2.start }); // young + dead → kept
    plant({ pid: process.ppid, pid_start: processStartedAt(process.ppid) as string, started_at: old, host_id: "another-host" }); // unprobeable → kept
    const r = db.purgeDeadConnectors();
    expect(r.purged).toBe(1);
    expect(rows().map((x) => x.pid).sort()).toEqual([d2.pid, process.pid, process.ppid].sort());
  });
  it("a live pid whose start cannot be read is not 'positively dead' (kept)", () => {
    plant({ pid: process.pid, pid_start: "whatever", started_at: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(db.purgeDeadConnectors({ startOf: () => null }).purged).toBe(0);
  });
  it("ONE purger: only the daemon calls it (D5)", () => {
    const hits = spawnSync("grep", ["-rln", "purgeDeadConnectors(", path.join(REPO_ROOT, "src")], { encoding: "utf-8" }).stdout.trim().split("\n").sort();
    expect(hits.map((f) => path.relative(REPO_ROOT, f))).toEqual(["src/db.ts", "src/transport/http.ts"]);
  });
});

describe("ADR-0047 PR 2 — db.ts takes the build from its caller", () => {
  it("db.ts imports loaded-build for its TYPE only (a value import would put the dependency walk on every CLI path)", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src", "db.ts"), "utf-8");
    expect(src).toMatch(/^import type \{ LoadedBuild \} from "\.\/loaded-build\.js";$/m);
    expect(src).not.toMatch(/^import \{[^}]*\} from "\.\/loaded-build\.js";$/m);
  });
});

describe("ADR-0047 PR 2 — end to end: a REAL stdio connector stamps its row at startup", () => {
  async function connect(entry: string, tag: string, env: Record<string, string> = {}, nodeArgs: string[] = []) {
    const tmp = path.join(ROOT, `e2e-${tag}`);
    fs.mkdirSync(tmp, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...nodeArgs, entry],
      env: { PATH: process.env.PATH ?? "", HOME: tmp, RELAY_DB_PATH: path.join(tmp, "relay.db"), RELAY_CONFIG_PATH: path.join(tmp, "none.json"), RELAY_TRANSPORT: "stdio", RELAY_SKIP_TTY_CHECK: "1", ...env },
      stderr: "pipe",
    });
    const client = new Client({ name: "adr0047-pr2", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    const pid = transport.pid as number;
    const read = () => {
      const r = spawnSync("sqlite3", ["-readonly", "-json", path.join(tmp, "relay.db"), "SELECT pid, pid_start, parent_pid, install_dir, build_id, deps_id FROM connectors"], { encoding: "utf-8" });
      return (r.stdout.trim() ? JSON.parse(r.stdout) : []) as Array<Record<string, unknown>>;
    };
    return { pid, read, close: () => client.close() };
  }
  it("its row: its own pid and start token, the install it loaded (realpath), the build it loaded; no agent name needed", async () => {
    const c = await connect(path.join(REPO_ROOT, "dist", "index.js"), "plain");
    try {
      const r = c.read();
      expect(r, "exactly one row, the connector's own").toHaveLength(1);
      expect(r[0].pid).toBe(c.pid);
      expect(r[0].pid_start).toBe(processStartedAt(c.pid));
      expect(r[0].install_dir).toBe(fs.realpathSync(REPO_ROOT));
      expect(r[0].build_id).toBe(DIST_STAMP.build_id);
      expect(r[0].deps_id, "the dependencies it loaded at start").toBe(LOADED_BUILD.deps_id);
      // The parent is the detected agent WINDOW (claude/codex) or NULL, never the raw ppid (here, this test runner).
      expect(r[0].parent_pid).not.toBe(process.pid);
      if (r[0].parent_pid !== null) {
        const comm = spawnSync("ps", ["-o", "comm=", "-p", String(r[0].parent_pid)], { encoding: "utf-8" }).stdout.trim();
        expect(path.basename(comm)).toMatch(/^(claude|codex)/);
      }
    } finally {
      await c.close();
    }
  }, 60_000);
  it("even with node PRESERVING symlinks (--preserve-symlinks[-main], e.g. from NODE_OPTIONS), install_dir is the realpath", async () => {
    const link = path.join(ROOT, "linked-install-preserved");
    fs.symlinkSync(REPO_ROOT, link);
    const c = await connect(path.join(link, "dist", "index.js"), "preserved", {}, ["--preserve-symlinks", "--preserve-symlinks-main"]);
    try {
      expect(c.read()[0].install_dir).toBe(fs.realpathSync(REPO_ROOT));
    } finally {
      await c.close();
    }
  }, 60_000);
  it("the CODEX shape: launched through a SYMLINKED install path, install_dir is still the realpath", async () => {
    const link = path.join(ROOT, "linked-install");
    fs.symlinkSync(REPO_ROOT, link);
    const c = await connect(path.join(link, "dist", "index.js"), "linked");
    try {
      expect(c.read()[0].install_dir).toBe(fs.realpathSync(REPO_ROOT));
    } finally {
      await c.close();
    }
  }, 60_000);
});
