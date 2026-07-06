// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.15.0 — presence rebuild: the `unknown` state + report_liveness self-heal.
 *
 * The guardrail that makes "is it dead?" un-misreadable:
 *   - agent_status is VERDICT-driven, age-free (staleness never = closed/offline).
 *   - `unknown` = no probe-able anchor (agent_pid absent / cross-host), NEVER dead.
 *   - `closed` requires a POSITIVE dead signal (a declaration or a failed probe).
 *   - report_liveness = a narrow, metadata-only self-heal (no session rotation,
 *     no read-cursor touch), so old sessions become probe-able in place.
 *   - reads are PURE (in-memory verdict; zero DB writes).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2150-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;

const {
  closeDb,
  getDb,
  registerAgent,
  getAgents,
  getHealthSnapshot,
  setAgentLivenessAnchor,
  setAgentStatus,
  closeAgentSession,
  getAgentSessionId,
  sendMessage,
  deriveAgentStatus,
  _resetLivenessProbeCacheForTests,
} = await import("../src/db.js");
const { handleReportLiveness } = await import("../src/tools/status.js");
const { processStartedAt, _resetOwnHostIdForTests } = await import("../src/liveness.js");

const OWN_HOST = "v2150-own-host";
const LIVE_PID = process.pid;
const DEAD_PID = 2_147_483_646;
const REAL_START = processStartedAt(LIVE_PID); // the real start-time of this process
const STALE_START = "Mon Jan  1 00:00:00 2020";

function cleanup() {
  closeDb();
  _resetOwnHostIdForTests(undefined);
  _resetLivenessProbeCacheForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
function find(name: string) {
  return getAgents().find((a) => a.name === name)!;
}
function fresh() {
  _resetLivenessProbeCacheForTests();
}
function rawRow(name: string) {
  return getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name) as Record<string, unknown>;
}
function ageOut(name: string, minutes: number) {
  getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?")
    .run(new Date(Date.now() - minutes * 60_000).toISOString(), name);
}

beforeEach(() => {
  cleanup();
  _resetOwnHostIdForTests(OWN_HOST);
});
afterEach(() => cleanup());

// --- 1. The named regression cells, end to end via getAgents() ---

