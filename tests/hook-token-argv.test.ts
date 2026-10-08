// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A credential never rides a process's ARGV, and the hooks never PRINT one.
 *
 * THE HARM: a process's argv is readable by every local user (`ps -ww`, /proc/<pid>/cmdline). The hooks passed
 * the agent token to curl as `-H "X-Agent-Token: <token>"` and inside `--data '<json with agent_token>'`, and
 * the recovery token inside `-d`, on every session start, every stop and EVERY tool call. Separately, two
 * stderr paths printed a freshly minted token (recovery with a failed vault write; RELAY_HOOK_DEBUG's dump of
 * the register reply), and a failed recovery printed 200 bytes of the reply.
 *
 * THE MEASUREMENT: every hook runs with a PATH that holds ONLY a shim directory: one wrapper per executable on
 * the real PATH, each appending its own name + argv to a log, then exec'ing the real binary. So the log holds
 * the argv of EVERY process a hook starts by name. A recording proxy sits between the hook and an in-process
 * relay, so each case also proves the TWIN: the credential still REACHES the relay (header or body), via
 * curl's config on stdin. A case whose site never ran fails its precondition (the proxy saw no such call),
 * so no case can pass by not reaching the code it pins.
 *
 * BOUNDARY: a binary started by ABSOLUTE path bypasses the shim (none of the hooks does so for a
 * credential-carrying call; MEASURED by grep at the time of writing, not by this test). Environment variables
 * are NOT argv: the hooks hand tokens to node/python through the environment, readable only by the same user
 * (and root), which is the relay's existing same-user trust boundary.
 *
 * Hooks are spawned ASYNC: the proxy and relay live on this event loop, and a spawnSync would starve them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import cp from "child_process";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";
import { mintHeaders } from "./_helpers/mint.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const HOOKS_DIR = path.join(REPO_ROOT, "hooks");
const HELPERS = path.join(HOOKS_DIR, "_vault-helpers.sh");
const CHECK_RELAY = path.join(HOOKS_DIR, "check-relay.sh");
const STOP_HOOK = path.join(HOOKS_DIR, "stop-check.sh");
const PTU_HOOK = path.join(HOOKS_DIR, "post-tool-use-check.sh");
const CODEX_HOOK = path.join(HOOKS_DIR, "codex", "codex-session-start.sh");
const CODEX_RELAY = path.join(REPO_ROOT, "bin", "codex-relay");
// /bin/bash on purpose: on macOS it is bash 3.2, the shell every user's hooks really run under.
const BASH = "/bin/bash";

const TEST_DIR = path.join(os.tmpdir(), "bot-relay-hook-argv-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_INSTANCE_ID;
process.env.RELAY_WAKE_COVERAGE_STATUS_PATH = path.join(TEST_DIR, "wake-coverage-status.json");

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, registerAgent: dbRegister, revokeAgentToken } = await import("../src/db.js");

// A hook run starts dozens of processes, each through a shim: allow for it.
const SLOW = { timeout: 30_000 };

const SHIM_DIR = path.join(TEST_DIR, "shim");
// One record file PER PROCESS (named by its pid): concurrent processes never interleave a record.
const ARGV_DIR = path.join(TEST_DIR, "argv");

/** One wrapper per executable name on the real PATH (first one wins, as a PATH lookup would). */
function buildShims(): number {
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const seen = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name) || !/^[A-Za-z0-9_.+-]+$/.test(name)) continue;
      const real = path.join(dir, name);
      try {
        const st = fs.statSync(real);
        if (!st.isFile() || (st.mode & 0o111) === 0) continue;
      } catch {
        continue;
      }
      seen.add(name);
      // printf is a /bin/sh builtin, so the wrapper never re-enters the shim. Octal separators (US between
      // fields, RS after a record), not NUL: portable across every /bin/sh printf (dash, bash, zsh-as-sh).
      fs.writeFileSync(
        path.join(SHIM_DIR, name),
        `#!/bin/sh\nprintf '%s\\037' "${name}" "$@" >> '${ARGV_DIR}/'$$\nprintf '\\036' >> '${ARGV_DIR}/'$$\nexec '${real}' "$@"\n`,
        { mode: 0o755 },
      );
    }
  }
  return seen.size;
}

