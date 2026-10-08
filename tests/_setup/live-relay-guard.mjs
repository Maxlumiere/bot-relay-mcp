// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE LIVE-RELAY RUN GUARD (#305; architect 9fe05484 + 7d713a09, ruling on Codex R2 NEW-1): the end-to-end
 * control, automated. The tripwire CONTAINS and DETECTS the accidental routes it can see; some routes it can
 * neither contain nor see (an env-{} grandchild that falls back to the ACCOUNT home and port 3777, an async
 * or native reader). This guard DETECTS the ones that leave a trace in the operator's LIVE relay: it reads
 * every live relay DB before the run and after it, and FAILS the run on anything new from outside the
 * pre-run fleet. What leaves no trace (a READ of the live DB) is neither contained nor detected: stated in
 * the CHANGELOG, never silent.
 *
 * The ONLY sanctioned reader of the live DB (it runs in the vitest MAIN process, never in a worker):
 *   - READ-ONLY, and only a DB the daemon already HOLDS (its -wal and -shm exist): a read-only open then
 *     creates nothing. Anything else is NOT_EVALUATED, reported by name, never a silent pass;
 *   - the live directory's file LIST is checked before == after (a file the guard created would show).
 *
 * RED on ANY of these, fail-closed:
 *   - an agents row whose name was not there before the run;
 *   - a message created in the run to or from a name outside the pre-run fleet;
 *   - an audit_log row created in the run whose actor (agent_name, or the name it claimed in its params) is
 *     outside the pre-run fleet or missing, OR is a name the test suite uses (the original accident:
 *     7 register_agent calls for "probe", a name the live fleet ALREADY had, agent_name NULL).
 * Each offender is CLASSIFIED: it carries this run's NONCE = CERTAIN (a test leak); it names a test-suite
 * fixture = LIKELY; otherwise POSSIBLE (a real agent mid-run? check). A real fleet registration or an
 * actor-less row (a health check, an auth rejection) during the run false-fails it: loud, stated, rare
 * (MEASURED on the live relay, 8 Oct: ~12 actor-less rows a day).
 *
 * Plain JS, node builtins + better-sqlite3 (loaded lazily: without it the guard is NOT_EVALUATED).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The DB files the operator's roots may hold: <root>/relay.db and <root>/instances/<id>/relay.db, or a DB path root. */
export function liveDbCandidates(roots, readdirSync = fs.readdirSync) {
  const out = new Set();
  for (const r of roots) {
    if (/\.db$/.test(r)) {
      out.add(r);
      continue;
    }
    if (/\.json$/.test(r)) continue; // a config path root holds no DB
    out.add(path.join(r, "relay.db"));
    let ids = [];
    try {
      ids = readdirSync(path.join(r, "instances"));
    } catch {
      /* no instances */
    }
    for (const id of ids) out.add(path.join(r, "instances", id, "relay.db"));
  }
  return [...out];
}

/** Is this DB held by a running daemon (its WAL files exist)? Only then is it opened. */
export function heldByDaemon(file, existsSync = fs.existsSync) {
  return existsSync(file) && existsSync(`${file}-wal`) && existsSync(`${file}-shm`);
}

function openReadOnly(file) {
  const Database = require("better-sqlite3");
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** The names a test-suite file uses as agent identities (a literal after a name-ish key). */
export function fixtureNamesIn(dir, readdirSync = fs.readdirSync, readFileSync = fs.readFileSync) {
  const KEY = /\b(?:name|agentName|agent_name|from|to|target_agent_name|revoker_name|claimed_name)\s*:\s*["'`]([A-Za-z0-9][A-Za-z0-9._-]{0,63})["'`]/g;
  const names = new Set();
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(full);
      } else if (/\.[cm]?[jt]s$/.test(e.name)) {
        const text = readFileSync(full, "utf-8");
        for (const m of text.matchAll(KEY)) names.add(m[1]);
      }
    }
  };
  walk(dir);
  return names;
}

/** One live DB, before the run. */
export function snapshotLiveDb(file) {
  const db = openReadOnly(file);
  try {
    const names = db.prepare("SELECT name FROM agents").all().map((r) => r.name);
    const audit = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM audit_log").get().m;
    const msgs = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM messages").get().m;
    return { file, names, auditMax: audit, msgMax: msgs, dirList: fs.readdirSync(path.dirname(file)).sort() };
  } finally {
    db.close();
  }
}

function claimedName(paramsSummary) {
  if (typeof paramsSummary !== "string") return null;
  try {
    const p = JSON.parse(paramsSummary);
    return p && typeof p.name === "string" ? p.name : null;
  } catch {
    const m = /"name"\s*:\s*"([^"]+)"/.exec(paramsSummary);
    return m ? m[1] : null;
  }
}

/**
 * What appeared in `file` since `before` that the pre-run fleet does not explain. Each offender:
 * { kind, id, detail, class: "CERTAIN" | "LIKELY" | "POSSIBLE" }.
 */
