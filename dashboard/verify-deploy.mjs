#!/usr/bin/env node
// bot-relay-mcp Kanban board (Vercel) — post-deploy verification.
// SPDX-License-Identifier: MIT
//
// Run ONCE after `npx vercel --prod`. Proves the whole chain end-to-end and, when
// something is wrong, NAMES which of the six usual causes it is — so "nothing on
// the board" never leaves you guessing between: wrong URL · bad secret · KV not
// provisioned · push refused · relay not restarted · page cached.
//
// Reads the URL + secrets from the ENVIRONMENT (not argv — argv leaks into `ps`
// and shell history). It NEVER prints or writes the URL or the secrets: every
// report is a status, never a value.
//
//   BOARD_URL=https://your-board.vercel.app \
//   DASHBOARD_PUSH_SECRET=... VIEW_TOKEN=... \
//   [RELAY_DASHBOARD_PUSH_URL=... RELAY_DASHBOARD_PUSH_SECRET=...] \
//   node verify-deploy.mjs
//
// What it can and cannot prove is stated at the end of every run: the HTTP checks
// exercise the LIVE deployment; the relay-side check compares config presence/match
// only — it cannot see whether the running daemon has reloaded, so it tells you to
// restart and watch the board's own banner.

import { sign, timingSafeEqualStr } from "./lib/sign.js";

export const TEST_AGENT = "__deploy-check__";
export const TEST_MARKER = "DEPLOY VERIFICATION TEST PUSH";

export function buildTestSnapshot(nowIso) {
  return {
    schema: "kanban.v1",
    generated_at: nowIso,
    agents: [
      {
        name: TEST_AGENT,
        role: "(deploy verification)",
        status: "test",
        agent_status: "test",
        cli_profile: null,
        terminal_title_ref: null,
        class: "test",
      },
    ],
    pending_on_human: [],
    task_detail_available: false,
    note:
      `⚠ ${TEST_MARKER} — not real fleet state. It is clearly marked "${TEST_AGENT}" and ` +
      "the relay's first real push (within ~30s of restarting the daemon) replaces it.",
  };
}

const norm = (u) => String(u || "").replace(/\/+$/, "");

/**
 * Run the verification checks against a deployed board.
 * @returns {{results: Array, ok: boolean, aborted?: string}}
 *   Each result: { step, ok, level: "pass"|"fail"|"critical"|"warn"|"info", cause?, detail }
 */