/** Each logged process: [name, ...argv]. (A reused pid appends after the earlier process exited.) */
function loggedProcs(): string[][] {
  const out: string[][] = [];
  for (const f of fs.readdirSync(ARGV_DIR)) {
    const text = fs.readFileSync(path.join(ARGV_DIR, f), "utf-8");
    for (const r of text.split("\x1f\x1e")) if (r.length > 0) out.push(r.split("\x1f"));
  }
  return out;
}

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  reply: string;
}
let relay: HttpServer;
let relayPort = 0;
let proxy: HttpServer;
let proxyPort = 0;
const seen: Seen[] = [];
/** When set and it returns a string, the proxy answers with THAT instead of the relay's reply (still recorded). */
let rewrite: ((body: string) => string | null) | null = null;

/** A transparent recording proxy in front of the real (in-process) relay. */
function startProxy(): Promise<void> {
  proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const headers = { ...req.headers };
      delete headers["content-length"];
      const up = http.request(
        { host: "127.0.0.1", port: relayPort, path: req.url, method: req.method, headers: { ...headers, "content-length": Buffer.byteLength(body) } },
        (ur) => {
          const out: Buffer[] = [];
          ur.on("data", (c) => out.push(c));
          ur.on("end", () => {
            const real = Buffer.concat(out).toString("utf-8");
            const forced = rewrite ? rewrite(body) : null;
            const reply = forced ?? real;
            seen.push({ url: req.url ?? "", headers: req.headers, body, reply });
            const h = { ...ur.headers };
            if (forced !== null) {
              delete h["content-length"];
              h["content-type"] = "application/json";
            }
            res.writeHead(ur.statusCode ?? 502, h);
            res.end(reply);
          });
        },
      );
      up.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      up.end(body);
    });
  });
  return new Promise((r) => proxy.listen(0, "127.0.0.1", () => r()));
}

/** Calls to one MCP tool the proxy saw, with the tool's arguments parsed out of the body. */
function toolCalls(tool: string): Array<Seen & { args: Record<string, unknown> }> {
  const out: Array<Seen & { args: Record<string, unknown> }> = [];
  for (const s of seen) {
    if (s.url !== "/mcp") continue;
    try {
      const j = JSON.parse(s.body);
      if (j?.params?.name === tool) out.push({ ...s, args: j.params.arguments ?? {} });
    } catch {
      /* not JSON: not a tool call */
    }
  }
  return out;
}

