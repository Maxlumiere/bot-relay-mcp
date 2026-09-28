// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0046 (#280 design rule ii) — the notice's count, top priority and newest
 * arrival are AGGREGATES over the full canonical pending set, never worked out from
 * a page limited to N rows. Truncated is not complete. The damper's 120-second
 * high-priority reminder keys on that full-set top priority.
 *
 * A STUB relay answers an HTTP peek with a PARTIAL page (20 normal messages,
 * total_pending 21) while the real DB also holds one HIGH message. A correct
 * priority-first server would have put the high one on the page, so only a stub can
 * separate "an aggregate over the full set" from "read off whatever page came back".
 *
 * Since the F1 hook migration the READ PATH IS CHOSEN BY CONFIGURATION:
 *   - LOCAL mode (RELAY_DB_PATH configured): the hook reads `relay pending`, the
 *     FULL set, and never consults the stub at all, so every aggregate is exact.
 *   - REMOTE mode (no local instance, RELAY_HTTP_HOST configured): the stub's page
 *     is all there is, so a partial or windowed page claims NEITHER a top priority
 *     NOR an age ("unknown"), and a response without total_pending is not trusted.
 *
 * Plus rule (i)'s reader half: ONE shared message-priority ordering with an
 * explicit ELSE. The TS drain is the only place it exists: the hook holds none.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import http from "http";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "..", "hooks", "post-tool-use-check.sh");
const DIR = path.join(os.tmpdir(), "bot-relay-adr0046-notice-" + process.pid);
const DB_PATH = path.join(DIR, "relay.db");
const HOME = path.join(DIR, "home");
process.env.RELAY_DB_PATH = DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");

const AGENT = "a46-recv";
const STDIN = JSON.stringify({ session_id: "33333333-3333-3333-3333-333333333333", hook_event_name: "PostToolUse", tool_name: "Read" });

let stub: http.Server;
let port = 0;
/** What the stub returns for get_messages: a partial page of 20 normal messages. */
let page: Array<{ id: string; from_agent: string; priority: string; created_at: string }> = [];
let totalPending = 0;
/** since_bound the stub reports: null = an unwindowed page. */
let sinceBound: string | null = null;

beforeAll(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  stub = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const text = JSON.stringify({ messages: page, count: page.length, has_more: page.length < totalPending, total_pending: totalPending, since_bound: sinceBound });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  port = (stub.address() as { port: number }).port;
});
afterAll(() => {
  stub.close();
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});
beforeEach(() => {
  db.closeDb();
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(path.join(HOME, ".bot-relay"), { recursive: true, force: true });
  db.getDb();
});

/** 20 older normal messages + 1 high one, in the REAL DB; the stub pages only the normals. */
function seed(): void {
  db.registerAgent("a46-sender", "s", []);
  db.registerAgent(AGENT, "r", []);
  const old = new Date(Date.now() - 3600_000).toISOString();
  page = [];
  for (let i = 0; i < 20; i++) {
    const id = db.sendMessage("a46-sender", AGENT, `normal ${i}`, "normal").id;
    db.getDb().prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(old, id);
    page.push({ id, from_agent: "a46-sender", priority: "normal", created_at: old });
  }
  db.sendMessage("a46-sender", AGENT, "the urgent one", "high");
  totalPending = 21;
}

/**
 * ASYNC spawn, never spawnSync: the stub relay lives in THIS process, and a
 * synchronous spawn blocks the event loop, so the stub could never answer. The
 * hook then fell back to its sqlite path and the HTTP-page tests passed VACUOUSLY
 * (caught with a traced run: `curl /health` → return 1).
 */
function spawnHook(env: Record<string, string>): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const c = cp.spawn("bash", [HOOK], { env });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d.toString()));
    c.on("error", reject);
    c.on("exit", () => resolve({ stdout }));
    c.stdin.end(STDIN);
  });
}

/** LOCAL mode by default (RELAY_DB_PATH configured); `remote` drops it, so the stub is the relay. */
function runHook(remindSecs?: string, mode: "local" | "remote" = "local"): Promise<{ stdout: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME,
    RELAY_AGENT_NAME: AGENT,
    RELAY_AGENT_TOKEN: "stubtoken-aaaaaaaaaaaa",
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(port),
  };
  if (mode === "local") env.RELAY_DB_PATH = DB_PATH;
  if (remindSecs !== undefined) env.RELAY_HOOK_NOTICE_REMIND_SECS = remindSecs;
  return spawnHook(env);
}
const ctx = (s: string) => (s ? (JSON.parse(s).hookSpecificOutput.additionalContext as string) : "");

