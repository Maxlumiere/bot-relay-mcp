// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0046 rule 1 — edge scope (ADR-0043) tested for what it MEANS, however the
 * SQL is written: a METAMORPHIC test.
 *
 * Run a fixed script through EVERY agent_bindings accessor (claim / refresh /
 * supersede via upsertAgentBinding, getCurrentBinding, endAgentBinding,
 * listAgentBindings) on a clean DB: the baseline. Then run the same script on a DB
 * that already holds FOREIGN-edge rows colliding with the local ones on NAME and
 * ANCHOR, both current and superseded (the hub-mode shape; the foreign-edge insert
 * trigger is lifted for the planting only, as the v2.3 signed ingress would).
 *
 * The local results must be IDENTICAL, no accessor may ever return a foreign row,
 * no foreign row may block or change a claim, and the foreign rows must come out
 * of the script untouched. This replaces "does the SQL text mention edge_id" (the
 * regex, now only a tripwire) with the property itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const ROOT = path.join(os.tmpdir(), `bot-relay-adr0046-edge-${process.pid}`);
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const Better = (await import("better-sqlite3")).default;

const FOREIGN = "00000000-0000-4000-8000-00000000f0f0";
const HOST = "h-meta";
const START = "Mon Sep 15 10:00:00 2026";
const A = { hostId: HOST, windowPid: 5001, windowPidStart: START };
const B = { hostId: HOST, windowPid: 5002, windowPidStart: START };

function freshDb(dir: string): string {
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "relay.db");
  process.env.RELAY_DB_PATH = p;
  db.getDb();
  db.closeDb();
  return p;
}

function write(h: unknown, anchor: typeof A, name: string, conv: string, supersedeReason?: string) {
  return db.upsertAgentBinding(
    h as never,
    { ...anchor, agentName: name, agentClass: null, conversationId: conv, conversationTitle: null, cwd: "/tmp/m", boundVia: "launch-intent" } as never,
    supersedeReason ? { supersedeReason } : {},
  );
}

/** Plant foreign-edge rows that collide with the script's rows on name AND anchor. */
function plantForeign(h: import("better-sqlite3").Database): void {
  h.exec("DROP TRIGGER IF EXISTS agent_bindings_local_edge_insert");
  const ins = h.prepare(
    "INSERT INTO agent_bindings (binding_id, edge_id, binding_version, agent_name, conversation_id, host_id, window_pid, " +
      "window_pid_start, bound_via, bound_at, last_verified_at, superseded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'launch-intent', ?, NULL, ?)",
  );
  for (const [anchor, name] of [[A, "arch"], [B, "build"]] as const) {
    // A CURRENT foreign row on the same anchor and name, newer than anything local.
    ins.run(`f-cur-${name}`, FOREIGN, 7, name, `c-foreign-${name}`, anchor.hostId, anchor.windowPid, anchor.windowPidStart, "2099-01-01T00:00:00Z", null);
    // A SUPERSEDED foreign row too.
    ins.run(`f-old-${name}`, FOREIGN, 6, name, `c-foreign-old-${name}`, anchor.hostId, anchor.windowPid, anchor.windowPidStart, "2098-01-01T00:00:00Z", "2098-06-01T00:00:00Z");
  }
}

const foreignRows = (h: import("better-sqlite3").Database) =>
  h.prepare("SELECT * FROM agent_bindings WHERE edge_id = ? ORDER BY binding_id").all(FOREIGN);

/**
 * Round-4 audit: foreign rows with their OWN ids never collide with the local
 * random binding_ids, so an UPDATE keyed on binding_id alone touched nothing foreign
 * and passed. Before EVERY update path, give every local binding_id a FOREIGN TWIN
 * with the same binding_id (the (edge_id, binding_id) key allows it). An update that
 * is not edge-scoped then writes the twin, and the "foreign rows untouched" check
 * catches it.
 */
function plantTwins(h: import("better-sqlite3").Database): void {
  h.exec("DROP TRIGGER IF EXISTS agent_bindings_local_edge_insert");
  h.prepare(
    "INSERT OR IGNORE INTO agent_bindings (binding_id, edge_id, binding_version, agent_name, conversation_id, host_id, " +
      "window_pid, window_pid_start, bound_via, bound_at, last_verified_at, superseded_at, end_reason) " +
      "SELECT binding_id, ?, 99, agent_name, 'c-foreign-twin', host_id, window_pid, window_pid_start, 'launch-intent', " +
      "'2000-01-01T00:00:00Z', NULL, '2000-01-02T00:00:00Z', NULL FROM agent_bindings WHERE edge_id != ?",
  ).run(FOREIGN, FOREIGN);
}