/** Every token-shaped `agent_token` value in the replies the proxy relayed (what the relay MINTED). */
function mintedTokens(): string[] {
  const out: string[] = [];
  for (const s of seen) for (const m of s.reply.matchAll(/agent_token\\*"\s*:\s*\\*"([A-Za-z0-9_=.-]{8,128})/g)) out.push(m[1]);
  return out;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>, stdin = ""): Promise<RunResult> {
  fs.rmSync(ARGV_DIR, { recursive: true, force: true });
  fs.mkdirSync(ARGV_DIR);
  seen.length = 0;
  return new Promise((resolve, reject) => {
    const child = cp.spawn(BASH, args, { env: { PATH: SHIM_DIR, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.end(stdin);
  });
}

/** THE HARM, refused: no process the run started held any of `secrets` in its argv. */
function expectNoArgvHolds(secrets: string[]): void {
  const procs = loggedProcs();
  expect(procs.filter((p) => p[0] === "curl").length, "precondition: the shim saw curl run").toBeGreaterThan(0);
  for (const secret of secrets) {
    expect(secret.length, "precondition: a real secret").toBeGreaterThanOrEqual(8);
    const holders = procs.filter((p) => p.some((a) => a.includes(secret))).map((p) => p.join(" "));
    expect(holders, `argv held a secret (${secret.slice(0, 4)}…)`).toEqual([]);
  }
}

function home(tag: string): string {
  const h = path.join(TEST_DIR, "home-" + tag);
  fs.mkdirSync(h, { recursive: true });
  return h;
}

/** A local-mode hook env: the test DB, the vault under the sandbox HOME, HTTP through the recording proxy. */
function localEnv(name: string, h: string, token?: string): Record<string, string> {
  return {
    HOME: h,
    RELAY_HOME: h,
    RELAY_DB_PATH: TEST_DB_PATH,
    RELAY_AGENT_NAME: name,
    RELAY_AGENT_ROLE: "tester",
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(proxyPort),
    RELAY_HOOK_NOTICE_REMIND_SECS: "0",
    RELAY_STOP_WAKE_DAMPER_SECS: "0",
    ...(token ? { RELAY_AGENT_TOKEN: token } : {}),
  };
}

/** A remote-mode env: a HOME with no relay instance at all, the relay reachable only over HTTP. */
function remoteEnv(name: string, h: string, token: string): Record<string, string> {
  return {
    HOME: h,
    RELAY_AGENT_NAME: name,
    RELAY_AGENT_TOKEN: token,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(proxyPort),
    RELAY_HOOK_NOTICE_REMIND_SECS: "0",
    RELAY_STOP_WAKE_DAMPER_SECS: "0",
  };
}

const PTU_STDIN = JSON.stringify({ session_id: "a1a1a1a1-0000-0000-0000-000000000001", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: {} });
const STOP_STDIN = JSON.stringify({ session_id: "a1a1a1a1-0000-0000-0000-000000000002", stop_hook_active: false });

beforeAll(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  expect(buildShims(), "precondition: shims built").toBeGreaterThan(20);
  relay = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const a = relay.address();
  relayPort = typeof a === "object" && a ? a.port : 0;
  await startProxy();
  const p = proxy.address();
  proxyPort = typeof p === "object" && p ? p.port : 0;
});

afterAll(() => {
  relay?.close();
  proxy?.close();
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("the curl-config helper: a value reaches the server byte-exact, and can never add a directive", () => {
  /** Run the helper under bash 3.2 (macOS /bin/bash), piping its output to curl -K - against the proxy. */
  function viaConfig(key: string, value: string): Promise<RunResult> {
    return run(["-c", `. '${HELPERS}'; relay_curl_config_line "$K" "$V" | curl -s -m 5 -K - -X POST "http://127.0.0.1:${proxyPort}/echo" -H 'Content-Type: text/plain' >/dev/null; echo "rc=\${PIPESTATUS[0]}"`], { K: key, V: value });
  }

  it("a quote and a backslash are escaped: the server receives the value EXACTLY (no directive injected)", async () => {
    const value = `a"b\\c" -o "/tmp/never" \\" end`;
    const r = await viaConfig("data", value);
    expect(r.stdout.trim()).toBe("rc=0");
    const hit = seen.filter((s) => s.url === "/echo");
    expect(hit.length, "precondition: curl sent the request").toBe(1);
    expect(hit[0].body).toBe(value);
  });

  it("a header value round-trips the same way", async () => {
    const r = await viaConfig("header", `X-Agent-Token: tok_ABC.def-123=`);
    expect(r.stdout.trim()).toBe("rc=0");
    expect(seen.find((s) => s.url === "/echo")?.headers["x-agent-token"]).toBe("tok_ABC.def-123=");
  });

  for (const [label, bad] of [["LF", "line1\nurl = \"http://127.0.0.1:1/x\""], ["CR", "line1\rmore"]] as const) {
    it(`a value holding ${label} is REFUSED: nothing printed, non-zero status`, async () => {
      const r = await run(["-c", `. '${HELPERS}'; out=$(relay_curl_config_line data "$V"); rc=$?; printf 'rc=%s len=%s' "$rc" "\${#out}"`], { V: bad });
      expect(r.stdout).toBe("rc=1 len=0");
    });
  }
});

describe("the redactor every print site uses", () => {
  function redact(input: string, ...secrets: string[]): Promise<RunResult> {
    return run(["-c", `. '${HELPERS}'; printf '%s' "$IN" | relay_redact "$@"`, "redact", ...secrets], { IN: input });
  }

  it("a known secret is replaced wherever it appears, glob characters taken literally", async () => {
    const secret = "S3cr*t[x]?_value";
    const r = await redact(`before ${secret} middle ${secret} after; S3crXt_value stays`, secret);
    expect(r.stdout).toBe("before <redacted> middle <redacted> after; S3crXt_value stays\n");
  });

  it("an UNKNOWN credential is replaced by its field name, escaped (the SSE-wrapped reply) or not", async () => {
    const r = await redact(`{"agent_token":"aaaaaaaaaa","x":"keep"} and \\"recovery_token\\": \\"bbbbbbbbbb\\", \\"mint_secret\\":\\"cccccccccc\\"`);
    expect(r.stdout).not.toMatch(/aaaaaaaaaa|bbbbbbbbbb|cccccccccc/);
    expect(r.stdout).toContain(`"x":"keep"`);
  });

  it("short or empty arguments are ignored (they would redact common text)", async () => {
    const r = await redact("a b c", "", "a");
    expect(r.stdout).toBe("a b c\n");
  });

});

describe("check-relay.sh (SessionStart)", SLOW, () => {
  it("health_check + re-register: the agent token reaches the relay as a header, and no argv held it", async () => {
    const name = "argv-cr-reg";
    const token = dbRegister(name, "tester", []).plaintext_token as string;
    const r = await run([CHECK_RELAY], localEnv(name, home("cr-reg"), token));
    const health = toolCalls("health_check");
    const reg = toolCalls("register_agent");
    expect(health.length, `precondition: health_check ran. stderr: ${r.stderr}`).toBeGreaterThan(0);
    expect(reg.length, `precondition: register_agent ran. stderr: ${r.stderr}`).toBeGreaterThan(0);
    expect(health[0].headers["x-agent-token"]).toBe(token);
    expect(reg[0].headers["x-agent-token"]).toBe(token);
    expectNoArgvHolds([token]);
  });

  it("first spawn under RELAY_HOOK_DEBUG: the minted token is vaulted, and NOT printed", async () => {
    const name = "argv-cr-debug";
    const h = home("cr-debug");
    const r = await run([CHECK_RELAY], { ...localEnv(name, h), RELAY_HOOK_DEBUG: "1" });
    const minted = mintedTokens();
    expect(minted.length, `precondition: the relay minted a token. stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr, "precondition: the debug dump ran").toContain("register_agent response");
    expect(r.stderr).not.toContain(minted[0]);
    expect(r.stdout).not.toContain(minted[0]);
  });

  /** Register `name`, then revoke it with a recovery ticket: health_check now says recovery_pending. */
  function revokedWithTicket(name: string): { token: string; ticket: string } {
    const token = dbRegister(name, "tester", []).plaintext_token as string;
    const ticket = revokeAgentToken(name, { issueRecovery: true }).recoveryToken as string;
    expect(ticket).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
    return { token, ticket };
  }

  it("recovery: the recovery token reaches the relay in the body, no argv held it or the agent token", async () => {
    const name = "argv-cr-recover";
    const { token, ticket } = revokedWithTicket(name);
    const r = await run([CHECK_RELAY], { ...localEnv(name, home("cr-recover"), token), RELAY_RECOVERY_TOKEN: ticket });
    const rec = toolCalls("register_agent").filter((c) => c.args.recovery_token !== undefined);
    expect(rec.length, `precondition: the recovery register ran. stderr: ${r.stderr}`).toBe(1);
    expect(rec[0].args.recovery_token).toBe(ticket);
    expect(mintedTokens().length, "precondition: recovery minted a fresh token").toBeGreaterThan(0);
    expectNoArgvHolds([token, ticket]);
  });

  it("recovery whose vault write FAILS: the fresh token is NOT printed (it would land in the session transcript)", async () => {
    const name = "argv-cr-novault";
    const { token, ticket } = revokedWithTicket(name);
    const h = home("cr-novault");
    // The vault lives at dirname(DB)/agents. Give the hook the SAME database under another directory whose
    // `agents` is a FILE: mkdir and the write then fail for every user, root included.
    const alt = path.join(h, "inst");
    fs.mkdirSync(alt);
    fs.symlinkSync(TEST_DB_PATH, path.join(alt, "relay.db"));
    fs.writeFileSync(path.join(alt, "agents"), "not a directory");
    const env = { ...localEnv(name, h, token), RELAY_DB_PATH: path.join(alt, "relay.db"), RELAY_RECOVERY_TOKEN: ticket };
    const r = await run([CHECK_RELAY], env);
    const minted = mintedTokens();
    expect(minted.length, `precondition: recovery minted a fresh token. stderr: ${r.stderr}`).toBeGreaterThan(0);
    expect(r.stderr, "precondition: the vault-write-failed branch ran").toMatch(/vault write failed/);
    for (const t of minted) {
      expect(r.stderr).not.toContain(t);
      expect(r.stdout).not.toContain(t);
    }
  });

  it("a FAILED recovery prints no part of either credential", async () => {
    const name = "argv-cr-badticket";
    const { token } = revokedWithTicket(name);
    const wrong = "wrongticket_" + "x".repeat(24);
    const r = await run([CHECK_RELAY], { ...localEnv(name, home("cr-badticket"), token), RELAY_RECOVERY_TOKEN: wrong });
    expect(r.stderr, `precondition: the failed-recovery branch ran`).toMatch(/Recovery attempt failed/);
    expect(r.stderr).not.toContain(wrong);
    expect(r.stderr).not.toContain(token);
    expectNoArgvHolds([token, wrong]);
  });

  it("a failed recovery whose reply ECHOES the ticket across the 200-byte cut prints no part of it", async () => {
    const name = "argv-cr-echo";
    const { token } = revokedWithTicket(name);
    const wrong = "echoedticket_" + "y".repeat(24);
    // The reply's first 200 bytes end INSIDE the ticket: cutting before redacting would print its prefix,
    // which no longer matches the whole secret. A non-token field name, so only the value match can catch it.
    const head = `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"echo: `;
    const reply = head + "p".repeat(190 - head.length) + wrong + `"}]}}`;
    rewrite = (body) => (body.includes(wrong) ? reply : null);
    try {
      const r = await run([CHECK_RELAY], { ...localEnv(name, home("cr-echo"), token), RELAY_RECOVERY_TOKEN: wrong });
      expect(r.stderr, "precondition: the failed-recovery branch printed the reply").toMatch(/Recovery attempt failed.*Response: \{"jsonrpc"/);
      expect(r.stderr).not.toContain(wrong.slice(0, 10));
    } finally {
      rewrite = null;
    }
  });

  it("remote mode (no local instance): the mail read carries the token in header and body, no argv held it", async () => {
    const name = "argv-cr-remote";
    const token = dbRegister(name, "tester", []).plaintext_token as string;
    const r = await run([CHECK_RELAY], remoteEnv(name, home("cr-remote"), token));
    const reads = toolCalls("get_messages");
    expect(reads.length, `precondition: the remote mail read ran. stderr: ${r.stderr}`).toBe(1);
    expect(reads[0].headers["x-agent-token"]).toBe(token);
    expect(reads[0].args.agent_token).toBe(token);
    expectNoArgvHolds([token]);
  });
});

describe("stop-check.sh (Stop) and post-tool-use-check.sh (every tool call)", SLOW, () => {
  for (const [label, hook, stdin] of [["Stop", STOP_HOOK, STOP_STDIN], ["PostToolUse", PTU_HOOK, PTU_STDIN]] as const) {
    it(`${label}, remote mail read: the token reaches the relay in header and body, no argv held it`, async () => {
      const name = `argv-${label.toLowerCase()}-remote`;
      const token = dbRegister(name, "tester", []).plaintext_token as string;
      const r = await run([hook], remoteEnv(name, home(`${label}-remote`), token), stdin);
      const reads = toolCalls("get_messages");
      expect(reads.length, `precondition: the remote mail read ran. stderr: ${r.stderr}`).toBe(1);
      expect(reads[0].headers["x-agent-token"]).toBe(token);
      expect(reads[0].args.agent_token).toBe(token);
      expectNoArgvHolds([token]);
    });
  }

  it("PostToolUse liveness restamp: report_liveness carries the token in header and body, no argv held it", async () => {
    const name = "argv-ptu-liveness";
    const token = dbRegister(name, "tester", []).plaintext_token as string;
    // A stored anchor that is NOT this hook's process, so the self-heal fires.
    getDb().prepare("UPDATE agents SET agent_pid = 999999, agent_pid_start = 'never' WHERE name = ?").run(name);
    const r = await run([PTU_HOOK], localEnv(name, home("ptu-live"), token), PTU_STDIN);
    const calls = toolCalls("report_liveness");
    expect(calls.length, `precondition: the restamp ran. stderr: ${r.stderr}`).toBe(1);
    expect(calls[0].headers["x-agent-token"]).toBe(token);
    expect(calls[0].args.agent_token).toBe(token);
    expectNoArgvHolds([token]);
  });
});

describe("Codex: hooks/codex/codex-session-start.sh and bin/codex-relay", SLOW, () => {
  it("SessionStart with a launch marker: discover_agents AND register_agent carry the token as a header, no argv held it", async () => {
    const name = "argv-codex-hook";
    const token = dbRegister(name, "auditor", []).plaintext_token as string;
    const env = { ...localEnv(name, home("codex-hook"), token), RELAY_AGENT_ROLE: "auditor", RELAY_LAUNCH_SESSION: "0123abcd-0000-0000-0000-000000000000" };
    const r = await run([CODEX_HOOK], env, JSON.stringify({ session_id: "c0dec0de-0000-0000-0000-000000000001", hook_event_name: "SessionStart" }));
    const disc = toolCalls("discover_agents");
    const reg = toolCalls("register_agent");
    expect(disc.length, `precondition: discover ran. stderr: ${r.stderr}`).toBe(1);
    expect(reg.length, `precondition: register ran. stderr: ${r.stderr}`).toBe(1);
    expect(disc[0].headers["x-agent-token"]).toBe(token);
    expect(reg[0].headers["x-agent-token"]).toBe(token);
    expectNoArgvHolds([token]);
  });

  it("the launcher's launch register carries the token as a header, no argv held it (Codex itself is stubbed)", async () => {
    const name = "argv-codex-launch";
    const token = dbRegister(name, "auditor", []).plaintext_token as string;
    const h = home("codex-launch");
    const stub = path.join(h, "codex-stub.sh");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { ...localEnv(name, h, token), RELAY_AGENT_ROLE: "auditor", RELAY_CODEX_LAUNCHER: stub };
    delete (env as Record<string, string>).RELAY_AGENT_NAME;
    const r = await run([CODEX_RELAY, name], env);
    const reg = toolCalls("register_agent");
    expect(reg.length, `precondition: the launch register ran. stderr: ${r.stderr}`).toBe(1);
    expect(reg[0].headers["x-agent-token"]).toBe(token);
    expectNoArgvHolds([token]);
  });
});

describe("the mint secret is still sent (no regression of PR-D's stdin config)", SLOW, () => {
  it("a first spawn presents the registration secret and gets registered", async () => {
    const name = "argv-cr-mint";
    const r = await run([CHECK_RELAY], localEnv(name, home("cr-mint")));
    const reg = toolCalls("register_agent");
    expect(reg.length, `precondition: register ran. stderr: ${r.stderr}`).toBe(1);
    expect(reg[0].headers["x-relay-secret"]).toBe(mintHeaders(TEST_DB_PATH)["X-Relay-Secret"]);
    expect(mintedTokens().length).toBe(1);
    expectNoArgvHolds([mintHeaders(TEST_DB_PATH)["X-Relay-Secret"]]);
  });
});
