// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The LIVE-RELAY RUN GUARD (tests/_setup/live-relay-guard.mjs) is proved on a STAND-IN: a real sandbox daemon
 * (dist) plays the operator's live relay. A test can never plant a stand-in at the account home or port 3777
 * (those ARE the operator's), so the env-{} grandchild here reaches the stand-in through ONE explicit port and
 * nothing else: the closest safe analogue of the fallback (ruling on Codex #305 R2 NEW-1).
 *
 *   HARM 1, the ORIGINAL accident: a grandchild sends register_agent {"name":"probe"} with no credential. The
 *          live fleet ALREADY has "probe". MEASURED on this main: the refusal is recorded as ONE auth_rejection
 *          row with NO actor (PR-B aggregates refusals), so nothing names a test: a "new names" or "nonce"
 *          guard stays green on exactly this. The guard goes RED because an actor-less row is outside the
 *          fleet (fail-closed), and classifies it POSSIBLE (it cannot honestly say more).
 *   HARM 2: a grandchild registers a name carrying this run's NONCE: RED, CERTAIN.
 *   TWIN:   nothing happens between the two reads: CLEAN, and the live dir's file set is unchanged.
 *   NOT_EVALUATED: a DB no daemon holds is never opened, and says so by name.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";
import { mintHeaders } from "./_helpers/mint.js";
import { spawnNestedRun } from "./_setup/operator-tripwire.js";
import { fixtureNamesIn, guardAfter, guardBefore, heldByDaemon, liveOffenders, snapshotLiveDb } from "./_setup/live-relay-guard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_INDEX = path.join(REPO, "dist", "index.js");
const NONCE = "twtestnonce0123";

function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health" }, (r) => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(400, () => req.destroy());
    };
    const retry = (): void => {
      if (Date.now() - start > timeoutMs) return reject(new Error("stand-in daemon not healthy in time"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function register(port: number, name: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { name, role: "worker", capabilities: [] } } }),
  });
  const text = await res.text();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const outer = JSON.parse(line ? line.slice(5).trim() : text.trim());
  const inner = outer.result?.content?.[0]?.text;
  return inner ? JSON.parse(inner) : outer;
}

/** A grandchild started PAST the tripwire (raw spawn), env {} but for PATH and the stand-in port: register `name`. */
function grandchildRegisters(port: number, name: string, secretHeader: Record<string, string> = {}): Promise<number | null> {
  const code = `fetch("http://127.0.0.1:" + process.env.STANDIN_PORT + "/mcp", { method: "POST", headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, JSON.parse(process.env.STANDIN_HEADERS)), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { name: ${JSON.stringify(name)}, role: "user", capabilities: [] } } }) }).then((r) => r.text()).finally(() => process.exit(0))`;
  return new Promise((resolve) => spawnNestedRun(process.execPath, ["-e", code], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", STANDIN_PORT: String(port), STANDIN_HEADERS: JSON.stringify(secretHeader) }, stdio: "ignore" }).on("close", resolve));
}

describe("the live-relay guard, on a stand-in live relay (a real sandbox daemon)", () => {
  let port: number;
  let root: string;
  let dbPath: string;
  let daemon: ReturnType<typeof spawn>;
  const fixtureNames = fixtureNamesIn(path.join(REPO, "tests"));

  beforeAll(async () => {
    expect(fs.existsSync(DIST_INDEX), "run `npm run build` first").toBe(true);
    port = await getFreePort();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-guard-")));
    dbPath = path.join(root, "relay.db");
    daemon = spawn(process.execPath, [DIST_INDEX], {
      env: { ...process.env, RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1", RELAY_HOME: root, RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: path.join(root, "config.json"), RELAY_AGENT_TOKEN: "", RELAY_AGENT_NAME: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHealth(port, 10_000);
    // The stand-in's "fleet": it already has "probe", like the operator's live relay did.
    for (const n of ["probe", "fleet-member"]) expect((await register(port, n, mintHeaders(dbPath))).success, n).toBe(true);
  }, 60_000);
  afterAll(async () => {
    daemon?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    try {
      daemon?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("precondition: the daemon HOLDS its DB (-wal, -shm), and the suite's fixture names include \"probe\"", () => {
    expect(heldByDaemon(dbPath)).toBe(true);
    expect(fixtureNames.has("probe")).toBe(true);
  });

  it("TWIN: nothing happens between the reads: no offender, and the live dir's file set is unchanged", () => {
    const before = snapshotLiveDb(dbPath);
    expect(liveOffenders(before, { fixtureNames, nonce: NONCE })).toEqual([]);
  });

  it("HARM 1 (the original accident): an env-{} grandchild's unauthenticated register of \"probe\", a name the fleet HAS: RED (an actor-less refusal row, POSSIBLE)", async () => {
    const before = snapshotLiveDb(dbPath);
    expect(await grandchildRegisters(port, "probe")).toBe(0);
    const off = liveOffenders(before, { fixtureNames, nonce: NONCE });
    expect(off.map((o) => [o.kind, o.class, o.detail.replace(/ source=.*$/, "")]), JSON.stringify(off)).toEqual([["audit", "POSSIBLE", "auth_rejection"]]);
    const verdict = guardAfter({ evaluated: [before], notEvaluated: [] }, { fixtureNames, nonce: NONCE });
    expect(verdict.fail).toBe(true);
  });

  it("HARM 2: a grandchild registers a name carrying the run NONCE: RED, CERTAIN (a new agent and its audit row)", async () => {
    const before = snapshotLiveDb(dbPath);
    expect(await grandchildRegisters(port, `${NONCE}-leak`, mintHeaders(dbPath))).toBe(0);
    const off = liveOffenders(before, { fixtureNames, nonce: NONCE });
    expect(off.some((o) => o.kind === "new agent" && o.id === `${NONCE}-leak` && o.class === "CERTAIN"), JSON.stringify(off)).toBe(true);
  });

  it("HARM 3 (R-a1): a file that appears in the live DB's directory between the reads is reported (the guard must never create one)", () => {
    const before = snapshotLiveDb(dbPath);
    const stray = path.join(root, "relay.db-journal");
    fs.writeFileSync(stray, "");
    try {
      const off = liveOffenders(before, { fixtureNames, nonce: NONCE });
      expect(off.map((o) => [o.kind, o.detail])).toEqual([["live dir file set changed", "added [relay.db-journal] removed []"]]);
    } finally {
      fs.rmSync(stray);
    }
  });

  it("NOT_EVALUATED: a DB no daemon holds is never opened (nothing created beside it), and the verdict says so by name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-guard-cold-"));
    try {
      fs.copyFileSync(dbPath, path.join(dir, "relay.db")); // a DB file, but no -wal/-shm: no daemon holds it
      const list = fs.readdirSync(dir).sort();
      const state = guardBefore([dir]);
      expect(state.evaluated).toEqual([]);
      expect(state.notEvaluated.map((n) => n.why)).toEqual([expect.stringMatching(/no daemon holds it/)]);
      const verdict = guardAfter(state, { fixtureNames, nonce: NONCE });
      expect(verdict.fail).toBe(false);
      expect(verdict.lines.join("\n")).toMatch(/live-relay guard: NOT_EVALUATED/);
      expect(fs.readdirSync(dir).sort()).toEqual(list);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