export async function runChecks(opts) {
  const {
    boardUrl,
    pushSecret,
    viewToken,
    relayUrl = null,
    relaySecret = null,
    nowIso = new Date().toISOString(),
    fetchImpl = globalThis.fetch,
  } = opts;

  const base = norm(boardUrl);
  const boardPath = base + "/api/board";
  const ingestPath = base + "/api/ingest";
  const results = [];
  const add = (r) => (results.push(r), r);

  // ── 1. reachable + token-gated (no token must be refused) ──────────────────
  try {
    const r = await fetchImpl(boardPath, { redirect: "manual" });
    if (r.status === 401) {
      add({ step: "1. page reachable + token-gated", ok: true, level: "pass",
            detail: "GET /api/board with no token → 401 (correctly gated)" });
    } else if (r.status === 200) {
      add({ step: "1. page reachable + token-gated", ok: false, level: "critical",
            cause: "the board served content with NO token — VIEW_TOKEN is not set on the deployment; anyone with the URL can read it.",
            detail: "GET /api/board (no token) → 200 (expected 401)" });
    } else if (r.status === 500) {
      add({ step: "1. page reachable + token-gated", ok: false, level: "fail",
            cause: "the deployment is missing VIEW_TOKEN (the page returns 500 saying so) — add it: `vercel env add VIEW_TOKEN`, then redeploy.",
            detail: "GET /api/board → 500" });
    } else {
      add({ step: "1. page reachable + token-gated", ok: false, level: "fail",
            cause: `unexpected HTTP ${r.status} from the board — check the deployment and BOARD_URL.`,
            detail: `GET /api/board → ${r.status}` });
    }
  } catch (err) {
    add({ step: "1. page reachable + token-gated", ok: false, level: "fail",
          cause: "the board URL is unreachable — wrong BOARD_URL, or `npx vercel --prod` did not succeed.",
          detail: `connection error: ${err && (err.code || err.message)}` });
    return { results, ok: false, aborted: "unreachable" };
  }

  // ── 2. correct token accepted ──────────────────────────────────────────────
  try {
    const r = await fetchImpl(boardPath + "?token=" + encodeURIComponent(viewToken), { redirect: "manual" });
    if (r.status === 200) {
      add({ step: "2. correct token accepted", ok: true, level: "pass",
            detail: "GET /api/board?token=… → 200" });
    } else if (r.status === 401) {
      add({ step: "2. correct token accepted", ok: false, level: "fail",
            cause: "VIEW_TOKEN mismatch — the token in your environment is not the one set on the deployment.",
            detail: "GET /api/board?token=… → 401" });
    } else {
      add({ step: "2. correct token accepted", ok: false, level: "fail",
            cause: `unexpected HTTP ${r.status} for a tokened board request.`,
            detail: `GET /api/board?token=… → ${r.status}` });
    }
  } catch (err) {
    add({ step: "2. correct token accepted", ok: false, level: "fail",
          cause: "the board became unreachable mid-run.", detail: String(err && err.message) });
  }

  // ── 3. signature ENFORCED (load-bearing): unsigned + bad-sig must be rejected ─
  const body = JSON.stringify(buildTestSnapshot(nowIso));
  async function postIngest(headers) {
    return fetchImpl(ingestPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      redirect: "manual",
    });
  }
  // 3a: unsigned
  try {
    const r = await postIngest({});
    if (r.status === 200) {
      add({ step: "3a. unsigned push rejected (LOAD-BEARING)", ok: false, level: "critical",
            cause: "the receiver ACCEPTED an UNSIGNED push — DASHBOARD_PUSH_SECRET is not set on the deployment. Anyone with the URL can write false state to the board.",
            detail: "POST /api/ingest with no X-Relay-Signature → 200 (expected 401)" });
    } else {
      add({ step: "3a. unsigned push rejected (LOAD-BEARING)", ok: true, level: "pass",
            detail: `unsigned POST → ${r.status} (rejected)` });
    }
  } catch (err) {
    add({ step: "3a. unsigned push rejected (LOAD-BEARING)", ok: false, level: "fail",
          cause: "the ingest endpoint is unreachable.", detail: String(err && err.message) });
  }
  // 3b: bad signature
  try {
    const r = await postIngest({ "X-Relay-Signature": "sha256=" + "0".repeat(64) });
    if (r.status === 200) {
      add({ step: "3b. bad-signature push rejected (LOAD-BEARING)", ok: false, level: "critical",
            cause: "the receiver ACCEPTED a FORGED-signature push — signature verification is not working on the deployment.",
            detail: "POST /api/ingest with a wrong signature → 200 (expected 401)" });
    } else {
      add({ step: "3b. bad-signature push rejected (LOAD-BEARING)", ok: true, level: "pass",
            detail: `bad-signature POST → ${r.status} (rejected)` });
    }
  } catch (err) {
    add({ step: "3b. bad-signature push rejected (LOAD-BEARING)", ok: false, level: "fail",
          cause: "the ingest endpoint is unreachable.", detail: String(err && err.message) });
  }

  // ── 4. a correctly-signed test push is accepted AND visible ────────────────
  let pushed = false;
  try {
    const r = await postIngest({ "X-Relay-Signature": sign(Buffer.from(body), pushSecret) });
    if (r.status === 200) {
      pushed = true;
      add({ step: "4a. correctly-signed push accepted", ok: true, level: "pass",
            detail: "signed POST /api/ingest → 200" });
    } else if (r.status === 401) {
      add({ step: "4a. correctly-signed push accepted", ok: false, level: "fail",
            cause: "your correctly-signed test push was REJECTED — the DASHBOARD_PUSH_SECRET in your environment does not match the deployment's. This is the #1 cause of a stuck board.",
            detail: "signed POST → 401" });
    } else if (r.status === 502) {
      add({ step: "4a. correctly-signed push accepted", ok: false, level: "fail",
            cause: "the push was authenticated but STORING it failed — the Vercel KV store is not provisioned/linked (KV_REST_API_URL / KV_REST_API_TOKEN missing).",
            detail: "signed POST → 502 (store failed)" });
    } else if (r.status === 400) {
      add({ step: "4a. correctly-signed push accepted", ok: false, level: "fail",
            cause: "the board rejected the snapshot schema — the deployed board and this script disagree on kanban.v1; redeploy from the same commit.",
            detail: "signed POST → 400" });
    } else {
      add({ step: "4a. correctly-signed push accepted", ok: false, level: "fail",
            cause: `unexpected HTTP ${r.status} for a signed push.`, detail: `signed POST → ${r.status}` });
    }
  } catch (err) {
    add({ step: "4a. correctly-signed push accepted", ok: false, level: "fail",
          cause: "the ingest endpoint is unreachable.", detail: String(err && err.message) });
  }
  // 4b: the test push must render on the page
  if (pushed) {
    try {
      const r = await fetchImpl(boardPath + "?token=" + encodeURIComponent(viewToken), { redirect: "manual" });
      const html = await r.text();
      if (html.includes(TEST_AGENT)) {
        add({ step: "4b. test push visible on the board", ok: true, level: "pass",
              detail: `the board renders the "${TEST_AGENT}" marker` });
      } else {
        add({ step: "4b. test push visible on the board", ok: false, level: "fail",
              cause: "the push stored but did not render — KV read/write inconsistent, or the page is being cached (it should send Cache-Control: no-store).",
              detail: "signed push accepted but the marker is absent from the rendered page" });
      }
    } catch (err) {
      add({ step: "4b. test push visible on the board", ok: false, level: "fail",
            cause: "the board became unreachable mid-run.", detail: String(err && err.message) });
    }
  }

  // ── 5. relay side — config PRESENCE + MATCH only (cannot see a live reload) ──
  if (!relayUrl && !relaySecret) {
    add({ step: "5. relay push configuration", ok: true, level: "info",
          cause: null,
          detail:
            "relay push env not visible here — run this on the relay host, or set RELAY_DASHBOARD_PUSH_URL / RELAY_DASHBOARD_PUSH_SECRET. " +
            "After setting them, RESTART the daemon; the board's OWN banner flips to a real 'ok' within ~30s (this script cannot see the daemon reload)." });
  } else {
    const urlMatch = relayUrl ? norm(relayUrl) === ingestPath : null;
    const secretMatch = relayUrl && relaySecret ? timingSafeEqualStr(relaySecret, pushSecret) : null;
    if (relayUrl && !relaySecret) {
      add({ step: "5. relay push configuration", ok: false, level: "warn",
            cause: "the relay has RELAY_DASHBOARD_PUSH_URL but no RELAY_DASHBOARD_PUSH_SECRET — it will REFUSE to push (by design). Set the secret and restart the daemon.",
            detail: "relay: URL set, secret unset" });
    } else {
      if (urlMatch === false) {
        add({ step: "5a. relay URL points at this board", ok: false, level: "warn",
              cause: "RELAY_DASHBOARD_PUSH_URL does NOT equal this board's /api/ingest — the relay is pushing somewhere else.",
              detail: "relay URL ≠ this board's ingest path" });
      } else if (urlMatch === true) {
        add({ step: "5a. relay URL points at this board", ok: true, level: "pass", detail: "relay URL matches /api/ingest" });
      }
      if (secretMatch === false) {
        add({ step: "5b. relay secret matches the board", ok: false, level: "warn",
              cause: "RELAY_DASHBOARD_PUSH_SECRET ≠ the board's DASHBOARD_PUSH_SECRET — real pushes will be REJECTED and the board will show a 'rejected' banner. Make them identical and restart the daemon.",
              detail: "relay secret ≠ board secret" });
      } else if (secretMatch === true) {
        add({ step: "5b. relay secret matches the board", ok: true, level: "pass",
              detail: "relay secret matches (compared in constant time; neither printed)" });
      }
      add({ step: "5c. restart reminder", ok: true, level: "info",
            detail: "config presence/match verified — but this script cannot confirm the RUNNING daemon reloaded. Restart it and watch the board's own banner flip to a real 'ok'." });
    }
  }

  const ok = !results.some((r) => r.level === "fail" || r.level === "critical");
  return { results, ok };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const ICON = { pass: "✅", fail: "❌", critical: "⛔", warn: "⚠️ ", info: "ℹ️ " };

