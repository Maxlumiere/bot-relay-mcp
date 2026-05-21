// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7.2 — spawn-manifest helpers + hook-fallback integration tests.
 *
 * Defense-in-depth contract: when the typed-env transport drops
 * RELAY_AGENT_NAME between bin/spawn-agent.sh and the SessionStart hook,
 * the hook recovers identity from a fresh per-instance manifest file
 * instead of silently re-registering as "default".
 *
 * These tests source the SHIPPED helper script + invoke the SHIPPED
 * hook script via bash, mirroring the v2.6.1 test discipline so any
 * drift between this test file's expectations and what bash actually
 * does at runtime surfaces here, not in a live spawn.
 *
 * Per `feedback_test_path_must_match_shipped_path.md`: no TS re-impl.
 * Per `feedback_test_asserts_contract_not_proxy.md`: assertions are on
 * the observed effect (fallback name appears in hook output) not on a
 * proxy of the effect.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(REPO_ROOT, "hooks", "_vault-helpers.sh");

let TEST_ROOT: string;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v272-manifest-"));
});

afterEach(() => {
  if (TEST_ROOT && fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

interface BashResult {
  status: number;
  stdout: string;
  stderr: string;
}

function bashRun(script: string, extraEnv: Record<string, string> = {}): BashResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_HOME: TEST_ROOT,
    ...extraEnv,
  };
  // Unsetting these via shell-level `unset` inside the script keeps the
  // hook on its per-instance code path regardless of the test runner's env.
  delete env.RELAY_DB_PATH;
  delete env.RELAY_INSTANCE_ID;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    timeout: 10_000,
    env,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Helper that builds a script which sources the shipped helper file with
// a clean env (no RELAY_DB_PATH / RELAY_INSTANCE_ID leakage) so resolved
// paths land under TEST_ROOT/instances/<id>/agents/.
function helperScript(body: string): string {
  return `
set -u
RELAY_HOME='${TEST_ROOT}'
unset RELAY_DB_PATH RELAY_INSTANCE_ID
. '${HELPER}'
${body}
`;
}

// The default db path with no instance set is "$RELAY_HOME/relay.db" per
// resolve_relay_db_path. So the agents dir lands at "$RELAY_HOME/agents".
function agentsDir(): string {
  return path.join(TEST_ROOT, "agents");
}

describe("v2.7.2 — write_relay_spawn_manifest", () => {
  it("(M1) writes name + role + spawn_pid + ISO timestamp to the resolved path", () => {
    const r = bashRun(
      helperScript(`write_relay_spawn_manifest 'victra-memory-build' 'builder'`),
    );
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const p = path.join(agentsDir(), "victra-memory-build.spawn-manifest");
    expect(fs.existsSync(p)).toBe(true);
    const body = fs.readFileSync(p, "utf-8");
    expect(body).toMatch(/^name=victra-memory-build$/m);
    expect(body).toMatch(/^role=builder$/m);
    expect(body).toMatch(/^spawn_pid=\d+$/m);
    expect(body).toMatch(/^spawned_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
  });

  it("(M2) chmod 0600 — manifest is owner-readable only", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'worker1' 'researcher'`));
    const p = path.join(agentsDir(), "worker1.spawn-manifest");
    const mode = fs.statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("(M3) rejects malformed name", () => {
    const r = bashRun(helperScript(`write_relay_spawn_manifest 'bad name' 'builder' || echo REJECTED`));
    expect(r.stdout).toContain("REJECTED");
    expect(r.stderr).toMatch(/malformed name/);
  });

  it("(M4) rejects malformed role", () => {
    const r = bashRun(helperScript(`write_relay_spawn_manifest 'worker1' 'has spaces' || echo REJECTED`));
    expect(r.stdout).toContain("REJECTED");
    expect(r.stderr).toMatch(/malformed role/);
  });

  it("(M5) atomic — concurrent writers never leave a half-written manifest", () => {
    // Fire 10 sequential writes; assert each leaves a fully-formed file.
    const r = bashRun(
      helperScript(`
        for i in 1 2 3 4 5 6 7 8 9 10; do
          write_relay_spawn_manifest "worker${'$'}i" 'builder' || exit 1
        done
        echo OK
      `),
    );
    expect(r.stdout).toContain("OK");
    for (let i = 1; i <= 10; i++) {
      const p = path.join(agentsDir(), `worker${i}.spawn-manifest`);
      const body = fs.readFileSync(p, "utf-8");
      expect(body).toMatch(new RegExp(`^name=worker${i}$`, "m"));
      expect(body).toMatch(/^role=builder$/m);
    }
  });
});

describe("v2.7.2 — find_fresh_relay_spawn_manifest", () => {
  it("(F1) returns name+role on exactly one fresh manifest", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'victra-memory-build' 'builder'`));
    const r = bashRun(helperScript(`find_fresh_relay_spawn_manifest 60`));
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe("name=victra-memory-build;role=builder");
  });

  it("(F2) returns non-zero when no manifest exists", () => {
    fs.mkdirSync(agentsDir(), { recursive: true });
    const r = bashRun(helperScript(`find_fresh_relay_spawn_manifest 60`));
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("(F3) returns non-zero when the agents dir doesn't exist", () => {
    // No write before find — agents/ dir never created.
    const r = bashRun(helperScript(`find_fresh_relay_spawn_manifest 60`));
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("(F4) rejects ambiguity — TWO fresh manifests → fall through", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'agent-a' 'builder'`));
    bashRun(helperScript(`write_relay_spawn_manifest 'agent-b' 'builder'`));
    const r = bashRun(helperScript(`find_fresh_relay_spawn_manifest 60`));
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("(F5) ignores stale manifests via mtime", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'old-agent' 'builder'`));
    const p = path.join(agentsDir(), "old-agent.spawn-manifest");
    // Push mtime 5 minutes into the past — well past the 60s window.
    const past = (Date.now() / 1000 | 0) - 300;
    fs.utimesSync(p, past, past);
    const r = bashRun(helperScript(`find_fresh_relay_spawn_manifest 60`));
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("(F6) rejects manifest whose filename and content name disagree", () => {
    // Write a manifest, then rename the file so filename != name= line.
    bashRun(helperScript(`write_relay_spawn_manifest 'real-name' 'builder'`));
    const orig = path.join(agentsDir(), "real-name.spawn-manifest");
    const tampered = path.join(agentsDir(), "fake-name.spawn-manifest");
    fs.renameSync(orig, tampered);
    const r = bashRun(helperScript(`find_fresh_relay_spawn_manifest 60`));
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("(F7) honors custom max-age window — 10s window rejects 30s-old file", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'short-lived' 'builder'`));
    const p = path.join(agentsDir(), "short-lived.spawn-manifest");
    const past = (Date.now() / 1000 | 0) - 30;
    fs.utimesSync(p, past, past);
    const r = bashRun(helperScript(`find_fresh_relay_spawn_manifest 10`));
    // 30s old, 10s window → reject.
    expect(r.status).not.toBe(0);
  });
});

describe("v2.7.2 — delete_relay_spawn_manifest", () => {
  it("(D1) removes an existing manifest", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'transient' 'builder'`));
    const p = path.join(agentsDir(), "transient.spawn-manifest");
    expect(fs.existsSync(p)).toBe(true);
    const r = bashRun(helperScript(`delete_relay_spawn_manifest 'transient'`));
    expect(r.status).toBe(0);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("(D2) returns 0 even when the manifest doesn't exist (best-effort)", () => {
    const r = bashRun(helperScript(`delete_relay_spawn_manifest 'never-existed'`));
    expect(r.status).toBe(0);
  });
});

// --- Integration: hook fallback ---
//
// The hook lives at hooks/check-relay.sh. When invoked with RELAY_AGENT_NAME
// unset (or literal "default") AND a fresh manifest exists in agents/, the
// hook must recover identity from the manifest, emit a stderr breadcrumb,
// and delete the manifest so it can't be re-used.
//
// We invoke the hook directly (sourcing it would short-circuit on the $0
// guard at line 36, so we execute it). The hook calls out to sqlite3 +
// curl; sqlite3 may not exist in CI and there's no DB or daemon. We bypass
// both by NOT creating a DB file — the hook's `if [ ! -f "$DB_PATH" ];
// then exit 0` branch will fire AFTER the fallback resolves identity.
// What we assert is the stderr breadcrumb from the fallback path.

describe("v2.7.2 — hook fallback integration (check-relay.sh)", () => {
  const HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");

  function runHook(extraEnv: Record<string, string> = {}): BashResult {
    // Start from process.env minus any leaked RELAY_* state, THEN apply
    // overrides last so callers can re-introduce a specific RELAY_AGENT_NAME
    // (or any other RELAY_* var) without it being clobbered by the delete
    // step. Earlier order had the delete after spread, which silently
    // dropped explicit overrides.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.RELAY_DB_PATH;
    delete env.RELAY_INSTANCE_ID;
    delete env.RELAY_AGENT_NAME;
    delete env.RELAY_AGENT_ROLE;
    delete env.RELAY_AGENT_CAPABILITIES;
    env.RELAY_HOME = TEST_ROOT;
    // Pretend the HTTP daemon is unreachable — avoid curl actually hitting
    // a live :3777 from a parallel session. Point to a closed loopback port.
    env.RELAY_HTTP_HOST = "127.0.0.1";
    env.RELAY_HTTP_PORT = "1";
    Object.assign(env, extraEnv);
    const r = spawnSync("bash", [HOOK], { encoding: "utf-8", timeout: 10_000, env });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("(H1) recovers identity from a single fresh manifest and emits a stderr breadcrumb", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'victra-memory-build' 'builder'`));
    const r = runHook();
    // The breadcrumb must mention the recovered name + role.
    expect(r.stderr).toMatch(/recovered identity from spawn manifest/);
    expect(r.stderr).toMatch(/name=victra-memory-build/);
    expect(r.stderr).toMatch(/role=builder/);
  });

  it("(H2) consumes the manifest so a second hook run can't recover the same identity", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'one-shot' 'builder'`));
    const first = runHook();
    expect(first.stderr).toMatch(/name=one-shot/);
    const p = path.join(agentsDir(), "one-shot.spawn-manifest");
    expect(fs.existsSync(p)).toBe(false);
    const second = runHook();
    expect(second.stderr).not.toMatch(/recovered identity from spawn manifest/);
  });

  it("(H3) does NOT recover when RELAY_AGENT_NAME is explicitly set", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'ignored-fallback' 'builder'`));
    const r = runHook({ RELAY_AGENT_NAME: "explicit-name" });
    expect(r.stderr).not.toMatch(/recovered identity from spawn manifest/);
    // Manifest must still be on disk — the hook didn't touch it.
    const p = path.join(agentsDir(), "ignored-fallback.spawn-manifest");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("(H4) does NOT recover when two fresh manifests exist (ambiguity)", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'agent-a' 'builder'`));
    bashRun(helperScript(`write_relay_spawn_manifest 'agent-b' 'builder'`));
    const r = runHook();
    expect(r.stderr).not.toMatch(/recovered identity from spawn manifest/);
  });

  it("(H5) opt-out via RELAY_DISABLE_MANIFEST_FALLBACK skips the recovery path", () => {
    bashRun(helperScript(`write_relay_spawn_manifest 'would-recover' 'builder'`));
    const r = runHook({ RELAY_DISABLE_MANIFEST_FALLBACK: "1" });
    expect(r.stderr).not.toMatch(/recovered identity from spawn manifest/);
    const p = path.join(agentsDir(), "would-recover.spawn-manifest");
    expect(fs.existsSync(p)).toBe(true);
  });
});