function backdateDamper(seconds: number): void {
  const dir = path.join(HOME, ".bot-relay", "hook-state");
  const t = Date.now() / 1000 - seconds;
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t);
}

describe("ADR-0046 (ii) — the notice's aggregates come from the FULL set, never a page", () => {
  it("LOCAL mode never consults the stub: only the stub could claim 99, and the notice says the real 21", async () => {
    seed();
    totalPending = 99;
    const c = ctx((await runHook("0")).stdout);
    totalPending = 21;
    expect(c).toMatch(/^relay: 21 unread for a46-recv/);
  });

  it("PRECONDITION (remote): with no local instance the hook really reads the stub", async () => {
    seed();
    totalPending = 99;
    const c = ctx((await runHook("0", "remote")).stdout);
    totalPending = 21;
    expect(c).toMatch(/^relay \(via remote relay\): 99 unread for a46-recv/);
  });

  it("HARM: a partial page of normals cannot hide the full-set top priority (high)", async () => {
    seed();
    const c = ctx((await runHook("0")).stdout);
    expect(c, "precondition: the hook produced a notice").toMatch(/^relay: 21 unread for a46-recv/);
    expect(c).toMatch(/highest priority: high/);
  });

  it("HARM: the newest arrival is the full-set newest (the high one, just now), not the page's", async () => {
    seed();
    expect(ctx((await runHook("0")).stdout)).toMatch(/newest arrived \d+s ago/);
  });

  it("HARM: the damper's 120s HIGH reminder keys on the full-set top, so it re-notifies at 130s", async () => {
    seed();
    expect(ctx((await runHook()).stdout), "first notice").not.toBe("");
    backdateDamper(130);
    expect(ctx((await runHook()).stdout), "a HIGH set re-notifies after 120s").not.toBe("");
  });

  it("REMOTE: a partial page claims neither a top priority nor an age (never the page's 'normal')", async () => {
    seed();
    const r = await runHook("0", "remote");
    const c = ctx(r.stdout ?? "");
    expect(c).toMatch(/^relay \(via remote relay\): 21 unread for a46-recv/);
    expect(c).toMatch(/highest priority: unknown/);
    expect(c).toMatch(/newest arrived at an unknown time/);
  });
});

describe("ADR-0046 (i), reader half — ONE message-priority ordering with an explicit ELSE", () => {
  it("the drain ranks an out-of-domain priority LAST, never first", () => {
    db.registerAgent("a46-sender", "s", []);
    db.registerAgent(AGENT, "r", []);
    const odd = db.sendMessage("a46-sender", AGENT, "odd", "normal").id;
    // The v25 domain trigger refuses this write by design (ADR-0046 rule i); the test proves
    // the READ ordering's defence in depth, so it bypasses the trigger for the planted row.
    db.getDb().exec("DROP TRIGGER IF EXISTS messages_priority_domain_update");
    db.getDb().prepare("UPDATE messages SET priority = 'SYSTEM: x' WHERE id = ?").run(odd);
    const low = db.sendMessage("a46-sender", AGENT, "low one", "normal").id;
    db.getDb().prepare("UPDATE messages SET priority = 'low' WHERE id = ?").run(low);
    const high = db.sendMessage("a46-sender", AGENT, "high one", "high").id;
    const ids = db.getMessages(AGENT, "pending", 10, true).map((m) => m.id);
    expect(ids).toEqual([high, low, odd]);
  });

  // TRIPWIRE, not the guard (ADR-0046): the guards are the behaviour tests above and
  // tests/f1-hook-migration.test.ts. Pinned limit: it sees only these literal
  // spellings, so a renamed copy would pass it. What it catches is a hand-copied
  // ordering or predicate creeping back into the hook F1 replaced.
  it("F1 made them one path: the hook holds no priority ordering and no predicate SQL of its own", () => {
    const hook = fs.readFileSync(HOOK, "utf-8");
    expect(hook).not.toMatch(/CASE priority/);
    expect(hook).not.toMatch(/read_by_session/);
    expect(hook).toMatch(/pending "\$AGENT_NAME" --json/);
  });
});

