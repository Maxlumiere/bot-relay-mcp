// bot-relay-mcp Kanban board (Vercel) — unit tests (node:test, no deps).
// Run: npm test   (from the dashboard/ directory)
import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, verifySignature, timingSafeEqualStr } from "../lib/sign.js";
import { computeBanner } from "../lib/board-state.js";
import { renderBoard, escapeHtml } from "../lib/render.js";

const SECRET = "s3cr3t-shared-push-key";

test("verifySignature: a correctly-signed body passes", () => {
  const body = Buffer.from(JSON.stringify({ schema: "kanban.v1" }));
  const v = verifySignature(body, sign(body, SECRET), SECRET);
  assert.equal(v.ok, true);
});

test("verifySignature: missing header is rejected (unsigned push)", () => {
  const body = Buffer.from("x");
  const v = verifySignature(body, undefined, SECRET);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unsigned|missing/i);
});

test("verifySignature: no receiver secret fails CLOSED", () => {
  const body = Buffer.from("x");
  const v = verifySignature(body, sign(body, SECRET), undefined);
  assert.equal(v.ok, false);
  assert.match(v.reason, /secret/i);
});

test("verifySignature: wrong secret is rejected", () => {
  const body = Buffer.from("x");
  const v = verifySignature(body, sign(body, "other-secret"), SECRET);
  assert.equal(v.ok, false);
  assert.match(v.reason, /mismatch/i);
});

test("verifySignature: tampered body is rejected (sig computed over original)", () => {
  const original = Buffer.from(JSON.stringify({ schema: "kanban.v1", agents: [] }));
  const sig = sign(original, SECRET);
  const tampered = Buffer.from(JSON.stringify({ schema: "kanban.v1", agents: [{ name: "ghost" }] }));
  const v = verifySignature(tampered, sig, SECRET);
  assert.equal(v.ok, false);
});

test("timingSafeEqualStr: equal vs unequal", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abd"), false);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false); // length differs
});

// --- the four banner states must be DISTINCT; misconfig must not look like idle ---

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const fresh = { received_at: "2026-09-09T11:59:40.000Z", snapshot: { schema: "kanban.v1" } }; // 20s old
const old = { received_at: "2026-09-09T11:55:00.000Z", snapshot: { schema: "kanban.v1" } }; // 5m old

test("computeBanner: no snapshot ever → waiting", () => {
  assert.equal(computeBanner({ latest: null, lastRejection: null, nowMs: NOW }).level, "waiting");
});

test("computeBanner: fresh snapshot → ok", () => {
  assert.equal(computeBanner({ latest: fresh, lastRejection: null, nowMs: NOW }).level, "ok");
});

test("computeBanner: old snapshot, no rejection → stale (pipe down / idle)", () => {
  assert.equal(computeBanner({ latest: old, lastRejection: null, nowMs: NOW }).level, "stale");
});

test("computeBanner: rejection NEWER than last good → rejected (misconfig), even if snapshot is fresh", () => {
  const rej = { at: "2026-09-09T11:59:55.000Z", reason: "signature mismatch" };
  const b = computeBanner({ latest: fresh, lastRejection: rej, nowMs: NOW });
  assert.equal(b.level, "rejected");
  assert.match(b.detail, /NOT an idle fleet/);
});

test("computeBanner: rejection OLDER than last good → NOT rejected (a since-recovered push wins)", () => {
  const oldRej = { at: "2026-09-09T11:58:00.000Z", reason: "signature mismatch" };
  // fresh push at 11:59:40 is newer than the 11:58:00 rejection → healthy again
  assert.equal(computeBanner({ latest: fresh, lastRejection: oldRej, nowMs: NOW }).level, "ok");
});

// --- render must escape fleet-authored strings (XSS on Maxime's browser) ---

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml('<script>&"'), "&lt;script&gt;&amp;&quot;");
});

test("renderBoard escapes a hostile agent name and obligation preview", () => {
  const latest = {
    received_at: "2026-09-09T11:59:40.000Z",
    snapshot: {
      schema: "kanban.v1",
      generated_at: "2026-09-09T11:59:40.000Z",
      agents: [{ name: "<script>alert(1)</script>", role: "builder", status: "active", agent_status: "active" }],
      pending_on_human: [
        { to_agent: "maxime", from_agent: "victra", disposition: "obligation",
          content_preview: "<img src=x onerror=alert(2)>", created_at: "2026-09-09T11:00:00.000Z", deadline: null, overdue: false },
      ],
      task_detail_available: false,
      note: "v1 note",
    },
  };
  const html = renderBoard({ latest, lastRejection: null, nowMs: NOW });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag must not appear");
  assert.ok(!html.includes("<img src=x onerror=alert(2)>"), "raw img payload must not appear");
  assert.ok(html.includes("&lt;script&gt;"), "name should be escaped");
  assert.ok(html.includes("maxime"), "pending lane renders the human");
});
