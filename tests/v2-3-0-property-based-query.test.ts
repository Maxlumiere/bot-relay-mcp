// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part A.1 — property-based tests for the relay read path.
 *
 * fast-check randomizes content bodies, priority, batch sizes, limits,
 * and peek flag. Each property asserts an invariant that must hold
 * regardless of input shape. Goal: catch the class of bugs that shipped
 * in v2.2.1 (get_messages dropped pending mail on repeat-poll) before
 * they ship again.
 *
 * Performance: ONE DB + ONE agent pair per test (registerAgent is slow
 * because bcrypt is intentionally expensive). Each iteration pre-drains
 * pending mail so property setup starts clean without paying register
 * cost on every iteration.
 *
 * numRuns defaults to 30 (default gate), 200 under FAST_CHECK_FULL=1
 * (--full gate). 6 properties → ~180 / ~1200 scenarios per run.
 *
 * Properties (per brief):
 *   P1. Send-then-pending: send + peek=true returns that message exactly once.
 *   P2. Peek-no-mark: two peek=true polls return identical result sets.
 *   P3. Consume-once: peek=false drains; back-compat preserved.
 *   P4. Status partition: all >= pending + read.
 *   P5. Limit invariant: returned.length <= limit.
 *   P6. Round-trip identity: content byte-equal across send/get.
 *
 * (Brief's P6 since-filter monotonicity deferred to v2.3.1 — needs
 * timestamp manipulation outside sanctioned-helper surface.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v230-property-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const { closeDb, registerAgent, sendMessage, getMessages } = await import("../src/db.js");

const NUM_RUNS = process.env.FAST_CHECK_FULL === "1" ? 200 : 30;
const FROM = "p-from";
const TO = "p-to";

const messageContent = fc.string({ minLength: 1, maxLength: 200 });
const priority = fc.constantFrom("critical", "high", "normal", "low");
const limit = fc.integer({ min: 1, max: 100 });

function drainAll(): void {
  // Consume every pending message against the current session. Leaves the
  // inbox empty so the next iteration starts from a known clean state.
  getMessages(TO, "pending", 1000, false);
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  registerAgent(FROM, "r", [], { force: true });
  registerAgent(TO, "r", [], { force: true });
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.3.0 A.1 — property-based relay read path", () => {
  it("(P1) send-then-peek returns the message exactly once", () => {
    fc.assert(
      fc.property(messageContent, priority, (content, p) => {
        drainAll();
        sendMessage(FROM, TO, content, p);
        const peeked = getMessages(TO, "pending", 100, true);
        expect(peeked.length).toBe(1);
        expect(peeked[0].content).toBe(content);
        expect(peeked[0].from_agent).toBe(FROM);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30000);

  it("(P2) two consecutive peek=true polls return identical ID sets", () => {
    fc.assert(
      fc.property(fc.array(messageContent, { minLength: 1, maxLength: 5 }), (contents) => {
        drainAll();
        for (const c of contents) sendMessage(FROM, TO, c, "normal");
        const a = getMessages(TO, "pending", 100, true).map((m) => m.id).sort();
        const b = getMessages(TO, "pending", 100, true).map((m) => m.id).sort();
        expect(b).toEqual(a);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30000);

  it("(P3) peek=false drains (second consume-once call returns empty)", () => {
    fc.assert(
      fc.property(fc.array(messageContent, { minLength: 1, maxLength: 5 }), (contents) => {
        drainAll();
        for (const c of contents) sendMessage(FROM, TO, c, "normal");
        const first = getMessages(TO, "pending", 100, false);
        const second = getMessages(TO, "pending", 100, false);
        expect(first.length).toBe(contents.length);
        expect(second.length).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30000);

  it("(P4) status partition: all >= pending(peek) + read (disjoint this-session)", () => {
    // Invariant only holds when the total row count fits under the limit.
    // Bound batch sizes so sendFirst + sendSecond ≤ 100 per iteration and
    // drain + reset pre-iteration so cross-iteration reads don't fill the
    // 100-row limit on `all`.
    fc.assert(
      fc.property(
        fc.array(messageContent, { minLength: 0, maxLength: 10 }),
        fc.array(messageContent, { minLength: 0, maxLength: 10 }),
        (sendFirst, sendSecond) => {
          // Fresh DB per iteration — wipe accumulated read rows from prior
          // iterations so `all`'s 100-limit never caps below pending+read.
          closeDb();
          fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
          fs.mkdirSync(TEST_DB_DIR, { recursive: true });
          registerAgent(FROM, "r", [], { force: true });
          registerAgent(TO, "r", [], { force: true });
          for (const c of sendFirst) sendMessage(FROM, TO, c, "normal");
          getMessages(TO, "pending", 100, false); // consume batch 1
          for (const c of sendSecond) sendMessage(FROM, TO, c, "normal");
          const all = getMessages(TO, "all", 100, true).length;
          const pending = getMessages(TO, "pending", 100, true).length;
          const read = getMessages(TO, "read", 100, true).length;
          expect(all).toBeGreaterThanOrEqual(pending);
          expect(all).toBeGreaterThanOrEqual(read);
          expect(all).toBeGreaterThanOrEqual(pending + read);
        },
      ),
      // Smaller run count for P4 because each iteration rebuilds the DB.
      { numRuns: Math.max(10, Math.floor(NUM_RUNS / 3)) },
    );
  }, 60000);

  it("(P5) limit invariant: returned <= limit", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), limit, (n, lim) => {
        drainAll();
        for (let i = 0; i < n; i++) sendMessage(FROM, TO, "m" + i, "normal");
        const got = getMessages(TO, "pending", lim, true);
        expect(got.length).toBeLessThanOrEqual(lim);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30000);

  it("(P6) round-trip content identity", () => {
    fc.assert(
      fc.property(messageContent, (content) => {
        drainAll();
        sendMessage(FROM, TO, content, "normal");
        const [got] = getMessages(TO, "pending", 1, true);
        expect(got.content).toBe(content);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});