/** The script, through every accessor. Binding ids and timestamps are random/now, so results are normalised. */
function script(h: import("better-sqlite3").Database, beforeUpdate: () => void = () => {}) {
  const out: unknown[] = [];
  const norm = (r: { action: string; bindingVersion: number; supersededBindingId: string | null }) => ({
    action: r.action,
    version: r.bindingVersion,
    superseded: r.supersededBindingId !== null,
  });
  const cur = (a: typeof A) => {
    const c = db.getCurrentBinding(h as never, a);
    return c ? { name: c.agent_name, conv: c.conversation_id, version: c.binding_version } : null;
  };
  const list = () =>
    db.listAgentBindings(h as never).map((r) => {
      expect(r.edge_id, "an accessor returned a FOREIGN row").not.toBe(FOREIGN);
      return { name: r.agent_name, conv: r.conversation_id, pid: r.window_pid, version: r.binding_version, ended: r.end_reason };
    })
    // Rows bound in the same millisecond tie on bound_at and then order by a random
    // binding_id, so ROW ORDER is not stable across runs. The property is the SET.
    .sort((x, y) => x.pid - y.pid);

  out.push(["claim A", norm(write(h, A, "arch", "c1"))]);
  out.push(["claim B", norm(write(h, B, "build", "c2"))]);
  out.push(["current A", cur(A)], ["current B", cur(B)], ["list", list()]);
  beforeUpdate();
  out.push(["resume-switch A", norm(write(h, A, "arch", "c3"))]); // supersede UPDATE
  beforeUpdate();
  out.push(["end A", db.endAgentBinding(h as never, A, "logout")]); // end UPDATE
  beforeUpdate();
  out.push(["refresh A", norm(write(h, A, "arch", "c3"))]); // refresh UPDATE
  beforeUpdate();
  out.push(["clear-carry B", norm(write(h, B, "build", "c4", "clear-carry"))]); // supersede UPDATE, clear-carry
  beforeUpdate();
  out.push(["current A", cur(A)], ["current B", cur(B)], ["list", list()]);
  return out;
}

beforeEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("ADR-0046 — edge scope, metamorphic: foreign rows that collide on name AND anchor change nothing locally", () => {
  it("every accessor returns identical local results; no foreign row returned, blocking or modified", () => {
    const basePath = freshDb(path.join(ROOT, "base"));
    const base = new Better(basePath);
    const baseline = script(base);
    base.close();

    const metaPath = freshDb(path.join(ROOT, "meta"));
    const meta = new Better(metaPath);
    plantForeign(meta);
    const before = JSON.stringify(foreignRows(meta));
    expect(JSON.parse(before), "precondition: 4 colliding foreign rows planted").toHaveLength(4);
    const withForeign = script(meta);
    const after = JSON.stringify(foreignRows(meta));
    meta.close();

    expect(withForeign).toEqual(baseline);
    expect(after, "no local write touched a foreign row").toBe(before);
  });

  it("every UPDATE path (supersede, end, refresh, clear-carry) runs against a FOREIGN TWIN sharing its local binding_id, and never touches it", () => {
    const basePath = freshDb(path.join(ROOT, "base2"));
    const base = new Better(basePath);
    const baseline = script(base);
    base.close();

    const metaPath = freshDb(path.join(ROOT, "twins"));
    const meta = new Better(metaPath);
    // Each twin, as planted; a twin planted before an update must still equal this after it.
    const planted = new Map<string, string>();
    const plant = () => {
      plantTwins(meta);
      for (const row of foreignRows(meta) as Array<{ binding_id: string }>) {
        if (!planted.has(row.binding_id)) planted.set(row.binding_id, JSON.stringify(row));
      }
    };
    const withTwins = script(meta, plant);
    const shared = (meta
      .prepare("SELECT COUNT(*) AS c FROM agent_bindings f JOIN agent_bindings l ON l.binding_id = f.binding_id WHERE f.edge_id = ? AND l.edge_id != ?")
      .get(FOREIGN, FOREIGN) as { c: number }).c;
    const now = new Map((foreignRows(meta) as Array<{ binding_id: string }>).map((r) => [r.binding_id, JSON.stringify(r)]));
    meta.close();

    expect(shared, "precondition: foreign twins really share local binding_ids").toBeGreaterThanOrEqual(4);
    expect(withTwins).toEqual(baseline);
    for (const [id, row] of planted) expect(now.get(id), `foreign twin ${id} was modified`).toBe(row);
  });

  it("NON-VACUOUS: the baseline really exercises claim, supersede, end, refresh and clear-carry", () => {
    const p = freshDb(path.join(ROOT, "nv"));
    const h = new Better(p);
    const r = JSON.stringify(script(h));
    h.close();
    for (const want of ["created", "superseded-and-created", "refreshed"]) expect(r).toContain(want);
    expect(r).toContain('"end A",true');
  });
});

/**
 * Two-sided coverage pin: the metamorphic script above must exercise EVERY local
 * write statement on agent_bindings. These are the ones src/db.ts holds today (bind =
 * the create INSERT; resume-switch and clear-carry = the supersede UPDATE + INSERT;
 * refresh; end). There is NO release write on agent_bindings on this branch
 * (releaseAgentBinding writes only `agents`); when one is added (S3-lite), this pin
 * fails until the script covers it.
 */
describe("ADR-0046 — every agent_bindings write path is in the metamorphic script", () => {
  it("the write statements in src/db.ts are exactly the ones the script exercises", () => {
    // fileURLToPath, not URL.pathname: the repo path contains a space ("Claude AI").
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db.ts"), "utf-8");
    const writes = [...src.matchAll(/"(INSERT INTO agent_bindings \(|UPDATE agent_bindings SET [a-z_]+)/g)].map((m) => m[1]).sort();
    expect(writes).toEqual(
      [
        "INSERT INTO agent_bindings (", // create (bind)
        "INSERT INTO agent_bindings (", // supersede's new row (resume-switch, clear-carry)
        "UPDATE agent_bindings SET end_reason", // end
        "UPDATE agent_bindings SET last_verified_at", // refresh
        "UPDATE agent_bindings SET superseded_at", // supersede (resume-switch, clear-carry)
      ].sort(),
    );
  });
});
