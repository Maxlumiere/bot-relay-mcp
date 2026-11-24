// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8a (gate brief §5; ruling e0217654 and the M7 result): WHO MAY WAKE WHOM, default-deny,
 * as data. One closed-schema file in the instance directory, `doorbell-policy.json` (0600, owned by the running
 * user, a regular file read with no-follow). A missing, unreadable or malformed file means NO wakes, and loud:
 * `--arm-check` refuses with `no-mail: wake policy unreadable (<why>)`, `relay doorbell status` shows
 * `policy_invalid`, and held mail is counted with its reason. It never falls back to allowing everyone: the
 * allow-all check exists only in tests. The STREAMING `relay watch --json` (the fleet's stopgap) takes no policy
 * and keeps waking without one.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { openWindow, within, type TestWindow } from "./helpers/watch-window.js";
import { startToken } from "./helpers/start-token.js";
import { systemBinarySeamPath } from "./_helpers/system-binary-seam-env.js";
import { ALLOW_ALL_POLICY } from "./_helpers/allow-all-policy.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr8a-")));
const INST = path.join(ROOT, "inst");
const DB = path.join(INST, "relay.db");
const POLICY = path.join(INST, "doorbell-policy.json");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const P = await import("../src/wake-policy.js");
const W = await import("../src/watch-wake.js");
const db = await import("../src/db.js");
const { getOwnHostId } = await import("../src/liveness.js");
const OWN = getOwnHostId();

