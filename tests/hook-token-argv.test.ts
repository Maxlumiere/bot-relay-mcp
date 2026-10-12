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
 * the register reply), and a failed recovery printed 200 bytes of the reply. A reply is now NEVER printed, only
 * relay_reply_summary's fixed line, and every entrypoint turns an inherited xtrace off before it reads a credential.
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
import crypto from "crypto";
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
// /bin/bash on purpose: on macOS it is bash 3.2, the shell every user's hooks really run under. RELAY_TEST_BASH
// points the suite at another bash (a bash >= 4.1 honours BASH_XTRACEFD; Linux CI's /bin/bash is bash 5).
const BASH = process.env.RELAY_TEST_BASH ?? "/bin/bash";

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
const { ERROR_CODES } = await import("../src/error-codes.js");

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

/** `fd5`: a file the child gets as descriptor 5 (where an inherited BASH_XTRACEFD=5 sends a trace). */
function run(args: string[], env: Record<string, string>, stdin = "", fd5?: string): Promise<RunResult> {
  fs.rmSync(ARGV_DIR, { recursive: true, force: true });
  fs.mkdirSync(ARGV_DIR);
  seen.length = 0;
  const f5 = fd5 === undefined ? undefined : fs.openSync(fd5, "w");
  return new Promise<RunResult>((resolve, reject) => {
    const stdio: cp.StdioOptions = f5 === undefined ? "pipe" : ["pipe", "pipe", "pipe", "ignore", "ignore", f5];
    const child = cp.spawn(BASH, args, { env: { PATH: SHIM_DIR, ...env }, stdio }) as cp.ChildProcessWithoutNullStreams;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    // 'close', not 'exit': a process can exit while another still holds its stdout, so its output has not drained.
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.end(stdin);
  }).finally(() => {
    if (f5 !== undefined) fs.closeSync(f5);
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

describe("the harness itself: run() returns only after the child's output has drained", () => {
  it("a last chunk written AFTER the shell exits (by a process still holding its stdout) is captured", async () => {
    const r = await run(["-c", "(sleep 0.3; printf late-chunk) & exit 0"], {});
    expect(r.stdout).toBe("late-chunk");
  });
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

/**
 * THE ALLOWLIST, as a grammar: every byte relay_reply_summary may print. A line that matches it carries nothing
 * from the reply except a 3-digit status and a code from the relay's own list, so no credential can ride it.
 */
const SUMMARY = /^HTTP (?:[0-9]{3}|unknown), (?:error_code (?:[A-Z_]+|unlisted|none), [0-9]+ bytes, sha256 [0-9a-f]{12}|unparseable reply \([0-9]+ bytes\)|reply not parsed \([0-9]+ bytes\))$/;

/** No run of `min` or more consecutive characters of `secret` appears in `out` (catches a prefix, suffix or split). */
function expectNoFragment(out: string, secret: string, min = 6): void {
  expect(secret.length, "precondition: a real secret").toBeGreaterThanOrEqual(min);
  const hits: string[] = [];
  for (let i = 0; i + min <= secret.length; i++) if (out.includes(secret.slice(i, i + min))) hits.push(secret.slice(i, i + min));
  expect(hits, `output held a fragment of a secret (${secret.slice(0, 4)}…)`).toEqual([]);
}

describe("the reply summary every print site uses: a fixed line, never the reply", () => {
  function summary(input: string, env: Record<string, string> = {}): Promise<RunResult> {
    return run(["-c", `. '${HELPERS}'; printf '%s' "$IN" | relay_reply_summary`], { IN: input, ...env });
  }
  const SECRET = "abcdefgh12345678";

  it("the allowlist is EXACTLY the relay's error codes (src/error-codes.ts): drift fails here", async () => {
    const r = await run(["-c", `. '${HELPERS}'; printf '%s' "$RELAY_REPLY_ERROR_CODES"`], {});
    expect(r.stdout.split(" ").sort()).toEqual([...Object.values(ERROR_CODES)].sort());
  });

  it("an SSE reply: the status and an allowlisted code nested in the tool's stringified content are named", async () => {
    const reply = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"{\\"error\\":\\"bad ${SECRET}\\",\\"error_code\\":\\"AUTH_FAILED\\"}"}]}}\n\nHTTP_STATUS:200\n`;
    const r = await summary(reply);
    expect(r.stdout).toMatch(/^HTTP 200, error_code AUTH_FAILED, [0-9]+ bytes, sha256 [0-9a-f]{12}\n$/);
    expectNoFragment(r.stdout, SECRET);
  });

  it("a code NOT in the allowlist is `unlisted`, never printed (a credential placed in error_code)", async () => {
    const r = await summary(`{"error_code":"${SECRET}"}`);
    expect(r.stdout).toMatch(/^HTTP unknown, error_code unlisted, /);
    expectNoFragment(r.stdout, SECRET);
  });

  it("a malformed reply is `unparseable reply (N bytes)`, nothing of it printed", async () => {
    const r = await summary(`not json ${SECRET}\nHTTP_STATUS:502\n`);
    expect(r.stdout).toBe(`HTTP 502, unparseable reply (${`not json ${SECRET}`.length} bytes)\n`);
  });

  for (const [label, reply] of [
    ["ESCAPED (a \\u escape inside the credential)", `{"agent_token":"abcd\\u0065fgh12345678","error_code":"AUTH_FAILED"}`],
    ["SPLIT across a line break", `{"error":"echo abcdefgh\\n12345678","error_code":"VALIDATION"}`],
    ["SPLIT across SSE data lines (unparseable)", `data: {"error":"abcdefgh\ndata: 12345678"}`],
  ] as const) {
    it(`an echo ${label}: the line matches the grammar and holds no fragment`, async () => {
      const r = await summary(reply);
      expectNoFragment(r.stdout, SECRET);
      expectNoFragment(r.stdout, "fgh12345678");
      expect(r.stdout.trimEnd()).toMatch(SUMMARY);
    });
  }

  it("the size and hash are of the RAW bytes received (a malformed UTF-8 byte is counted as one byte)", async () => {
    // {"a":"<0xff>"} = 9 bytes; decoded as UTF-8 the 0xff becomes U+FFFD (3 bytes), which would read 11.
    const raw = Buffer.from([...Buffer.from('{"a":"'), 0xff, ...Buffer.from('"}')]);
    const sha = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
    for (const [label, cmd] of [
      ["no status", `printf '{"a":"\\377"}'`],
      ["a status trailer, stripped as bytes", `printf '{"a":"\\377"}\\nHTTP_STATUS:200\\n'`],
    ] as const) {
      const r = await run(["-c", `. '${HELPERS}'; ${cmd} | relay_reply_summary`], {});
      expect(r.stdout, label).toBe(`HTTP ${label === "no status" ? "unknown" : "200"}, error_code none, ${raw.length} bytes, sha256 ${sha}\n`);
    }
  });

  it("without node the line still matches the grammar (bytes only)", async () => {
    const bin = path.join(TEST_DIR, "no-node-bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const t of ["wc", "tr"]) if (!fs.existsSync(path.join(bin, t))) fs.symlinkSync(path.join(SHIM_DIR, t), path.join(bin, t));
    const r = await run(["-c", `PATH='${bin}'; . '${HELPERS}'; printf '%s' "$IN" | relay_reply_summary`], { IN: `{"agent_token":"${SECRET}"}` });
    expect(r.stdout.trimEnd()).toMatch(/^HTTP unknown, reply not parsed \([0-9]+ bytes\)$/);
    expectNoFragment(r.stdout, SECRET);
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
    const line = r.stderr.split("\n").find((l) => l.startsWith("[bot-relay hook debug] register_agent reply: "));
    expect(line, `precondition: the debug dump ran. stderr: ${r.stderr}`).toBeDefined();
    expect(line!.replace("[bot-relay hook debug] register_agent reply: ", "")).toMatch(SUMMARY);
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
    const wrong = "zq" + crypto.randomBytes(16).toString("hex"); // random: no fragment occurs in hook text by chance
    const r = await run([CHECK_RELAY], { ...localEnv(name, home("cr-badticket"), token), RELAY_RECOVERY_TOKEN: wrong });
    const line = r.stderr.split("\n").find((l) => l.includes("Recovery attempt failed"));
    expect(line, `precondition: the failed-recovery branch ran. stderr: ${r.stderr}`).toBeDefined();
    expect(line!.replace(`[relay] Recovery attempt failed for "${name}": `, "")).toMatch(SUMMARY);
    expect(line, "the line names the reply's real HTTP status (curl -w)").toMatch(/: HTTP [0-9]{3}, /);
    for (const s of [wrong, token]) {
      expectNoFragment(r.stderr, s);
      expectNoFragment(r.stdout, s);
    }
    expectNoArgvHolds([token, wrong]);
  });

  for (const [label, echo] of [
    ["ESCAPED", (t: string) => `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"echo: ${t.slice(0, 4)}\\u00${t.charCodeAt(4).toString(16)}${t.slice(5)}"}]}}`],
    ["SPLIT", (t: string) => `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"echo: ${t.slice(0, 12)}\\n${t.slice(12)}"}]}}`],
    ["RAW, past the old 200-byte cut", (t: string) => `{"error":"${"p".repeat(190)}${t}"}`],
  ] as const) {
    it(`a failed recovery whose reply echoes the ticket ${label} prints no fragment of it`, async () => {
      const name = `argv-cr-echo-${label.slice(0, 3).toLowerCase()}`;
      const { token } = revokedWithTicket(name);
      const wrong = "zq" + crypto.randomBytes(16).toString("hex");
      rewrite = (body) => (body.includes(wrong) ? echo(wrong) : null);
      try {
        const r = await run([CHECK_RELAY], { ...localEnv(name, home(`cr-echo-${label.slice(0, 3)}`), token), RELAY_RECOVERY_TOKEN: wrong });
        expect(seen.some((x) => x.reply === echo(wrong)), "precondition: the proxy served the echoing reply").toBe(true);
        const line = r.stderr.split("\n").find((l) => l.includes("Recovery attempt failed"));
        expect(line, `precondition: the failed-recovery branch ran. stderr: ${r.stderr}`).toBeDefined();
        expectNoFragment(r.stderr, wrong);
        expectNoFragment(r.stdout, wrong);
        expect(line!.replace(`[relay] Recovery attempt failed for "${name}": `, "")).toMatch(SUMMARY);
      } finally {
        rewrite = null;
      }
    });
  }

  it("RELAY_HOOK_DEBUG with a reply that REFLECTS the sent registration secret: the secret is never printed", async () => {
    const name = "argv-cr-reflect";
    const secret = mintHeaders(TEST_DB_PATH)["X-Relay-Secret"];
    const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `X-Relay-Secret: ${secret}`, error_code: "MINT_SECRET_REQUIRED" }) }] } });
    rewrite = (body) => (body.includes('"register_agent"') ? reply : null);
    try {
      const r = await run([CHECK_RELAY], { ...localEnv(name, home("cr-reflect")), RELAY_HOOK_DEBUG: "1" });
      const reg = toolCalls("register_agent");
      expect(reg.length, `precondition: register ran. stderr: ${r.stderr}`).toBe(1);
      expect(reg[0].headers["x-relay-secret"], "precondition: the hook SENT the secret the reply reflects").toBe(secret);
      const line = r.stderr.split("\n").find((l) => l.startsWith("[bot-relay hook debug] register_agent reply: "));
      expect(line, `precondition: the debug dump ran. stderr: ${r.stderr}`).toBeDefined();
      expectNoFragment(r.stderr, secret, 8);
      expectNoFragment(r.stdout, secret, 8);
      expect(line!.replace("[bot-relay hook debug] register_agent reply: ", "")).toMatch(/^HTTP 200, error_code MINT_SECRET_REQUIRED, /);
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

/**
 * #319 R2 (3): an INHERITED xtrace must not print a credential. Every entrypoint turns tracing off, as its first
 * statement, before it reads one. Three ways a trace is inherited: `bash -x script`, SHELLOPTS=xtrace in the
 * environment, and SHELLOPTS=xtrace with BASH_XTRACEFD=5 (bash >= 4.1 writes the trace to descriptor 5: a file
 * here). Every output (stdout, stderr, descriptor 5) is checked for every credential the run held.
 */
const TRACE_OFF = [`{ set +x; } 2>/dev/null`, `case "\${BASH_XTRACEFD:-}" in '' | *[!0-9]*) ;; *) [ "$((10#$BASH_XTRACEFD))" -le 2 ] || unset BASH_XTRACEFD ;; esac`];

/** Every script that must turn tracing off first: each hook entrypoint, and each script that sources the vault helpers. */
function traceEntrypoints(): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        const text = fs.readFileSync(f, "utf-8");
        if (!/^#!.*\b(ba)?sh\b/.test(text)) continue;
        const rel = path.relative(REPO_ROOT, f).split(path.sep).join("/");
        if ((rel.startsWith("hooks/") && !path.basename(f).startsWith("_")) || /^\s*(\.|source)\s+\S*_vault-helpers\.sh/m.test(text)) out.add(rel);
      }
    }
  };
  for (const d of ["hooks", "bin", "scripts"]) walk(path.join(REPO_ROOT, d));
  return [...out].sort();
}

describe("#319 R2: every entrypoint turns an inherited trace off FIRST (structural)", () => {
  it("each hook entrypoint and each vault-helpers consumer opens with the trace-off block, before any other statement", () => {
    const eps = traceEntrypoints();
    // precondition: the derivation found the scripts it exists for (a derivation that finds nothing passes vacuously)
    for (const known of ["bin/codex-relay", "bin/spawn-agent.sh", "hooks/check-relay.sh", "hooks/codex/codex-session-start.sh", "hooks/post-tool-use-check.sh", "hooks/stop-check.sh", "scripts/migrate-existing-tokens-to-vault.sh"]) {
      expect(eps).toContain(known);
    }
    const bad: string[] = [];
    for (const rel of eps) {
      const stmts = fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8").split("\n").slice(1).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
      if (stmts[0] !== TRACE_OFF[0] || stmts[1] !== TRACE_OFF[1]) bad.push(`${rel}: first statements are ${JSON.stringify(stmts.slice(0, 2))}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("#319 R2: an inherited trace prints no credential (behavioural)", SLOW, () => {
  type Mode = { label: string; args: (script: string) => string[]; env: Record<string, string>; fd5: boolean };
  const MODES: Mode[] = [
    { label: "bash -x", args: (s) => ["-x", s], env: {}, fd5: false },
    { label: "SHELLOPTS=xtrace", args: (s) => [s], env: { SHELLOPTS: "xtrace" }, fd5: false },
    { label: "SHELLOPTS=xtrace + BASH_XTRACEFD=5", args: (s) => [s], env: { SHELLOPTS: "xtrace", BASH_XTRACEFD: "5" }, fd5: true },
  ];

  /** Precondition per mode: in THIS bash, the mode really traces (a probe script's command shows up in a trace). */
  async function modeTraces(m: Mode): Promise<void> {
    const probe = path.join(TEST_DIR, "trace-probe.sh");
    fs.writeFileSync(probe, "#!/bin/bash\nPROBE_VALUE=tracedprobe\n", { mode: 0o755 });
    const f5 = path.join(TEST_DIR, "probe-fd5");
    const r = await run(m.args(probe), m.env, "", m.fd5 ? f5 : undefined);
    const trace = r.stderr + (m.fd5 ? fs.readFileSync(f5, "utf-8") : "");
    expect(trace, `precondition: ${m.label} traces in ${BASH}`).toContain("PROBE_VALUE=tracedprobe");
  }

  type Case = { label: string; script: string; stdin?: string; setup: () => { env: Record<string, string>; secrets: string[]; site: () => number } };
  const CASES: Case[] = [
    {
      label: "check-relay.sh (token: health_check + register, the mint secret read)",
      script: CHECK_RELAY,
      setup: () => {
        const name = "xt-cr-" + crypto.randomBytes(3).toString("hex");
        const token = dbRegister(name, "tester", []).plaintext_token as string;
        return { env: localEnv(name, home(name), token), secrets: [token, mintHeaders(TEST_DB_PATH)["X-Relay-Secret"]], site: () => toolCalls("register_agent").length };
      },
    },
    {
      label: "check-relay.sh (first spawn: the minted token)",
      script: CHECK_RELAY,
      setup: () => {
        const name = "xt-mint-" + crypto.randomBytes(3).toString("hex");
        return { env: localEnv(name, home(name)), secrets: [mintHeaders(TEST_DB_PATH)["X-Relay-Secret"]], site: () => mintedTokens().length };
      },
    },
    {
      label: "check-relay.sh (recovery: the ticket)",
      script: CHECK_RELAY,
      setup: () => {
        const name = "xt-rec-" + crypto.randomBytes(3).toString("hex");
        const token = dbRegister(name, "tester", []).plaintext_token as string;
        const ticket = revokeAgentToken(name, { issueRecovery: true }).recoveryToken as string;
        return { env: { ...localEnv(name, home(name), token), RELAY_RECOVERY_TOKEN: ticket }, secrets: [token, ticket], site: () => toolCalls("register_agent").filter((c) => c.args.recovery_token !== undefined).length };
      },
    },
    {
      label: "stop-check.sh (remote mail read)",
      script: STOP_HOOK,
      stdin: STOP_STDIN,
      setup: () => {
        const name = "xt-stop-" + crypto.randomBytes(3).toString("hex");
        const token = dbRegister(name, "tester", []).plaintext_token as string;
        return { env: remoteEnv(name, home(name), token), secrets: [token], site: () => toolCalls("get_messages").length };
      },
    },
    {
      label: "post-tool-use-check.sh (remote mail read)",
      script: PTU_HOOK,
      stdin: PTU_STDIN,
      setup: () => {
        const name = "xt-ptu-" + crypto.randomBytes(3).toString("hex");
        const token = dbRegister(name, "tester", []).plaintext_token as string;
        return { env: remoteEnv(name, home(name), token), secrets: [token], site: () => toolCalls("get_messages").length };
      },
    },
    {
      label: "codex-session-start.sh (discover + register)",
      script: CODEX_HOOK,
      stdin: JSON.stringify({ session_id: "c0dec0de-0000-0000-0000-000000000002", hook_event_name: "SessionStart" }),
      setup: () => {
        const name = "xt-cx-" + crypto.randomBytes(3).toString("hex");
        const token = dbRegister(name, "auditor", []).plaintext_token as string;
        return { env: { ...localEnv(name, home(name), token), RELAY_AGENT_ROLE: "auditor", RELAY_LAUNCH_SESSION: "0123abcd-0000-0000-0000-000000000001" }, secrets: [token], site: () => toolCalls("register_agent").length };
      },
    },
  ];

  for (const m of MODES) {
    for (const c of CASES) {
      it(`${m.label}: ${c.label}: no credential in stdout, stderr${m.fd5 ? " or descriptor 5" : ""}`, async () => {
        await modeTraces(m);
        const { env, secrets, site } = c.setup();
        const f5 = path.join(TEST_DIR, "trace-fd5");
        const r = await run(m.args(c.script), { ...env, ...m.env }, c.stdin ?? "", m.fd5 ? f5 : undefined);
        expect(site(), `precondition: the credential-carrying call ran. stderr: ${r.stderr.slice(-2000)}`).toBeGreaterThan(0);
        const all = [...secrets, ...mintedTokens()];
        const outputs = { stdout: r.stdout, stderr: r.stderr, fd5: m.fd5 ? fs.readFileSync(f5, "utf-8") : "" };
        for (const [where, text] of Object.entries(outputs)) for (const sec of all) expect(text.includes(sec), `${where} held a credential (${sec.slice(0, 4)}…)`).toBe(false);
      });
    }
  }

  it("bin/codex-relay under SHELLOPTS=xtrace: no credential in stdout or stderr (Codex itself is stubbed)", async () => {
    await modeTraces(MODES[1]);
    const name = "xt-cxr-" + crypto.randomBytes(3).toString("hex");
    const token = dbRegister(name, "auditor", []).plaintext_token as string;
    const h = home(name);
    const stub = path.join(h, "codex-stub.sh");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env: Record<string, string> = { ...localEnv(name, h, token), RELAY_AGENT_ROLE: "auditor", RELAY_CODEX_LAUNCHER: stub, SHELLOPTS: "xtrace" };
    delete env.RELAY_AGENT_NAME;
    const r = await run([CODEX_RELAY, name], env);
    expect(toolCalls("register_agent").length, `precondition: the launch register ran. stderr: ${r.stderr.slice(-2000)}`).toBe(1);
    for (const sec of [token, mintHeaders(TEST_DB_PATH)["X-Relay-Secret"], ...mintedTokens()]) {
      expect(r.stdout.includes(sec)).toBe(false);
      expect(r.stderr.includes(sec)).toBe(false);
    }
  });

  /**
   * TWIN of the guard: an inherited BASH_XTRACEFD naming stdout or stderr must NOT be unset (that CLOSES it, bash
   * >= 4.1): the hook's own output still arrives. On bash 3.2 (no BASH_XTRACEFD) the hazard cannot occur, and the
   * probe below says so instead of passing silently.
   */
  for (const fd of ["1", "2"]) {
    it(`BASH_XTRACEFD=${fd} inherited: check-relay.sh's stdout and stderr still arrive`, async () => {
      const probe = await run(["-c", `unset BASH_XTRACEFD; echo out-ok; echo err-ok >&2`], { BASH_XTRACEFD: fd });
      const hazard = !(probe.stdout.includes("out-ok") && probe.stderr.includes("err-ok"));
      const [major, minor] = (await run(["-c", 'printf "%s %s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], {})).stdout.split(" ").map(Number);
      // precondition: a bash that honours BASH_XTRACEFD (>= 4.1) shows the hazard (a plain unset closes the descriptor)
      expect(hazard, `bash ${major}.${minor}: did a plain unset close descriptor ${fd}?`).toBe(major > 4 || (major === 4 && minor >= 1));
      const name = "xt-fd" + fd + "-" + crypto.randomBytes(3).toString("hex");
      const token = dbRegister(name, "tester", []).plaintext_token as string;
      const r = await run([CHECK_RELAY], { ...localEnv(name, home(name), token), SHELLOPTS: "xtrace", BASH_XTRACEFD: fd });
      expect(r.stdout, `stdout lost. stderr: ${r.stderr.slice(-1000)}`).toContain("[RELAY]");
      expect(r.stderr.length, "stderr lost").toBeGreaterThan(0);
      expect(r.stdout.includes(token) || r.stderr.includes(token)).toBe(false);
    });
  }
});