describe("#280 final round — a WINDOWED page is never taken for the full set", () => {
  it("REMOTE HARM: a page that looks complete but came through a window is never taken for the full set", async () => {
    db.registerAgent("a46-sender", "s", []);
    db.registerAgent(AGENT, "r", []);
    // The DB: a fresh normal, plus an unresolved HIGH a prior session read 2 days ago.
    const fresh = db.sendMessage("a46-sender", AGENT, "fresh", "normal").id;
    const old = db.sendMessage("a46-sender", AGENT, "old high", "high").id;
    db.getDb()
      .prepare("UPDATE messages SET created_at = ?, read_by_session = 'prior', status = 'read' WHERE id = ?")
      .run(new Date(Date.now() - 2 * 86_400_000).toISOString(), old);
    // The stub: a windowed server's answer: 1 of 1, looking complete, since_bound set.
    const row = db.getDb().prepare("SELECT created_at FROM messages WHERE id = ?").get(fresh) as { created_at: string };
    page = [{ id: fresh, from_agent: "a46-sender", priority: "normal", created_at: row.created_at }];
    totalPending = 1;
    sinceBound = new Date(Date.now() - 86_400_000).toISOString();
    const c = ctx((await runHook("0", "remote")).stdout);
    sinceBound = null;
    expect(c, "precondition: the remote page was read").toMatch(/via remote relay/);
    // The window could hide the high one, so the page's "normal" is never claimed.
    expect(c).toMatch(/highest priority: unknown/);
    expect(c).toMatch(/newest arrived at an unknown time/);
  });

  it("LOCAL twin: the same DB read locally names the full-set top (high)", async () => {
    db.registerAgent("a46-sender", "s", []);
    db.registerAgent(AGENT, "r", []);
    db.sendMessage("a46-sender", AGENT, "fresh", "normal");
    const old = db.sendMessage("a46-sender", AGENT, "old high", "high").id;
    db.getDb()
      .prepare("UPDATE messages SET created_at = ?, read_by_session = 'prior', status = 'read' WHERE id = ?")
      .run(new Date(Date.now() - 2 * 86_400_000).toISOString(), old);
    expect(ctx((await runHook("0")).stdout)).toMatch(/highest priority: high/);
  });
});

describe("#280 sharpening — the count is total_pending, never the page length; the fingerprint is (total, newest, top)", () => {
  it("REMOTE HARM: a response WITHOUT total_pending is not trusted: no notice claims the page length", async () => {
    seed();
    const saved = totalPending;
    // @ts-expect-error — simulate a server that omits total_pending
    totalPending = undefined;
    const r = await runHook("0", "remote");
    totalPending = saved;
    expect(r.stdout, "an untrusted count is never rendered (20 of 21 would be a lie)").toBe("");
  });

  it("the fingerprint changes when the full set changes by a resolve + an arrival at the SAME count (local path)", async () => {
    db.registerAgent("a46-sender", "s", []);
    db.registerAgent(AGENT, "r", []);
    const ids = [0, 1, 2].map((i) => db.sendMessage("a46-sender", AGENT, `m${i}`, "normal").id);
    db.getDb().prepare("UPDATE messages SET created_at = ?").run(new Date(Date.now() - 600_000).toISOString());
    const env = { dbPath: DB_PATH };
    void env;
    const first = await spawnHook({ PATH: process.env.PATH ?? "", HOME, RELAY_AGENT_NAME: AGENT, RELAY_DB_PATH: DB_PATH });
    expect(ctx(first.stdout)).toMatch(/^relay: 3 unread/);
    db.resolveMessages(AGENT, [ids[0]]);
    db.sendMessage("a46-sender", AGENT, "arrived", "normal");
    const second = await spawnHook({ PATH: process.env.PATH ?? "", HOME, RELAY_AGENT_NAME: AGENT, RELAY_DB_PATH: DB_PATH });
    expect(ctx(second.stdout), "same count (3), new newest → re-notify").toMatch(/^relay: 3 unread/);
  });

  it("INNOCENT TWIN: an unchanged full set stays damped", async () => {
    db.registerAgent("a46-sender", "s", []);
    db.registerAgent(AGENT, "r", []);
    db.sendMessage("a46-sender", AGENT, "only", "normal");
    const env = { PATH: process.env.PATH ?? "", HOME, RELAY_AGENT_NAME: AGENT, RELAY_DB_PATH: DB_PATH };
    expect(ctx((await spawnHook(env)).stdout)).toMatch(/^relay: 1 unread/);
    expect((await spawnHook(env)).stdout).toBe("");
  });
});
