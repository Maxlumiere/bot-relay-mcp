// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 — the DEPLOY GATE (`relay deploy-gate`, src/deploy-gate.ts): before a
 * daemon restarts onto a NEW build, prove the new resolver, fed the environment
 * the restarted daemon will get, names the DB the running daemon holds open.
 *
 * macOS: the environment comes ONLY from `launchctl print` of the loaded job
 * (never `ps -E`, whose space-joined output has no entry boundaries), parsed
 * FAIL-CLOSED; the plist file must still carry the same resolver keys; the job's
 * pid must be the :PORT listener; the new resolver's DB must be among the files
 * that pid holds open (real paths, no filename heuristic).
 * Three outcomes: 0 PASS · 1 FAIL · 3 CANNOT-VERIFY.
 *
 * Every system call is an injected dep: these rows never touch the real launchd.
 * The new resolver itself runs for real (`bin/relay where --json`, needs dist).
 * Secrets: only RESOLVER_ENV_KEYS values may ever be printed.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { runGate, defaultGateDeps, formatGate, parseLaunchctlPrint, type GateDeps } from "../src/deploy-gate.js";
import { RESOLVER_ENV_KEYS } from "../src/instance.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048g-")));
const H = path.join(ROOT, "home");
const RH = path.join(H, ".bot-relay");
const PID = 4242;
const PLIST = "/Users/example/Library/LaunchAgents/com.example.relay.plist";
const SECRET = "synthetic-secret-value";
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type Env = Record<string, string>;
/** A `launchctl print` rendering: values are written RAW, exactly as launchctl does. */
function lcText(o: { env: Env; inherited?: Env; dflt?: Env; pid?: number | null; state?: string; extra?: string }): string {
  const sec = (name: string, e: Env) => [`\t${name} = {`, ...Object.entries(e).map(([k, v]) => `\t\t${k} => ${v}`), "\t}", ""];
  return [
    "gui/501/com.example.relay = {",
    "\tactive count = 1",
    `\tpath = ${PLIST}`,
    "\ttype = LaunchAgent",
    `\tstate = ${o.state ?? "running"}`,
    "",
    "\tprogram = /usr/local/bin/node",
    "\targuments = {",
    "\t\t/usr/local/bin/node",
    "\t\t/opt/relay/dist/index.js",
    "\t}",
    "",
    ...sec("inherited environment", o.inherited ?? { SSH_AUTH_SOCK: "/private/tmp/launch-x/Listeners" }),
    ...sec("default environment", o.dflt ?? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }),
    ...sec("environment", o.env),
    o.extra ?? "",
    "\tdomain = gui/501 [100005]",
    ...(o.pid === null ? [] : [`\tpid = ${o.pid ?? PID}`]),
    "\timmediate reason = inefficient",
    "}",
    "",
  ].join("\n");
}

/** Fake deps around the REAL new resolver (runWhere) and real realpath. */
function deps(o: {
  env: Env;
  plistEnv?: Env | string;
  inherited?: Env;
  lcRaw?: string;
  lcFail?: boolean;
  listeners?: number[];
  open?: string[];
  platform?: NodeJS.Platform;
  procEnviron?: string;
  dsHome?: string;
}): GateDeps & { passedEnv: Env[] } {
  const real = defaultGateDeps();
  const passedEnv: Env[] = [];
  return {
    ...real,
    passedEnv,
    platform: o.platform ?? "darwin",
    uid: 501,
    launchctlPrint: () => (o.lcFail ? { ok: false, error: "Could not find service" } : { ok: true, text: o.lcRaw ?? lcText({ env: o.env, inherited: o.inherited }) }),
    plutilEnv: () => ({ ok: true, json: typeof o.plistEnv === "string" ? o.plistEnv : JSON.stringify(o.plistEnv ?? o.env) }),
    listenerPids: () => ({ ok: true, pids: o.listeners ?? [PID] }),
    openFiles: () => ({ ok: true, paths: o.open ?? [] }),
    procEnviron: () => (o.procEnviron === undefined ? { ok: false, error: "no /proc" } : { ok: true, raw: Buffer.from(o.procEnviron) }),
    dsHome: () => o.dsHome ?? H,
    runWhere: (env: Env) => {
      passedEnv.push(env);
      return real.runWhere(env);
    },
  };
}
const OPTS = { label: "com.example.relay", port: 3777 };
const gate = (d: GateDeps) => {
  const r = runGate(OPTS, d);
  const f = formatGate(r);
  return { ...r, ...f, all: f.stdout + f.stderr };
};
const dbA = () => path.join(RH, "instances", "a", "relay.db");
const dbB = () => path.join(RH, "instances", "b", "relay.db");