const windows: TestWindow[] = [];
afterAll(async () => {
  await Promise.allSettled(windows.map((w) => w.close()));
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const GOOD = { version: 1, optIn: ["p-bob"], wake: [{ from: "p-alice", to: "p-bob" }], pairWakesPerHour: 4 };
function writePolicy(body: unknown, mode = 0o600): void {
  fs.mkdirSync(INST, { recursive: true });
  fs.rmSync(POLICY, { force: true, recursive: true });
  fs.writeFileSync(POLICY, typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body), { mode });
  fs.chmodSync(POLICY, mode);
}
const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0", NODE_OPTIONS: `--require ${systemBinarySeamPath()}` });
const relay = (args: string[]) => spawnSync("node", [RELAY_BIN, ...args], { env: env(), encoding: "utf-8", timeout: 30_000 });
const read = (rs: string | null, ids: string[], from: Record<string, string | null>) => ({
  registered: true,
  reading_session: rs,
  ids,
  meta: new Map(ids.map((id) => [id, { from: from[id] ?? null, lane: "direct" as const }])),
});

function resetDb(): void {
  db.closeDb();
  fs.rmSync(INST, { recursive: true, force: true });
  fs.mkdirSync(INST, { recursive: true });
  db.getDb();
  for (const a of ["p-alice", "p-bob", "p-carol"]) db.registerAgent(a, "r", []);
}

describe("the policy file: closed schema, no-follow, 0600, owned by this user; every fault is content-free", () => {
  beforeEach(() => resetDb());
  const why = () => {
    const r = P.readWakePolicy(INST);
    return r.ok ? "OK" : r.why;
  };
  it("a valid file reads, with its fields", () => {
    writePolicy(GOOD);
    const r = P.readWakePolicy(INST);
    expect(r).toEqual({ ok: true, file: GOOD });
  });
  it("missing / a LINK (its target untouched) / a directory / mode 0644 → each refused by role", () => {
    fs.rmSync(POLICY, { force: true });
    expect(why()).toBe("missing");
    const target = path.join(ROOT, "elsewhere.json");
    fs.writeFileSync(target, JSON.stringify(GOOD), { mode: 0o600 });
    fs.symlinkSync(target, POLICY);
    expect(why()).toBe("a link");
    expect(fs.readFileSync(target, "utf-8")).toBe(JSON.stringify(GOOD));
    fs.rmSync(POLICY);
    fs.mkdirSync(POLICY);
    expect(why()).toBe("not a regular file");
    fs.rmSync(POLICY, { recursive: true });
    writePolicy(GOOD, 0o644);
    expect(why()).toBe("mode too open (must be 0600)");
  });
  it.skipIf(process.platform === "win32")("owned by ANOTHER user → refused (the owner check, via the expected-uid seam)", () => {
    writePolicy(GOOD);
    const r = P.readWakePolicy(INST, { expectedUid: (process.getuid?.() ?? 0) + 1 });
    expect(r).toEqual({ ok: false, why: "not owned by this user" });
  });
  it("too large / not UTF-8 / not JSON / not an object", () => {
    writePolicy("x".repeat(P.POLICY_MAX_BYTES + 1));
    expect(why()).toBe("too large");
    writePolicy(Buffer.from([0x7b, 0xff, 0x7d]));
    expect(why()).toBe("not UTF-8");
    writePolicy("{");
    expect(why()).toBe("not JSON");
    writePolicy("[]");
    expect(why()).toBe("schema: not an object");
  });
  it("schema: an extra field, a missing field, another version, a bad name, an extra wake key, a wildcard recipient, a recipient not opted in, an out-of-range rate", () => {
    const cases: Array<[unknown, string]> = [
      [{ ...GOOD, extra: 1 }, "schema: unexpected field"],
      [{ version: 1, optIn: ["p-bob"], wake: [] }, "schema: missing pairWakesPerHour"],
      [{ ...GOOD, version: 2 }, "schema: version must be 1"],
      [{ ...GOOD, optIn: ["bad name!"] }, "schema: optIn[0] is not an agent name"],
      [{ ...GOOD, optIn: "p-bob" }, "schema: optIn is not a list"],
      [{ ...GOOD, wake: [{ from: "p-alice", to: "p-bob", extra: true }] }, "schema: wake[0] must have exactly from and to"],
      [{ ...GOOD, wake: [{ from: "p-alice", to: "*" }] }, "schema: wake[0].to is not an agent name"],
      [{ ...GOOD, wake: [{ from: "bad name!", to: "p-bob" }] }, "schema: wake[0].from is not an agent name or *"],
      [{ ...GOOD, wake: [{ from: "p-alice", to: "p-carol" }] }, "schema: wake[0].to is not opted in"],
      [{ ...GOOD, pairWakesPerHour: 0 }, "schema: pairWakesPerHour must be an integer from 1 to 60"],
      [{ ...GOOD, pairWakesPerHour: 61 }, "schema: pairWakesPerHour must be an integer from 1 to 60"],
      [{ ...GOOD, pairWakesPerHour: 1.5 }, "schema: pairWakesPerHour must be an integer from 1 to 60"],
    ];
    for (const [body, want] of cases) {
      writePolicy(body);
      expect(why(), JSON.stringify(body)).toBe(want);
    }
  });
  it("a fault never echoes the file's content (a planted value is not in the reason)", () => {
    writePolicy({ ...GOOD, optIn: ["zz planted value"] });
    expect(why()).not.toContain("planted");
  });
});

describe("standing: default-deny; exact pairs; the ONE wildcard only for a registered sender", () => {
  const reg = new Set(["p-alice", "p-bob", "p-carol"]);
  const s = (f: object) => P.policyStanding({ ...GOOD, ...f } as typeof GOOD, (n) => reg.has(n));
  it("a listed pair wakes; an UNLISTED sender does not (no_standing)", () => {
    expect(s({})({ sender: "p-alice", recipient: "p-bob", kind: "direct", id: "m" })).toBe("allowed");
    expect(s({})({ sender: "p-carol", recipient: "p-bob", kind: "direct", id: "m" })).toEqual({ refused: "no_standing" });
  });
  it("a recipient that is not opted in never wakes (not_opted_in), even from a listed sender", () => {
    expect(s({ optIn: ["p-bob"] })({ sender: "p-alice", recipient: "p-carol", kind: "direct", id: "m" })).toEqual({ refused: "not_opted_in" });
  });
  it("the wildcard matches a REGISTERED sender, never a null one, never an unregistered one", () => {
    const w = s({ wake: [{ from: "*", to: "p-bob" }] });
    expect(w({ sender: "p-carol", recipient: "p-bob", kind: "direct", id: "m" })).toBe("allowed");
    expect(w({ sender: null, recipient: "p-bob", kind: "direct", id: "m" })).toEqual({ refused: "no_standing" });
    expect(w({ sender: "p-ghost", recipient: "p-bob", kind: "direct", id: "m" })).toEqual({ refused: "no_standing" });
  });
  it("an exact pair needs no registry lookup (the sender name is relay-authenticated); a null sender never matches it", () => {
    const st = P.policyStanding(GOOD, () => {
      throw new Error("no lookup for an exact pair");
    });
    expect(st({ sender: "p-alice", recipient: "p-bob", kind: "direct", id: "m" })).toBe("allowed");
  });
});

describe("currentWakePolicy: an invalid or missing file → NO wakes (never allow-all)", () => {
  beforeEach(() => resetDb());
  it("missing → every id refused policy_invalid; nothing wakes", () => {
    fs.rmSync(POLICY, { force: true });
    const pol = P.currentWakePolicy(DB, () => true);
    expect(pol.read).toEqual({ ok: false, why: "missing" });
    const d = W.decideWake(read("rs", ["m1", "m2"], { m1: "p-alice", m2: "p-carol" }), "p-bob", null, 0, pol);
    expect(d.wake).toEqual([]);
    expect(d.refused).toEqual({ policy_invalid: 2 });
  });
  it("valid → the listed sender wakes, the rate comes from the file", () => {
    writePolicy({ ...GOOD, pairWakesPerHour: 7 });
    const pol = P.currentWakePolicy(DB, () => true);
    expect(pol.pairWakesPerHour).toBe(7);
    expect(W.decideWake(read("rs", ["m1", "m2"], { m1: "p-alice", m2: "p-carol" }), "p-bob", null, 0, pol)).toMatchObject({ wake: ["m1"], refused: { no_standing: 1 } });
  });
  it("the pure trigger still works with an explicit allow-all (tests only)", () => {
    expect(W.decideWake(read("rs", ["m1"], { m1: null }), "p-bob", null, 0, ALLOW_ALL_POLICY).wake).toEqual(["m1"]);
  });
  it("TRIPWIRE: src/ holds no allow-all policy (no ALLOW_ALL, no `() => \"allowed\"` standing)", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name)) {
          const t = fs.readFileSync(p, "utf-8");
          if (/\bALLOW_ALL\b/.test(t) || /StandingCheck\s*=\s*\(\)\s*=>\s*"allowed"/.test(t)) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, "src"));
    expect(hits).toEqual([]);
  });
});