describe("v2.15.0 — named presence regressions (the bugs that bit us)", () => {
  it("RATE-LIMITED: live agent_pid + 3-day-stale last_seen → idle + liveness=alive (NOT closed)", () => {
    registerAgent("ratelimited", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("ratelimited", LIVE_PID, REAL_START);
    ageOut("ratelimited", 3 * 24 * 60); // 3 days — the old code guessed offline/abandoned
    fresh();
    const a = find("ratelimited");
    expect(a.liveness).toBe("alive");
    expect(a.agent_status).toBe("idle"); // a live PID is authoritative regardless of age
  });

  it("PRE-ANCHOR LIVE: no agent_pid + 3-day-stale → agent_status='unknown', liveness='unknown', alive=false", () => {
    registerAgent("oldsession", "builder", [], { host_id: OWN_HOST });
    ageOut("oldsession", 3 * 24 * 60);
    fresh();
    const a = find("oldsession");
    expect(a.liveness).toBe("unknown");
    expect(a.agent_status).toBe("unknown"); // absence of data != death
    expect(a.alive).toBe(false);
  });

  it("CRASH: agent_pid present but process gone → liveness=dead → agent_status='closed'", () => {
    registerAgent("crashed", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("crashed", DEAD_PID, null);
    fresh();
    const a = find("crashed");
    expect(a.liveness).toBe("dead");
    expect(a.agent_status).toBe("closed");
  });

  it("CLEAN CLOSE: closeAgentSession (SIGINT) → agent_status='closed' even though the anchor is cleared", () => {
    const { agent } = registerAgent("closer", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("closer", LIVE_PID, REAL_START);
    fresh();
    expect(find("closer").agent_status).toBe("idle"); // alive first
    const sid = agent.session_id ?? getAgentSessionId("closer")!;
    closeAgentSession("closer", sid, "SIGINT"); // clears the anchor + stores 'closed'
    fresh();
    const a = find("closer");
    expect(a.liveness).toBe("unknown"); // anchor cleared → no probe-able pid
    expect(a.agent_status).toBe("closed"); // ...but the close DECLARATION reads closed, not unknown
  });

  it("DECLARED OFFLINE wins over a live PID → offline (never idle, never closed)", () => {
    registerAgent("declared", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("declared", LIVE_PID, REAL_START);
    setAgentStatus("declared", "offline");
    fresh();
    expect(find("declared").agent_status).toBe("offline");
  });

  it("START-TIME MISSING + kill ok → alive (PID-liveness), NEVER dead", () => {
    registerAgent("nostart", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("nostart", LIVE_PID, null); // no start token
    fresh();
    expect(find("nostart").liveness).toBe("alive");
    expect(find("nostart").agent_status).toBe("idle");
  });
});

// --- 2. deriveAgentStatus is AGE-FREE + a pure function of (stored, verdict) ---

describe("v2.15.0 — deriveAgentStatus is a pure (stored, verdict) function, no age", () => {
  it("takes exactly two args and ignores time entirely", () => {
    // Same inputs → same output, no matter when called.
    expect(deriveAgentStatus("idle", "unknown")).toBe("unknown");
    expect(deriveAgentStatus("idle", "alive")).toBe("idle");
    expect(deriveAgentStatus("idle", "dead")).toBe("closed");
    expect(deriveAgentStatus("closed", "unknown")).toBe("closed");
    expect(deriveAgentStatus("offline", "alive")).toBe("offline");
    expect(deriveAgentStatus("stale", "unknown")).toBe("unknown");
    expect(deriveAgentStatus("abandoned", "unknown")).toBe("unknown");
  });
});

// --- 3. report_liveness self-heal: metadata-only, no session/read-plane touch ---

describe("v2.15.0 — report_liveness (narrow self-heal)", () => {
  it("fills agent_pid + start; session_id + last_seen UNCHANGED; touches no message/read plane", () => {
    const { agent } = registerAgent("healer", "builder", [], { host_id: OWN_HOST });
    const sidBefore = agent.session_id ?? getAgentSessionId("healer")!;
    const seenBefore = rawRow("healer").last_seen as string;
    sendMessage("system", "healer", "hi", "normal"); // mail in flight
    const msgsBefore = JSON.stringify(getDb().prepare("SELECT * FROM messages WHERE to_agent = 'healer'").all());

    const res = handleReportLiveness({ agent_name: "healer", agent_pid: LIVE_PID, agent_pid_start: REAL_START, agent_token: "x" });
    expect(JSON.parse(res.content[0].text).success).toBe(true);

    const row = rawRow("healer");
    expect(row.agent_pid).toBe(LIVE_PID);
    expect(row.agent_pid_start).toBe(REAL_START);
    expect(row.session_id).toBe(sidBefore); // NO session rotation → read cursor intact
    expect(row.last_seen).toBe(seenBefore); // NO last_seen bump
    // The read plane is session-scoped; an unrotated session_id + an untouched
    // messages table = no possibility of re-surfacing already-read mail.
    const msgsAfter = JSON.stringify(getDb().prepare("SELECT * FROM messages WHERE to_agent = 'healer'").all());
    expect(msgsAfter).toBe(msgsBefore);
    fresh();
    expect(find("healer").liveness).toBe("alive"); // now probe-able
  });

  it("same-PID + STALE start restamps to the correct start (flips dead→alive)", () => {
    registerAgent("staleanchor", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("staleanchor", LIVE_PID, STALE_START); // live pid but stale start → reused → dead
    fresh();
    expect(find("staleanchor").liveness).toBe("dead");
    handleReportLiveness({ agent_name: "staleanchor", agent_pid: LIVE_PID, agent_pid_start: REAL_START, agent_token: "x" });
    fresh();
    expect(find("staleanchor").liveness).toBe("alive"); // corrected
  });

  it("host_id COALESCE: fills a NULL host_id, but NEVER overwrites an existing one (no churn)", () => {
    // (a) NULL host_id → filled with ownHost.
    registerAgent("nohost", "builder", []); // no host_id
    expect(rawRow("nohost").host_id ?? null).toBeNull();
    handleReportLiveness({ agent_name: "nohost", agent_pid: LIVE_PID, agent_pid_start: null, agent_token: "x" });
    expect(rawRow("nohost").host_id).toBe(OWN_HOST);
    // (b) existing (different) host_id → UNCHANGED.
    registerAgent("otherhost", "builder", [], { host_id: "some-other-host" });
    handleReportLiveness({ agent_name: "otherhost", agent_pid: LIVE_PID, agent_pid_start: null, agent_token: "x" });
    expect(rawRow("otherhost").host_id).toBe("some-other-host"); // no churn
  });

  it("NOT_FOUND for an unregistered agent", () => {
    const res = handleReportLiveness({ agent_name: "ghost", agent_pid: LIVE_PID, agent_pid_start: null, agent_token: "x" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error_code).toBe("NOT_FOUND");
  });
});

// --- 4. READ-PATH PURITY: reads compute the verdict in-memory, ZERO DB writes ---

describe("v2.15.0 — read paths are pure (no DB mutation)", () => {
  it("getAgents() + getHealthSnapshot() do NOT mutate the agents row", () => {
    registerAgent("pure", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("pure", LIVE_PID, REAL_START);
    const before = JSON.stringify(rawRow("pure"));
    // Hammer the read paths (each would have written last_alive in the old code).
    for (let i = 0; i < 5; i++) { getAgents(); getHealthSnapshot(); fresh(); }
    const after = JSON.stringify(rawRow("pure"));
    expect(after).toBe(before); // byte-identical row → no read-path write
  });

  it("health_check surfaces agent_count_unknown distinctly", () => {
    registerAgent("live", "b", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("live", LIVE_PID, REAL_START);
    registerAgent("nodata", "b", [], { host_id: OWN_HOST }); // no anchor → unknown
    fresh();
    const snap = getHealthSnapshot();
    expect(snap.agent_count).toBe(2);
    expect(snap.agent_count_alive).toBe(1);
    expect(snap.agent_count_unknown).toBe(1);
  });
});

// --- 5. DRIFT GUARD: no in-repo terminal decision keys on the lossy `alive` bool ---

describe("v2.15.0 — drift guard: liveness is the field of record", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, "..");

  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "out" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.(ts|js|mjs|sh)$/.test(e.name) && !/\.test\.(ts|js)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  // Detect a READ of the lossy `alive` boolean off an object, in every form a
  // consumer could use to (mis)drive a close/relaunch/purge decision:
  //   dot / optional-chain : agent.alive, agent?.alive
  //   bracket              : agent['alive'], agent["alive"]
  //   destructuring        : const { alive } = agent; const { alive: up } = a
  // NOT matched (legitimate): the surface WRITE (`alive: <expr>` object literal),
  // the type declaration (`alive: boolean`), the string value `"alive"`, and the
  // probe FUNCTION names (isPidAlive / isAgentProcessAlive) — none is a `.alive`
  // property read. This is the CONTRACT (feedback_test_asserts_contract_not_proxy):
  // dead-vs-unknown decisions must key on `liveness`, never on `alive`.
  function readsAliveProp(line: string): boolean {
    if (/(?:\?\.|\.)\s*alive\b/.test(line)) return true; // .alive / ?.alive
    if (/\[\s*["']alive["']\s*\]/.test(line)) return true; // ['alive'] / ["alive"]
    if (/\{[^{}]*\balive\b[^{}]*\}\s*=(?!=)/.test(line)) return true; // destructure { alive } =
    return false;
  }

  it("(negative control) the detector CATCHES every read form + IGNORES legitimate writes/uses", () => {
    // If any of these regress to false, the guard below is toothless.
    for (const bad of [
      "if (!agent.alive) relaunch();",
      "if (agent?.alive === false) closeAgentSession();",
      "const dead = row['alive'] === false;",
      'const closed = row["alive"] === false;',
      "const { alive } = agent; if (!alive) purgeOldRecords();",
      "const { alive: isUp } = a; if (!isUp) markAgentOffline();",
    ]) {
      expect(readsAliveProp(bad), `should CATCH: ${bad}`).toBe(true);
    }
    for (const ok of [
      'return { alive: verdict === "alive", liveness: verdict };', // surface WRITE
      "  alive: boolean;", // type declaration
      "const up = isPidAlive(pid);", // probe fn name, not a property
      "if (holderAlive === false) {}", // unrelated variable
      'liveness: "alive"', // string value
      "agent_count_alive: agentsSnapshot.filter((a) => a.liveness === 'alive').length,", // keys on liveness
    ]) {
      expect(readsAliveProp(ok), `should IGNORE: ${ok}`).toBe(false);
    }
  });

  it("no RUNTIME JS/TS file (src + extension) reads `.alive` to drive a decision", () => {
    // The lossy `.alive` BOOL only exists on the JS/TS AgentWithStatus surface,
    // so a decision-read of it can only occur in .ts/.js. The bash hooks/scripts
    // are also scanned (below) but decide off the `agent_status` SQL column —
    // which is itself now verdict-derived + includes `unknown` — never a JS
    // `.alive` property; their only `.alive` is a jq surface TYPE assertion.
    const files = [
      ...walk(path.join(ROOT, "src")),
      ...walk(path.join(ROOT, "extensions", "vscode", "src")),
      ...walk(path.join(ROOT, "bin")),
    ].filter((f) => /\.(ts|js|mjs)$/.test(f));
    const offending: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (readsAliveProp(line)) offending.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offending, `Use \`.liveness\` (alive|dead|unknown) for dead-vs-unknown decisions, not the lossy \`.alive\` bool:\n${offending.join("\n")}`).toEqual([]);
  });

  it("bash hooks/scripts decide agent lifecycle off the (verdict-derived) agent_status column, not a raw liveness bool", () => {
    // A bash close/relaunch/offline decision must read `agent_status` (which now
    // carries 'unknown' + is age-free) — NOT re-derive death from last_seen age
    // or a bespoke alive flag. This catches a regression that hard-codes an
    // age/alive death heuristic in a hook instead of trusting agent_status.
    const shFiles = [...walk(path.join(ROOT, "hooks")), ...walk(path.join(ROOT, "scripts"))]
      .filter((f) => f.endsWith(".sh"));
    const offending: string[] = [];
    for (const f of shFiles) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // A bash comparison of agent_status to a TERMINAL literal is a decision;
        // it's allowed ONLY against 'unknown'-aware reads. Flag any hook that
        // compares to 'closed'/'offline'/'abandoned' derived from last_seen math.
        if (/agent_status\s*(=|==|!=)\s*['"]?(closed|offline|abandoned)['"]?/.test(line) &&
            /julianday|last_seen|86400/.test(line)) {
          offending.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offending, `bash lifecycle decisions must trust the verdict-derived agent_status, not re-derive death from last_seen age:\n${offending.join("\n")}`).toEqual([]);
  });
});
