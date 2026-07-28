// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hermetic config isolation — a vitest `setupFiles` module. It runs in the worker
 * BEFORE each test file's own module code, points RELAY_CONFIG_PATH at a fresh
 * per-worker temp, and clears ambient operator secrets, so NO test reads the
 * operator's real ~/.bot-relay/config.json or inherits a real dashboard secret.
 *
 * WHY (the defect this closes): config-sensitive test files never isolated config,
 * so the suite only ever exercised the "no config" posture — green in CI because CI
 * runners have no ~/.bot-relay, NOT because isolation worked. On a machine where
 * `relay init` has run (a real dashboard_secret present), in-process test daemons
 * READ that secret, so operator + WebSocket-upgrade endpoints demand it and return
 * 401/403 instead of the expected unauthenticated posture — ~145 spurious failures,
 * including the tests/v2-8-wire-emit-sites.ts ws-401 cluster that reproduced ONLY on
 * the publishing machine (the one with a secret) and passed in every clean CI run.
 * That is the exact class where "CI green" does not mean "publish-ready". One site
 * fixes the whole suite and every future test.
 *
 * SCOPE — RELAY_CONFIG_PATH + SECRETS ONLY, deliberately NOT RELAY_HOME. The
 * dashboard secret resolves from RELAY_DASHBOARD_SECRET (env) || config.dashboard_secret
 * (config file) and NOTHING else (src/config.ts:dashboardSecret) — isolating the
 * config path AND clearing the env secrets neutralises BOTH sources, which is the
 * entire harm axis. We do NOT force RELAY_HOME: the DB / instance-resolution tests
 * OWN that axis (they construct their own RELAY_HOME + instances), and forcing it
 * here broke exactly those files. Config isolation is the harm; instance layout is not.
 *
 * OVERRIDE CONTRACT — asserted, never assumed (tests/config-isolation.test.ts): this
 * sets env at MODULE TOP, so a test file that sets its OWN RELAY_CONFIG_PATH at its
 * module top (its code runs AFTER this setup module) WINS. It is NOT done in a
 * beforeEach/beforeAll hook — that would run AFTER the test file's module code and
 * clobber a test's own path, silently redirecting it to the wrong config and
 * reintroducing this very defect.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-hermetic-"));
// A non-existent config.json under a private temp → loadConfig() falls to its
// defaults (no dashboard_secret, no http_secret): the "unconfigured" posture the
// suite has always assumed. Set UNCONDITIONALLY (this clears any ambient/shell
// RELAY_CONFIG_PATH leak); a test that needs its own config assigns it at its OWN
// module top, which runs AFTER this and wins (the override contract).
process.env.RELAY_CONFIG_PATH = path.join(hermetic, "config.json");
// Ambient operator secrets must not leak in from the shell, the launchd env, or a
// prior file in the same worker. dashboardSecret() reads these live.
delete process.env.RELAY_DASHBOARD_SECRET;
delete process.env.RELAY_HTTP_SECRET;