beforeEach(() => {
  fs.rmSync(H, { recursive: true, force: true });
  for (const id of ["a", "b"]) {
    fs.mkdirSync(path.join(RH, "instances", id), { recursive: true });
    fs.writeFileSync(path.join(RH, "instances", id, "relay.db"), "");
  }
});

describe("deploy gate — PASS only on a proven match (macOS / launchd)", () => {
  it("PASS: the job's env resolves to the DB its pid holds open; exit 0", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a", XPC_SERVICE_NAME: "x" }, open: ["/dev/null", dbA(), `${dbA()}-wal`] }));
    expect(g.outcome, g.all).toBe("PASS");
    expect(g.exit).toBe(0);
    expect(g.stdout).toContain(dbA());
  });
  it("RELAY_DB_PATH to a non-`relay.db` name works: membership is by real path, no filename heuristic", () => {
    const team = path.join(ROOT, "team.sqlite");
    fs.writeFileSync(team, "");
    const g = gate(deps({ env: { HOME: H, RELAY_DB_PATH: team }, open: [team] }));
    expect(g.outcome, g.all).toBe("PASS");
  });
  it("only RESOLVER_ENV_KEYS reach the new resolver, and only their values are printed", () => {
    const d = deps({
      env: { HOME: H, RELAY_INSTANCE_ID: "a", "API-KEY": SECRET, RELAY_HTTP_SECRET: SECRET, OTHER: SECRET },
      open: [dbA()],
    });
    const g = gate(d);
    expect(g.outcome, g.all).toBe("PASS");
    expect(Object.keys(d.passedEnv[0]).sort()).toEqual(["HOME", "RELAY_INSTANCE_ID"]);
    expect(d.passedEnv[0].HOME).toBe(H);
    expect(g.all).not.toContain(SECRET);
    expect(g.all).not.toMatch(/API-KEY|RELAY_HTTP_SECRET|OTHER/);
  });
  it("HOME absent from the job env → the directory-service home is used, LABELED as such", () => {
    const g = gate(deps({ env: { RELAY_INSTANCE_ID: "a" }, open: [dbA()], dsHome: H }));
    expect(g.outcome, g.all).toBe("PASS");
    expect(g.stdout).toMatch(/HOME=.*directory-service home/);
  });
});

