// bot-relay-mcp Kanban board — local mock test of the post-deploy verifier.
// Run: npm test  (from dashboard/)
//
// This exercises verify-deploy.mjs's runChecks against the REAL api/ingest.js +
// api/board.js handlers (mounted on a local http server) talking to a fake
// Upstash-compatible KV. It proves the verifier's LOGIC and that the handlers
// behave as the verifier asserts. It does NOT prove the real Vercel/Upstash
// deployment — that is only exercised when Maxime runs the script live.
//
// NOTE: kv.js captures KV_REST_API_URL at module load, so we stand up ONE shared
// real board (one KV, one import); the board's secret/token are read per-request,
// and every failure case is injected via the runChecks INPUTS, not by re-importing.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const SECRET = "test-push-secret-deadbeef";
const TOKEN = "test-view-token-cafef00d";

function startKV() {
  const store = new Map();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const m = u.pathname.match(/^\/(get|set)\/(.+)$/);
    if (!m) { res.statusCode = 404; return res.end(); }
    const [, op, rawKey] = m;
    const key = decodeURIComponent(rawKey);
    if (op === "get") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ result: store.has(key) ? store.get(key) : null }));
    }
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      store.set(key, b);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: "OK" }));
    });
  });
  return srv;
}

function adapt(handler) {
  return (req, res) => {
    const u = new URL(req.url, "http://localhost");
    req.query = Object.fromEntries(u.searchParams.entries());
    res.status = (n) => { res.statusCode = n; return res; };
    res.send = (b) => res.end(typeof b === "string" ? b : String(b));
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    Promise.resolve(handler(req, res)).catch((e) => {
      try { res.statusCode = 500; res.end(String(e && e.message)); } catch { /* already sent */ }
    });
  };
}

const listen = (srv) =>
  new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));

// --- one shared REAL board (env set BEFORE importing the handlers) ---
const kv = startKV();
const kvUrl = await listen(kv);
process.env.KV_REST_API_URL = kvUrl;
process.env.KV_REST_API_TOKEN = "x";
process.env.DASHBOARD_PUSH_SECRET = SECRET;
process.env.VIEW_TOKEN = TOKEN;
const ingest = adapt((await import("../api/ingest.js")).default);
const boardH = adapt((await import("../api/board.js")).default);
const realSrv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;
  if (req.method === "POST" && p === "/api/ingest") return ingest(req, res);
  if (req.method === "GET" && (p === "/api/board" || p === "/")) return boardH(req, res);
  res.statusCode = 404; res.end();
});
const BOARD = await listen(realSrv);

const { runChecks } = await import("../verify-deploy.mjs");
const byStep = (results, prefix) => results.find((r) => r.step.startsWith(prefix));

test("GOOD deployment: every HTTP check passes end-to-end", async () => {
  const { results, ok } = await runChecks({ boardUrl: BOARD, pushSecret: SECRET, viewToken: TOKEN });
  assert.equal(byStep(results, "1.").ok, true, "token-gated");
  assert.equal(byStep(results, "2.").ok, true, "correct token accepted");
  assert.equal(byStep(results, "3a").ok, true, "unsigned rejected");
  assert.equal(byStep(results, "3b").ok, true, "bad-sig rejected");
  assert.equal(byStep(results, "4a").ok, true, "signed push accepted");
  assert.equal(byStep(results, "4b").ok, true, "test push visible");
  assert.ok(ok, "overall ok");
});

test("BAD view token: check 2 fails and names the token mismatch", async () => {
  const { results } = await runChecks({ boardUrl: BOARD, pushSecret: SECRET, viewToken: "wrong-token" });
  const c2 = byStep(results, "2.");
  assert.equal(c2.ok, false);
  assert.match(c2.cause, /VIEW_TOKEN mismatch/i);
});

test("BAD push secret: 4a fails as bad-secret, but 3a/3b still pass (bad secret ≠ broken signing)", async () => {
  const { results } = await runChecks({ boardUrl: BOARD, pushSecret: "wrong-secret", viewToken: TOKEN });
  assert.equal(byStep(results, "3a").ok, true, "unsigned still rejected");
  assert.equal(byStep(results, "3b").ok, true, "bad-sig still rejected");
  const c4 = byStep(results, "4a");
  assert.equal(c4.ok, false);
  assert.match(c4.cause, /does not match|#1 cause/i);
});

test("relay env compare: secret mismatch → warn; match → pass; never echoes values", async () => {
  const mism = await runChecks({
    boardUrl: BOARD, pushSecret: SECRET, viewToken: TOKEN,
    relayUrl: BOARD + "/api/ingest", relaySecret: "different-secret",
  });
  const w = byStep(mism.results, "5b");
  assert.equal(w.level, "warn");
  assert.match(w.cause, /will be REJECTED/i);
  const blob = JSON.stringify(mism.results);
  assert.ok(!blob.includes("different-secret") && !blob.includes(SECRET), "secrets must never be echoed");

  const good = await runChecks({
    boardUrl: BOARD, pushSecret: SECRET, viewToken: TOKEN,
    relayUrl: BOARD + "/api/ingest", relaySecret: SECRET,
  });
  assert.equal(byStep(good.results, "5a").ok, true, "relay URL matches");
  assert.equal(byStep(good.results, "5b").ok, true, "relay secret matches");
});

test("OPEN receiver: the load-bearing checks CATCH it (1 + 3a + 3b critical)", async () => {
  const open = http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && p === "/api/ingest") { res.statusCode = 200; return res.end('{"ok":true}'); }
    if (p === "/api/board" || p === "/") { res.statusCode = 200; return res.end("<html>open</html>"); }
    res.statusCode = 404; res.end();
  });
  const url = await listen(open);
  try {
    const { results, ok } = await runChecks({ boardUrl: url, pushSecret: SECRET, viewToken: TOKEN });
    assert.equal(byStep(results, "1.").level, "critical", "open board (200, no token) is critical");
    assert.equal(byStep(results, "3a").level, "critical", "accepting unsigned is critical");
    assert.equal(byStep(results, "3b").level, "critical", "accepting forged sig is critical");
    assert.equal(ok, false);
  } finally { open.close(); }
});

test("UNREACHABLE board: aborts with the unreachable cause, no false green", async () => {
  const { results, ok, aborted } = await runChecks({ boardUrl: "http://127.0.0.1:1", pushSecret: SECRET, viewToken: TOKEN });
  assert.equal(aborted, "unreachable");
  assert.equal(ok, false);
  assert.match(byStep(results, "1.").cause, /unreachable/i);
});

test.after(() => { realSrv.close(); kv.close(); });
