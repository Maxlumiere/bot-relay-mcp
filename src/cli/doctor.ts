// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — `relay doctor` subcommand.
 *
 * Diagnostic sweep over the relay's local state. PASS / WARN / FAIL per
 * check; exit 0 iff zero FAILs (WARNs are advisory).
 */
import fs from "fs";
import path from "path";
import os from "os";
import { resolveInstanceDbPath, resolveInstanceConfigPath } from "../instance.js";

type Status = "PASS" | "WARN" | "FAIL";
interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

// v2.4.5: route through the canonical per-instance resolvers so `relay doctor`
// describes the SAME paths the running daemon + stdio server actually use.
// Pre-v2.4.5 this hardcoded the legacy ~/.bot-relay/relay.db, which on a
// per-instance setup printed correct PASS/WARN against the wrong file —
// hiding the very split-brain doctor exists to surface.
function getDbPath(): string {
  return resolveInstanceDbPath();
}

function getConfigPath(): string {
  return resolveInstanceConfigPath();
}

async function checkConfig(): Promise<CheckResult> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    return { name: "config.json", status: "WARN", detail: `not present at ${p} (defaults will be used)` };
  }
  try {
    const raw = fs.readFileSync(p, "utf-8");
    JSON.parse(raw);
  } catch (err) {
    return { name: "config.json", status: "FAIL", detail: `unparseable: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const { validateConfigAndEnv, loadConfig } = await import("../config.js");
    validateConfigAndEnv(loadConfig());
    return { name: "config.json", status: "PASS", detail: `valid (${p})` };
  } catch (err) {
    return { name: "config.json", status: "FAIL", detail: `validation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkDb(): Promise<CheckResult[]> {
  const p = getDbPath();
  const results: CheckResult[] = [];
  if (!fs.existsSync(p)) {
    results.push({ name: "relay.db", status: "WARN", detail: `not present at ${p} (will be created on first run)` });
    return results;
  }
  try {
    const { initializeDb, getSchemaVersion, CURRENT_SCHEMA_VERSION } = await import("../db.js");
    await initializeDb();
    const v = getSchemaVersion();
    if (v === CURRENT_SCHEMA_VERSION) {
      results.push({ name: "schema_info", status: "PASS", detail: `version=${v} (matches CURRENT_SCHEMA_VERSION)` });
    } else {
      results.push({
        name: "schema_info",
        status: "FAIL",
        detail: `DB at version ${v}, code expects ${CURRENT_SCHEMA_VERSION} — migration needed`,
      });
    }
  } catch (err) {
    results.push({
      name: "schema_info",
      status: "FAIL",
      detail: `could not read schema_info: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return results;
}

function checkPerms(): CheckResult[] {
  if (process.platform === "win32") {
    return [{ name: "file perms", status: "WARN", detail: "Windows NTFS — POSIX mode bits not applicable" }];
  }
  const p = getDbPath();
  const dir = path.dirname(p);
  const results: CheckResult[] = [];
  if (fs.existsSync(dir)) {
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode === 0o700) {
      results.push({ name: `dir perms (${dir})`, status: "PASS", detail: "0700" });
    } else {
      results.push({ name: `dir perms (${dir})`, status: "WARN", detail: `0${mode.toString(8)} (recommended 0700; run: chmod 700 "${dir}")` });
    }
  }
  if (fs.existsSync(p)) {
    const mode = fs.statSync(p).mode & 0o777;
    if (mode === 0o600) {
      results.push({ name: `db perms (${p})`, status: "PASS", detail: "0600" });
    } else {
      results.push({ name: `db perms (${p})`, status: "WARN", detail: `0${mode.toString(8)} (recommended 0600; run: chmod 600 "${p}")` });
    }
  }
  return results;
}

async function checkDiskSpace(): Promise<CheckResult> {
  try {
    const p = getDbPath();
    const dir = fs.existsSync(path.dirname(p)) ? path.dirname(p) : os.tmpdir();
    // fs.statfsSync exists on Node 18.15+. Best-effort.
    const anyFs = fs as any;
    if (typeof anyFs.statfsSync === "function") {
      const st = anyFs.statfsSync(dir);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      if (freeBytes < 100 * 1024 * 1024) {
        return {
          name: "disk space",
          status: "WARN",
          detail: `only ${Math.floor(freeBytes / 1024 / 1024)} MB free on ${dir} (recommended >100 MB)`,
        };
      }
      return { name: "disk space", status: "PASS", detail: `${Math.floor(freeBytes / 1024 / 1024)} MB free on ${dir}` };
    }
    return { name: "disk space", status: "WARN", detail: "fs.statfsSync unavailable (Node < 18.15)" };
  } catch (err) {
    return { name: "disk space", status: "WARN", detail: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkDaemon(): Promise<CheckResult> {
  const port = parseInt(process.env.RELAY_HTTP_PORT || "3777", 10);
  const host = process.env.RELAY_HTTP_HOST || "127.0.0.1";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(`http://${host}:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = (await res.json()) as { version?: string; protocol_version?: string };
      return {
        name: "daemon /health",
        status: "PASS",
        detail: `responding on http://${host}:${port} (version=${data.version ?? "?"}, protocol_version=${data.protocol_version ?? "?"})`,
      };
    }
    return { name: "daemon /health", status: "WARN", detail: `http://${host}:${port}/health returned ${res.status}` };
  } catch {
    return { name: "daemon /health", status: "WARN", detail: `not running on http://${host}:${port} (that may be intentional)` };
  }
}

function checkHooks(): CheckResult {
  const p = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(p)) {
    return { name: "Claude Code hooks", status: "WARN", detail: `~/.claude/settings.json not found — run: relay generate-hooks --full > ${p}` };
  }
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const cfg = JSON.parse(raw);
    const seen: string[] = [];
    const hooks = cfg?.hooks;
    if (hooks?.SessionStart) seen.push("SessionStart");
    if (hooks?.PostToolUse) seen.push("PostToolUse");
    if (hooks?.Stop) seen.push("Stop");
    if (seen.length === 3) {
      return { name: "Claude Code hooks", status: "PASS", detail: "SessionStart + PostToolUse + Stop all configured" };
    }
    return { name: "Claude Code hooks", status: "WARN", detail: `only ${seen.join(", ") || "none"} configured (missing: ${["SessionStart", "PostToolUse", "Stop"].filter((h) => !seen.includes(h)).join(", ")})` };
  } catch (err) {
    return { name: "Claude Code hooks", status: "WARN", detail: `parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * v2.1 Phase 7r — remote-hub diagnostic probe.
 *
 * Replaces the local-install checks with a network probe of a remote
 * bot-relay-mcp hub: reachability, version + protocol_version, optional
 * token validity check, and a capability-gate snapshot. Used from
 * `relay doctor --remote <hub-url>` after an operator runs `relay pair`.
 *
 * Never touches the local DB or config — this is strictly a client-side
 * probe. Exit 0 iff every check PASS (WARN is advisory, FAIL sinks the
 * overall status).
 */
async function remoteDoctor(hubUrlRaw: string): Promise<number> {
  let hubUrl: URL;
  try {
    hubUrl = new URL(hubUrlRaw);
    if (hubUrl.protocol !== "http:" && hubUrl.protocol !== "https:") {
      process.stderr.write(`relay doctor: --remote URL must be http:// or https:// (got ${hubUrl.protocol})\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`relay doctor: malformed --remote URL: ${hubUrlRaw}\n`);
    return 1;
  }
  const base = `${hubUrl.protocol}//${hubUrl.host}`;
  const results: CheckResult[] = [];

  // 1. Reachability + /health body.
  interface HealthBody {
    version?: string;
    protocol_version?: string;
    auth_required?: boolean;
  }
  let health: HealthBody | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      results.push({
        name: `hub ${base}/health`,
        status: "FAIL",
        detail: `HTTP ${res.status}`,
      });
    } else {
      health = (await res.json()) as HealthBody;
      results.push({
        name: `hub ${base}/health`,
        status: "PASS",
        detail: `responding (version=${health?.version ?? "?"}, protocol_version=${health?.protocol_version ?? "?"})`,
      });
    }
  } catch (err) {
    results.push({
      name: `hub ${base}/health`,
      status: "FAIL",
      detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 2. Protocol-version compatibility check (client vs hub).
  // Load the client's PROTOCOL_VERSION constant + compare the MAJOR segment
  // to the hub's. Matching major = compatible; mismatch = FAIL.
  if (health?.protocol_version) {
    try {
      const { PROTOCOL_VERSION: clientProto } = await import("../protocol.js");
      const clientMajor = clientProto.split(".")[0];
      const hubMajor = health.protocol_version.split(".")[0];
      if (clientMajor === hubMajor) {
        results.push({
          name: "protocol compatibility",
          status: "PASS",
          detail: `client=${clientProto}, hub=${health.protocol_version} (same major)`,
        });
      } else {
        results.push({
          name: "protocol compatibility",
          status: "FAIL",
          detail: `client=${clientProto}, hub=${health.protocol_version} (different major — upgrade one side)`,
        });
      }
    } catch {
      /* protocol.js unreadable — skip this check silently */
    }
  }

  // 3. Optional token-validity check if operator set RELAY_AGENT_TOKEN.
  const token = process.env.RELAY_AGENT_TOKEN;
  if (token) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Agent-Token": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "health_check", arguments: {} },
        }),
      });
      clearTimeout(t);
      const text = await res.text();
      const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
      const rpcResp = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text || "{}");
      const body = rpcResp?.result?.content?.[0]?.text
        ? JSON.parse(rpcResp.result.content[0].text)
        : rpcResp;
      if (body?.auth_error === true) {
        results.push({
          name: "token auth",
          status: "FAIL",
          detail: `RELAY_AGENT_TOKEN rejected by hub: ${body.error ?? "unknown"}`,
        });
      } else if (body?.status === "ok") {
        const agent = body.agent_name ?? "(unnamed)";
        const state = body.auth_state ?? "(unknown)";
        results.push({
          name: "token auth",
          status: "PASS",
          detail: `accepted (agent=${agent}, auth_state=${state})`,
        });
      } else {
        results.push({
          name: "token auth",
          status: "WARN",
          detail: `unexpected health_check response (status=${res.status})`,
        });
      }
    } catch (err) {
      results.push({
        name: "token auth",
        status: "WARN",
        detail: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    results.push({
      name: "token auth",
      status: "WARN",
      detail: "RELAY_AGENT_TOKEN unset — skipping (set env + re-run to verify)",
    });
  }

  // 4. Capability snapshot: the hub's /health doesn't expose the cap catalog
  // (that's server-side config), but we can flag whether the hub is
  // configured to require a shared secret (reflected in health.auth_required).
  if (health?.auth_required === true) {
    results.push({
      name: "hub auth config",
      status: "PASS",
      detail: "hub requires RELAY_HTTP_SECRET (defense-in-depth)",
    });
  } else if (health?.auth_required === false) {
    results.push({
      name: "hub auth config",
      status: "WARN",
      detail: "hub accepts unauthenticated connections (no RELAY_HTTP_SECRET) — fine for loopback, risky for internet-exposed hubs",
    });
  }

  process.stdout.write(`=== relay doctor --remote ${base} ===\n`);
  let failCount = 0;
  for (const r of results) {
    const tag = r.status === "PASS" ? "  PASS " : r.status === "WARN" ? "  WARN " : "  FAIL ";
    process.stdout.write(`${tag}${r.name}: ${r.detail}\n`);
    if (r.status === "FAIL") failCount += 1;
  }
  process.stdout.write(`\nResult: ${failCount === 0 ? "healthy" : `${failCount} failure(s)`}\n`);
  return failCount === 0 ? 0 : 1;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: relay doctor [--remote HUB_URL]\n\n" +
        "Default mode runs diagnostic checks on the local relay install.\n" +
        "--remote HUB_URL probes a remote hub instead (reachability, protocol\n" +
        "compatibility, token auth if RELAY_AGENT_TOKEN is set, auth config).\n"
    );
    return 0;
  }

  // v2.1 Phase 7r: --remote <url> mode. Short-circuits the local-install checks.
  const remoteIdx = argv.indexOf("--remote");
  if (remoteIdx !== -1) {
    const hubUrl = argv[remoteIdx + 1];
    if (!hubUrl) {
      process.stderr.write("relay doctor: --remote requires a URL argument\n");
      return 1;
    }
    return await remoteDoctor(hubUrl);
  }

  const results: CheckResult[] = [];
  results.push(await checkConfig());
  results.push(...(await checkDb()));
  results.push(...checkPerms());
  results.push(await checkDiskSpace());
  results.push(await checkDaemon());
  results.push(checkHooks());

  process.stdout.write("=== relay doctor ===\n");
  let failCount = 0;
  for (const r of results) {
    const tag = r.status === "PASS" ? "  PASS " : r.status === "WARN" ? "  WARN " : "  FAIL ";
    process.stdout.write(`${tag}${r.name}: ${r.detail}\n`);
    if (r.status === "FAIL") failCount += 1;
  }
  process.stdout.write(`\nResult: ${failCount === 0 ? "healthy" : `${failCount} failure(s)`}\n`);
  // Close any DB we opened during the check.
  try {
    const { closeDb } = await import("../db.js");
    closeDb();
  } catch {
    /* ignore */
  }
  return failCount === 0 ? 0 : 1;
}