describe("the CLI: --arm-check reads the policy first (loud); doorbell status and policy --check show it", () => {
  beforeEach(() => resetDb());
  it("NO policy file → `no-mail: wake policy unreadable (missing)`, exit 2", () => {
    fs.rmSync(POLICY, { force: true });
    const r = relay(["watch", "p-bob", "--arm-check"]);
    expect([r.status, r.stdout.trim()]).toEqual([2, "no-mail: wake policy unreadable (missing). Do not start a watch for p-bob."]);
  });
  it("a MALFORMED policy (an extra field) → `no-mail: wake policy unreadable (schema: unexpected field)`, exit 2", () => {
    writePolicy({ ...GOOD, extra: 1 });
    const r = relay(["watch", "p-bob", "--arm-check"]);
    expect([r.status, r.stdout.trim()]).toEqual([2, "no-mail: wake policy unreadable (schema: unexpected field). Do not start a watch for p-bob."]);
  });
  it("a valid policy, the agent NOT opted in → `no-mail: refused (not_opted_in)`, exit 2", () => {
    writePolicy(GOOD);
    const r = relay(["watch", "p-carol", "--arm-check"]);
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toMatch(/^no-mail: refused \(not_opted_in\): /);
  });
  it("a valid policy, the agent opted in → it passes the policy and reaches the ownership check (no window here: no_bound_ancestor)", () => {
    writePolicy(GOOD);
    const r = relay(["watch", "p-bob", "--arm-check"]);
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toMatch(/^no-mail: refused \(no_bound_ancestor\)/);
  });
  it("`relay doorbell policy --check`: valid → exit 0 with the counts; missing → exit 1 policy_invalid (missing); it writes nothing", () => {
    writePolicy(GOOD);
    const ok = relay(["doorbell", "policy", "--check"]);
    expect([ok.status, ok.stdout.trim()]).toEqual([0, "[RELAY] doorbell policy: valid (1 agent(s) opted in, 1 wake pair(s), 4 wake(s) per pair per hour)"]);
    fs.rmSync(POLICY);
    const before = fs.readdirSync(INST).sort();
    const bad = relay(["doorbell", "policy", "--check"]);
    expect([bad.status, bad.stdout.trim()]).toEqual([1, "[RELAY] doorbell policy: policy_invalid (missing): no agent can be woken"]);
    expect(fs.readdirSync(INST).sort()).toEqual(before);
  });
  it("`relay doorbell status`: policy state + why in JSON and text; held mail for an opted-in agent, with its reason, count and oldest age", () => {
    writePolicy(GOOD);
    db.sendMessage("p-carol", "p-bob", "x", "normal"); // carol has no standing → held
    db.sendMessage("p-alice", "p-bob", "x", "normal"); // alice HAS standing → pending, but never counted as held
    db.sendMessage("p-alice", "p-carol", "x", "normal"); // carol is not opted in → never counted (noise)
    const j = JSON.parse(relay(["doorbell", "status", "--json"]).stdout) as { policy: unknown; held: Record<string, { reason: string; count: number; oldest_age_seconds: number }> };
    expect(j.policy).toEqual({ state: "valid" });
    expect(Object.keys(j.held)).toEqual(["p-bob"]);
    expect(j.held["p-bob"]).toMatchObject({ reason: "no_standing", count: 1 });
    expect(j.held["p-bob"]!.oldest_age_seconds).toBeGreaterThanOrEqual(0);
    fs.rmSync(POLICY);
    const j2 = JSON.parse(relay(["doorbell", "status", "--json"]).stdout) as { policy: unknown };
    expect(j2.policy).toEqual({ state: "policy_invalid", why: "missing" });
    expect(relay(["doorbell", "status"]).stdout).toContain("policy_invalid (missing)");
  });
});