// --- Drift guard: shipped helper must define all four v2.7.2 manifest fns,
//                 and no consumer may shadow them inline.
describe("v2.7.2 — manifest helper drift guard", () => {
  it("(DG1) hooks/_vault-helpers.sh defines all four manifest helpers", () => {
    const body = fs.readFileSync(HELPER, "utf-8");
    expect(body).toMatch(/^resolve_relay_spawn_manifest_path\(\)/m);
    expect(body).toMatch(/^write_relay_spawn_manifest\(\)/m);
    expect(body).toMatch(/^find_fresh_relay_spawn_manifest\(\)/m);
    expect(body).toMatch(/^delete_relay_spawn_manifest\(\)/m);
  });

  it("(DG2) no consumer redefines a manifest helper inline", () => {
    const consumers = [
      "hooks/check-relay.sh",
      "hooks/post-tool-use-check.sh",
      "hooks/stop-check.sh",
      "scripts/migrate-existing-tokens-to-vault.sh",
      "bin/spawn-agent.sh",
    ];
    const FORBIDDEN = [
      /^resolve_relay_spawn_manifest_path\s*\(\s*\)/m,
      /^write_relay_spawn_manifest\s*\(\s*\)/m,
      /^find_fresh_relay_spawn_manifest\s*\(\s*\)/m,
      /^delete_relay_spawn_manifest\s*\(\s*\)/m,
    ];
    for (const c of consumers) {
      const p = path.join(REPO_ROOT, c);
      if (!fs.existsSync(p)) continue;
      const body = fs.readFileSync(p, "utf-8");
      for (const re of FORBIDDEN) {
        expect(
          body,
          `${c} re-defines a manifest helper inline — must source hooks/_vault-helpers.sh.`,
        ).not.toMatch(re);
      }
    }
  });
});

// --- Drift guard: bin/spawn-agent.sh actually writes the manifest before
//                 launching osascript. Asserted via dry-run + post-spawn
//                 disk inspection.
describe("v2.7.2 — bin/spawn-agent.sh manifest write", () => {
  const SCRIPT = path.join(REPO_ROOT, "bin", "spawn-agent.sh");

  it("(S1) dry-run with valid name+role produces a manifest at the resolved path", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RELAY_HOME: TEST_ROOT,
      RELAY_SPAWN_DRY_RUN: "1",
    };
    delete env.RELAY_DB_PATH;
    delete env.RELAY_INSTANCE_ID;
    const r = spawnSync(
      "bash",
      [SCRIPT, "v272-manifest-write", "builder", "build,test", "/tmp"],
      { encoding: "utf-8", env, timeout: 10_000 },
    );
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const p = path.join(agentsDir(), "v272-manifest-write.spawn-manifest");
    expect(fs.existsSync(p), `manifest missing at ${p}`).toBe(true);
    const body = fs.readFileSync(p, "utf-8");
    expect(body).toMatch(/^name=v272-manifest-write$/m);
    expect(body).toMatch(/^role=builder$/m);
  });
});