function main() {
  const boardUrl = process.env.BOARD_URL || process.argv[2];
  const pushSecret = process.env.DASHBOARD_PUSH_SECRET;
  const viewToken = process.env.VIEW_TOKEN;
  const relayUrl = process.env.RELAY_DASHBOARD_PUSH_URL || null;
  const relaySecret = process.env.RELAY_DASHBOARD_PUSH_SECRET || null;

  const missing = [];
  if (!boardUrl) missing.push("BOARD_URL");
  if (!pushSecret) missing.push("DASHBOARD_PUSH_SECRET");
  if (!viewToken) missing.push("VIEW_TOKEN");
  if (missing.length) {
    console.error(
      `Missing required env: ${missing.join(", ")}.\n` +
        "Usage (secrets via ENV so they don't leak into `ps`/history):\n" +
        "  BOARD_URL=https://your-board.vercel.app DASHBOARD_PUSH_SECRET=… VIEW_TOKEN=… \\\n" +
        "  [RELAY_DASHBOARD_PUSH_URL=… RELAY_DASHBOARD_PUSH_SECRET=…] node verify-deploy.mjs",
    );
    process.exit(2);
  }

  runChecks({ boardUrl, pushSecret, viewToken, relayUrl, relaySecret })
    .then(({ results, ok, aborted }) => {
      console.log("\nbot-relay board — post-deploy verification\n");
      for (const r of results) {
        console.log(`${ICON[r.level] || "  "} ${r.step}`);
        if (r.detail) console.log(`      ${r.detail}`);
        if (r.cause) console.log(`      → ${r.cause}`);
      }
      console.log("\n" + "─".repeat(60));
      if (aborted === "unreachable") {
        console.log("⛔ Could not reach the board — nothing else could be tested. Fix BOARD_URL / the deployment first.");
      } else if (ok) {
        console.log("✅ The DEPLOYED PAGE is proven end-to-end: reachable, token-gated, signature-enforced, and it stores + renders a signed push.");
      } else {
        console.log("❌ At least one check failed — see the named cause above. Fix it and re-run.");
      }
      console.log(
        "\nWhat this did and did NOT prove:\n" +
          "  • PROVEN against the live deployment: token gating, signature enforcement (unsigned + forged rejected),\n" +
          "    a signed push stored and rendered.\n" +
          "  • NOT proven here: that the RELAY daemon is actually pushing. Step 5 checks config match only —\n" +
          "    restart the daemon and confirm the board's OWN banner shows a real 'ok' (not the test marker).\n" +
          `  • The test push is labelled "${TEST_AGENT}"; the relay's first real push replaces it.`,
      );
      process.exit(ok && aborted == null ? 0 : 1);
    })
    .catch((err) => {
      console.error("verification crashed:", err && err.message);
      process.exit(1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