describe("ADD 1 (CRITICAL): the STREAMING `relay watch --json` takes NO policy: it wakes without a file and with an invalid one", () => {
  beforeEach(() => resetDb());
  async function streamingWakes(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const w = spawn(process.execPath, [RELAY_BIN, "watch", "p-bob", "--json", "--interval", "1"], { env: { ...env(), RELAY_HTTP_PORT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let sent = false;
      w.stdout.on("data", (d) => {
        out += d;
        if (out.includes('"event":"wake"')) {
          w.kill("SIGTERM");
          resolve(true);
        }
      });
      const send = setTimeout(() => {
        sent = true;
        db.sendMessage("p-carol", "p-bob", "x", "normal");
      }, 1500);
      const guard = setTimeout(() => {
        w.kill("SIGKILL");
        resolve(false);
      }, 15_000);
      w.on("exit", () => {
        clearTimeout(send);
        clearTimeout(guard);
        if (!sent) resolve(false);
      });
    });
  }
  it("no policy file → the streaming watch still emits its wake line on new mail", async () => {
    fs.rmSync(POLICY, { force: true });
    expect(await streamingWakes()).toBe(true);
  }, 30_000);
  it("an INVALID policy file → the streaming watch still emits its wake line on new mail", async () => {
    writePolicy("{");
    expect(await streamingWakes()).toBe(true);
  }, 30_000);
});

describe.skipIf(!OWN)("the --until-wake watch honours the policy (real windows)", () => {
  let win: TestWindow;
  beforeEach(async () => {
    await Promise.allSettled(windows.splice(0).map((w) => w.close()));
    resetDb();
    win = openWindow(path.join(ROOT, `win-${Date.now()}`), env());
    windows.push(win);
    db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: win.pid, windowPidStart: startToken(win.pid), agentName: "p-bob", agentClass: null, conversationId: `conv-${win.pid}`, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
  });
  const WATCH = ["p-bob", "--until-wake", "--interval", "1", "--dormant-check-s", "1"];
  const lockStatus = () => relay(["watch", "p-bob", "--lock-status"]).stdout.trim();
  async function untilLive(): Promise<void> {
    for (let i = 0; i < 100 && lockStatus() !== "live"; i++) await new Promise((r) => setTimeout(r, 150));
    expect(lockStatus()).toBe("live");
  }
  it("an UNLISTED sender's mail does not wake; a LISTED sender's mail wakes once", async () => {
    writePolicy(GOOD);
    const r = win.runRelayWatch(WATCH);
    await untilLive();
    db.sendMessage("p-carol", "p-bob", "x", "normal");
    expect(await within(r.exited, 3_000)).toBe("timeout");
    db.sendMessage("p-alice", "p-bob", "x", "normal");
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim()).toMatch(/^relay mail pending for p-bob: 1 new message\(s\)/);
  }, 40_000);
  it("the policy DELETED while the watch is live → a listed sender's new mail does NOT wake; doorbell status shows it held as policy_invalid", async () => {
    writePolicy(GOOD);
    const r = win.runRelayWatch(WATCH);
    await untilLive();
    fs.rmSync(POLICY);
    db.sendMessage("p-alice", "p-bob", "x", "normal");
    expect(await within(r.exited, 4_000)).toBe("timeout");
    const j = JSON.parse(relay(["doorbell", "status", "--json"]).stdout) as { held: Record<string, { reason: string; count: number }> };
    expect(j.held["p-bob"]).toMatchObject({ reason: "policy_invalid", count: 1 });
  }, 40_000);
});

