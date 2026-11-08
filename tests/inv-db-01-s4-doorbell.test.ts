// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 4 (the doorbell residual, Codex #391 R1 P2-6): the doorbell's lock DB is opened natively by its own
 * construction (src/doorbell-lock.ts openLockFile), outside the relay's one native-open predicate. It checks the file's
 * name and this process's claims, but not the file itself. So a hard link named doorbell.lock.db to ANOTHER process's
 * wasm-owned (RLYW) relay DB would be opened natively, and BEGIN EXCLUSIVE would run on it. It must be refused before
 * any native construction: a lock file never has more than one link, and is never an RLYW (or any relay) DB.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { acquireInstanceLock, releaseInstanceLock, LOCK_DB_FILENAME } from "../src/doorbell-lock.js";

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "s4-doorbell-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const WASM = 0x524c5957;
const me = { pid: process.pid, proc_start: null, host_id: null };
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

describe("INV-DB-01 slice 4: the doorbell lock never opens a relay DB natively", () => {
  it("a HARD LINK named doorbell.lock.db to an RLYW relay DB is refused before any native open; the DB is untouched", () => {
    const caseDir = fs.mkdtempSync(path.join(ROOT, "case-"));
    const relayDb = path.join(caseDir, "relay.db");
    const d = new Database(relayDb);
    d.pragma("journal_mode = DELETE");
    d.pragma(`application_id = ${WASM}`);
    d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('owned');");
    d.close();
    const stateDir = path.join(caseDir, "doorbell");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.linkSync(relayDb, path.join(stateDir, LOCK_DB_FILENAME));
    const before = sha(relayDb);
    expect(() => acquireInstanceLock(stateDir, me)).toThrow(/(hard link|links|relay database|RLYW)/i);
    expect(sha(relayDb), "the relay DB is untouched (no BEGIN EXCLUSIVE ran on it)").toBe(before);
  });

  it("twin: a normal doorbell lock is still acquired and released", () => {
    const stateDir = fs.mkdtempSync(path.join(ROOT, "plain-"));
    const r = acquireInstanceLock(stateDir, me);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) releaseInstanceLock(r.handle);
  });
});