export function liveOffenders(before, { fixtureNames = new Set(), nonce = "" } = {}) {
  const fleet = new Set(before.names);
  const classify = (...texts) => {
    const t = texts.filter((x) => typeof x === "string").join(" ");
    if (nonce && t.includes(nonce)) return "CERTAIN";
    if (texts.some((x) => typeof x === "string" && fixtureNames.has(x))) return "LIKELY";
    return "POSSIBLE";
  };
  const out = [];
  const db = openReadOnly(before.file);
  try {
    for (const r of db.prepare("SELECT name FROM agents").all()) {
      if (!fleet.has(r.name)) out.push({ kind: "new agent", id: r.name, detail: r.name, class: classify(r.name) });
    }
    for (const r of db.prepare("SELECT id, from_agent, to_agent FROM messages WHERE rowid > ?").all(before.msgMax)) {
      if (!fleet.has(r.from_agent) || !fleet.has(r.to_agent)) out.push({ kind: "message", id: r.id, detail: `${r.from_agent} -> ${r.to_agent}`, class: classify(r.from_agent, r.to_agent) });
    }
    for (const r of db.prepare("SELECT rowid AS rid, agent_name, tool, source, success, params_summary FROM audit_log WHERE rowid > ?").all(before.auditMax)) {
      const claimed = claimedName(r.params_summary);
      const actors = [r.agent_name, claimed].filter((x) => typeof x === "string" && x !== "");
      const outside = actors.length === 0 || actors.some((a) => !fleet.has(a));
      const fixture = actors.some((a) => fixtureNames.has(a));
      if (outside || fixture) {
        out.push({ kind: "audit", id: `rowid ${r.rid}`, detail: `${r.tool} source=${r.source} success=${r.success} actor=${actors.join("/") || "<none>"}`, class: classify(r.agent_name, claimed, r.params_summary) });
      }
    }
  } finally {
    db.close();
  }
  const dirAfter = fs.readdirSync(path.dirname(before.file)).sort();
  if (dirAfter.join("\n") !== before.dirList.join("\n")) {
    const added = dirAfter.filter((f) => !before.dirList.includes(f));
    const removed = before.dirList.filter((f) => !dirAfter.includes(f));
    out.push({ kind: "live dir file set changed", id: path.dirname(before.file), detail: `added [${added.join(", ")}] removed [${removed.join(", ")}]`, class: "POSSIBLE" });
  }
  return out;
}

/**
 * Before the run: every candidate DB is either SNAPSHOT (held by a daemon, readable) or NOT_EVALUATED with
 * its reason. Never throws: a guard that cannot evaluate says so.
 */
export function guardBefore(roots) {
  const evaluated = [];
  const notEvaluated = [];
  let driverError = null;
  try {
    require.resolve("better-sqlite3");
  } catch (err) {
    driverError = err instanceof Error ? err.message : String(err);
  }
  for (const file of liveDbCandidates(roots)) {
    if (!fs.existsSync(file)) continue;
    if (!heldByDaemon(file)) {
      notEvaluated.push({ file, why: "no daemon holds it (no -wal/-shm): never opened" });
      continue;
    }
    if (driverError) {
      notEvaluated.push({ file, why: `better-sqlite3 unavailable (${driverError})` });
      continue;
    }
    try {
      evaluated.push(snapshotLiveDb(file));
    } catch (err) {
      notEvaluated.push({ file, why: `unreadable read-only (${err instanceof Error ? err.message : String(err)})` });
    }
  }
  return { evaluated, notEvaluated };
}

/** The report lines, and whether the run must fail. */
export function guardAfter(state, opts) {
  const lines = [];
  let fail = false;
  if (state.evaluated.length === 0) lines.push(`live-relay guard: NOT_EVALUATED (no live relay DB held by a daemon was found${state.notEvaluated.length ? `; ${state.notEvaluated.map((n) => `${n.file}: ${n.why}`).join("; ")}` : ""})`);
  for (const n of state.notEvaluated) if (state.evaluated.length) lines.push(`live-relay guard: NOT_EVALUATED ${n.file}: ${n.why}`);
  for (const before of state.evaluated) {
    let offenders;
    try {
      offenders = liveOffenders(before, opts);
    } catch (err) {
      fail = true;
      lines.push(`live-relay guard: FAILED to re-read ${before.file} (${err instanceof Error ? err.message : String(err)}): failing closed`);
      continue;
    }
    if (offenders.length === 0) {
      lines.push(`live-relay guard: CLEAN ${before.file}`);
      continue;
    }
    fail = true;
    lines.push(`live-relay guard: ${offenders.length} offender(s) in the LIVE relay ${before.file} (CERTAIN = carries this run's nonce, a test leak; LIKELY = a test-suite name; POSSIBLE = check: a real agent mid-run?):`);
    for (const o of offenders) lines.push(`  ${o.class} ${o.kind} ${o.id}: ${o.detail}`);
  }
  return { fail, lines };
}