describe("the SessionStart lines (policyLines): QUIET before the rollout, LOUD after", () => {
  const st = (policy: object, held: object) => ({ policy, held }) as unknown as import("../src/cli/doorbell.js").DoorbellStatus;
  it("no file and no live watch (every relay before the rollout) → silent", async () => {
    const S = await import("../src/cli/doorbell.js");
    expect(S.policyLines(st({ state: "policy_invalid", why: "missing" }, {}))).toEqual([]);
  });
  it("a file that EXISTS but is invalid → one line, even with no watch", async () => {
    const S = await import("../src/cli/doorbell.js");
    expect(S.policyLines(st({ state: "policy_invalid", why: "schema: unexpected field" }, {}))).toEqual(["[RELAY] doorbell policy: policy_invalid (schema: unexpected field): no agent can be woken"]);
  });
  it("missing BUT a live watch cannot wake → one line naming it, with its count and oldest age", async () => {
    const S = await import("../src/cli/doorbell.js");
    expect(S.policyLines(st({ state: "policy_invalid", why: "missing" }, { "p-bob": { reason: "policy_invalid", count: 2, oldest_age_seconds: 90 } }))).toEqual([
      "[RELAY] doorbell policy: policy_invalid (missing): no agent can be woken; live watches that cannot wake: p-bob (2 pending, oldest 90s)",
    ]);
  });
  it("held mail with no standing (valid policy) → one line", async () => {
    const S = await import("../src/cli/doorbell.js");
    expect(S.policyLines(st({ state: "valid" }, { "p-bob": { reason: "no_standing", count: 1, oldest_age_seconds: 30 } }))).toEqual(["[RELAY] doorbell policy: mail held (no standing to wake): p-bob 1, oldest 30s"]);
  });
});