describe("deploy gate — FAIL (exit 1): the restart would land on a different DB, or the facts disagree", () => {
  it("the marker was re-pointed: the new resolver names b, the daemon holds a", () => {
    fs.symlinkSync("b", path.join(RH, "active-instance"));
    const g = gate(deps({ env: { HOME: H }, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("FAIL");
    expect(g.exit).toBe(1);
    expect(g.all).toContain(dbB());
  });
  it("the plist changed since load → FAIL naming bootout/bootstrap", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a" }, plistEnv: { HOME: H, RELAY_INSTANCE_ID: "b" }, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("FAIL");
    expect(g.reason).toMatch(/plist changed since load: bootout\/bootstrap first/);
  });
  it("a resolver key only in the plist (not loaded) is a change too", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a" }, plistEnv: { HOME: H, RELAY_INSTANCE_ID: "a", RELAY_DB_PATH: "/tmp/x.db" }, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("FAIL");
    expect(g.reason).toMatch(/plist changed since load/);
  });
  it("the :PORT listener is NOT the job's pid (daemon identity) → FAIL", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a" }, open: [dbA()], listeners: [9999] }));
    expect(g.outcome, g.all).toBe("FAIL");
    expect(g.reason).toMatch(/listener/);
  });
  it("nothing listens on :PORT → FAIL", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a" }, open: [dbA()], listeners: [] }));
    expect(g.outcome, g.all).toBe("FAIL");
  });
  it("the new resolver reports a fault (ambiguous) → FAIL: the new build would refuse to start", () => {
    const g = gate(deps({ env: { HOME: H }, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("FAIL");
    expect(g.all).toMatch(/ambiguous/);
  });
});

describe("deploy gate — CANNOT-VERIFY (exit 3): fail-closed parsing, never a guess", () => {
  it("not a loaded launchd job", () => {
    const g = gate(deps({ env: {}, lcFail: true }));
    expect(g.outcome).toBe("CANNOT-VERIFY");
    expect(g.exit).toBe(3);
  });
  it("Codex forge: a VALUE with a newline manufactures a second HOME line → duplicate → CANNOT-VERIFY, nothing printed", () => {
    const g = gate(deps({ env: { HOME: H, SECRET: `prefix-${SECRET}\n\t\tHOME => /tmp/wrong`, RELAY_INSTANCE_ID: "a" }, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.reason).toMatch(/HOME appears 2 times/);
    expect(g.all).not.toContain(SECRET);
    expect(g.all).not.toContain("/tmp/wrong");
  });
  it("newline forge WITHOUT a real HOME (no duplicate): the plist shows a newline in a value → CANNOT-VERIFY", () => {
    const g = gate(deps({ env: { SECRET: `prefix-${SECRET}\n\t\tHOME => /tmp/wrong`, RELAY_INSTANCE_ID: "a" }, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.reason).toMatch(/newline/);
    expect(g.all).not.toContain(SECRET);
    expect(g.all).not.toContain("/tmp/wrong");
  });
  it("a line in the environment section that is not `KEY => VALUE` → CANNOT-VERIFY, and the line is NOT echoed", () => {
    const text = lcText({ env: { HOME: H } }).replace("\tenvironment = {\n", `\tenvironment = {\n\t\tno arrow here ${SECRET}\n`);
    const g = gate(deps({ env: { HOME: H }, lcRaw: text, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.reason).toMatch(/is not `KEY => VALUE`/);
    expect(g.all).not.toContain(SECRET);
  });
  it("an unterminated environment section (output truncated inside it) → CANNOT-VERIFY", () => {
    const full = lcText({ env: { HOME: H, RELAY_INSTANCE_ID: "a" } });
    const text = full.slice(0, full.indexOf("\t\tRELAY_INSTANCE_ID => a\n") + "\t\tRELAY_INSTANCE_ID => a\n".length);
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a" }, lcRaw: text }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.reason).toMatch(/not terminated/);
  });
  it("two `environment` sections → CANNOT-VERIFY", () => {
    const g = gate(deps({ env: { HOME: H }, lcRaw: lcText({ env: { HOME: H }, extra: "\tenvironment = {\n\t\tRELAY_INSTANCE_ID => b\n\t}\n" }) }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.reason).toMatch(/appears twice/);
  });
  it("a resolver key set OUTSIDE the plist (inherited environment, e.g. launchctl setenv) → CANNOT-VERIFY", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a" }, inherited: { RELAY_DB_PATH: "/tmp/elsewhere.db" }, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.reason).toMatch(/RELAY_DB_PATH/);
  });
  it("the job is not running (no pid) → CANNOT-VERIFY", () => {
    const g = gate(deps({ env: { HOME: H }, lcRaw: lcText({ env: { HOME: H }, pid: null, state: "not running" }) }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
  });
  it("the plist is unreadable as JSON → CANNOT-VERIFY", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a" }, plistEnv: "not json", open: [dbA()] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
  });
  it("the WASM driver holds no file open → CANNOT-VERIFY (membership is unobservable), value not printed", () => {
    const g = gate(deps({ env: { HOME: H, RELAY_INSTANCE_ID: "a", RELAY_SQLITE_DRIVER: "wasm" }, open: [] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
  });
  it("an unsupported platform → CANNOT-VERIFY", () => {
    const g = gate(deps({ env: {}, platform: "win32" }));
    expect(g.outcome).toBe("CANNOT-VERIFY");
  });
});

describe("deploy gate — Linux: /proc/<pid>/environ (NUL-delimited); no modelled service manager", () => {
  const environ = (e: Env) => Object.entries(e).map(([k, v]) => `${k}=${v}`).join("\0") + "\0";
  it("the running env resolves to the held DB → CANNOT-VERIFY (a restart may load another env), not PASS", () => {
    const g = gate(deps({ env: {}, platform: "linux", procEnviron: environ({ HOME: H, RELAY_INSTANCE_ID: "a", "API-KEY": SECRET }), open: [dbA()] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.all).not.toContain(SECRET);
  });
  it("the running env resolves to ANOTHER DB → FAIL", () => {
    const g = gate(deps({ env: {}, platform: "linux", procEnviron: environ({ HOME: H, RELAY_INSTANCE_ID: "b" }), open: [dbA()] }));
    expect(g.outcome, g.all).toBe("FAIL");
  });
  it("a duplicated resolver key in environ → CANNOT-VERIFY", () => {
    const g = gate(deps({ env: {}, platform: "linux", procEnviron: `HOME=${H}\0RELAY_INSTANCE_ID=a\0RELAY_INSTANCE_ID=b\0`, open: [dbA()] }));
    expect(g.outcome, g.all).toBe("CANNOT-VERIFY");
    expect(g.reason).toMatch(/RELAY_INSTANCE_ID appears 2 times/);
  });
});

describe("parseLaunchctlPrint — the strict parser, directly", () => {
  it("hyphenated keys are ordinary entries (the ps -E leak cannot recur: entries are lines)", () => {
    const p = parseLaunchctlPrint(lcText({ env: { "API-KEY": SECRET, HOME: H } }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.sections.environment.get("HOME")).toEqual([H]);
  });
});

describe("RESOLVER_ENV_KEYS — the exported set covers every env read of the resolver", () => {
  it("static: every process.env read in src/instance.ts + src/approved-roots.ts is in the set (or a declared non-resolver key); os.homedir ⇒ HOME", () => {
    const NOT_RESOLVER: Record<string, string> = { RELAY_CONFIG_PATH: "moves the config file, not the DB" };
    const found = new Set<string>();
    for (const f of ["src/instance.ts", "src/approved-roots.ts"]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, f), "utf-8");
      for (const m of src.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/g)) found.add(m[1] ?? m[2]);
      expect(src, `${f}: a computed process.env[...] read cannot be audited`).not.toMatch(/process\.env\[\s*[^"'`\s]/);
      if (/os\.homedir\(|os\.userInfo\(/.test(src)) found.add("HOME");
    }
    const keys = new Set<string>(RESOLVER_ENV_KEYS);
    for (const k of found) if (!NOT_RESOLVER[k]) expect(keys.has(k), `${k} is read by the resolver modules but not exported`).toBe(true);
    for (const k of keys) expect(found.has(k), `${k} is exported but never read (stale)`).toBe(true);
  });
  it("`relay where --env-keys --json` prints exactly the set", () => {
    const r = spawnSync("node", [path.join(REPO_ROOT, "bin", "relay"), "where", "--env-keys", "--json"], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: H } });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([...RESOLVER_ENV_KEYS]);
  });
});

describe("deploy gate — a REAL daemon: real listener pid, real open files, real resolver (only launchctl/plutil faked)", () => {
  const freePort = () =>
    new Promise<number>((res) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
  const hasLsof = spawnSync("sh", ["-c", "command -v lsof"]).status === 0;
  it.skipIf(!hasLsof || process.platform !== "darwin")("PASS on the live daemon, then FAIL once the marker is re-pointed", async () => {
    fs.symlinkSync("a", path.join(RH, "active-instance"));
    fs.rmSync(dbA());
    fs.rmSync(dbB());
    const port = await freePort();
    const daemonEnv: Env = {
      PATH: process.env.PATH ?? "",
      HOME: H,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(port),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_CONFIG_PATH: path.join(ROOT, "gate-config.json"),
      RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json"),
    };
    const daemon = spawn(process.execPath, [path.join(REPO_ROOT, "dist", "index.js")], { env: daemonEnv, stdio: ["ignore", "ignore", "ignore"] });
    try {
      const t0 = Date.now();
      let up = false;
      while (!up && Date.now() - t0 < 10_000) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(up, "precondition: the daemon is up").toBe(true);
      const real = defaultGateDeps();
      const d: GateDeps = {
        ...real,
        platform: "darwin",
        launchctlPrint: () => ({ ok: true, text: lcText({ env: daemonEnv, pid: daemon.pid }) }),
        plutilEnv: () => ({ ok: true, json: JSON.stringify(daemonEnv) }),
      };
      const pass = runGate({ label: "com.example.relay", port }, d);
      expect(pass.outcome, formatGate(pass).stdout + formatGate(pass).stderr).toBe("PASS");

      fs.unlinkSync(path.join(RH, "active-instance"));
      fs.symlinkSync("b", path.join(RH, "active-instance"));
      const failed = runGate({ label: "com.example.relay", port }, d);
      expect(failed.outcome, formatGate(failed).stdout + formatGate(failed).stderr).toBe("FAIL");
    } finally {
      daemon.kill("SIGKILL");
    }
  }, 60_000);
});