describe("Codex #447 R1: the policy is bound to the OPEN relay's instance; read to EOF; no duplicate key; held never loses an agent", () => {
  beforeEach(() => resetDb());
  it("P1: a LINKED instance dir retargeted to another instance (with a permissive policy) → refused for the DB that was opened; the right identity reads", () => {
    const A = path.join(ROOT, "inst-A");
    const B = path.join(ROOT, "inst-B");
    for (const d of [A, B]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "relay.db"), d);
    }
    fs.writeFileSync(path.join(B, "doorbell-policy.json"), JSON.stringify({ ...GOOD, wake: [{ from: "*", to: "p-bob" }] }), { mode: 0o600 });
    fs.chmodSync(path.join(B, "doorbell-policy.json"), 0o600);
    const link = path.join(ROOT, "inst-link");
    try {
      fs.unlinkSync(link); // the link itself, never its target
    } catch {
      /* absent */
    }
    fs.symlinkSync(A, link);
    const opened = P.dbIdentity(path.join(link, "relay.db")); // the watch opened A
    fs.unlinkSync(link);
    fs.symlinkSync(B, link); // retargeted under the live watch
    expect(P.readWakePolicy(link, { bound: { dbPath: path.join(link, "relay.db"), identity: opened } })).toEqual({ ok: false, why: "not the open relay's instance" });
    expect(P.currentWakePolicy(path.join(link, "relay.db"), () => true, opened).read).toEqual({ ok: false, why: "not the open relay's instance" });
    expect(P.readWakePolicy(link, { bound: { dbPath: path.join(link, "relay.db"), identity: P.dbIdentity(path.join(B, "relay.db")) } }).ok).toBe(true); // the control
    expect(P.readWakePolicy(link, { bound: { dbPath: path.join(link, "relay.db"), identity: null } })).toEqual({ ok: false, why: "not the open relay's instance" }); // unknown identity: fail closed
  });
  it("P2: a file that GROWS between the stat and the read (garbage appended after a valid prefix) → refused, never its prefix", () => {
    writePolicy(GOOD);
    const r = P.readWakePolicy(INST, { afterStat: () => fs.appendFileSync(POLICY, "garbage") });
    expect(r).toEqual({ ok: false, why: "changed while being read" });
  });
  it("P2: DUPLICATE keys (an empty wake, then a permissive one) → refused; nested too", () => {
    writePolicy('{"version":1,"optIn":["p-bob"],"wake":[],"wake":[{"from":"*","to":"p-bob"}],"pairWakesPerHour":4}');
    expect(P.readWakePolicy(INST)).toEqual({ ok: false, why: "schema: a duplicate key" });
    writePolicy('{"version":1,"optIn":["p-bob"],"wake":[{"from":"p-carol","from":"p-alice","to":"p-bob"}],"pairWakesPerHour":4}');
    expect(P.readWakePolicy(INST)).toEqual({ ok: false, why: "schema: a duplicate key" });
    expect(P.hasDuplicateKey('{"a":"x\\"y","b":{"a":1},"c":[{"a":1},{"a":2}]}')).toBe(false); // the control: escapes, nesting, arrays
  });
  it("STATED: 4.0 is the number 4 (JSON has no integer type): accepted as 4", () => {
    writePolicy('{"version":1,"optIn":["p-bob"],"wake":[],"pairWakesPerHour":4.0}');
    expect(P.readWakePolicy(INST)).toMatchObject({ ok: true, file: { pairWakesPerHour: 4 } });
  });
  it("P2: an agent named __proto__ keeps its held mail in doorbell status (a null-prototype record)", () => {
    db.registerAgent("__proto__", "r", []);
    writePolicy({ ...GOOD, optIn: ["p-bob", "__proto__"] });
    db.sendMessage("p-carol", "__proto__", "x", "normal");
    const j = JSON.parse(relay(["doorbell", "status", "--json"]).stdout) as { held: Record<string, { reason: string; count: number }> };
    expect(Object.prototype.hasOwnProperty.call(j.held, "__proto__")).toBe(true);
    expect(j.held["__proto__"]).toMatchObject({ reason: "no_standing", count: 1 });
  });
});

describe("the mutation fixture (tests/fixtures/doorbell-pr8a-mutants.json; run: node scripts/mutation-sweep.mjs <fixture>)", () => {
  it("every mutant still applies: its find text occurs exactly once in its file; names are unique", () => {
    const M = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "doorbell-pr8a-mutants.json"), "utf-8")) as Array<{ name: string; file: string; find: string }>;
    expect(M.length).toBeGreaterThanOrEqual(19);
    for (const m of M) expect(fs.readFileSync(path.join(REPO, m.file), "utf-8").split(m.find).length - 1, m.name).toBe(1);
    expect(new Set(M.map((m) => m.name)).size).toBe(M.length);
  });
});

