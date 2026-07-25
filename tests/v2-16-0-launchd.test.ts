// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.0 (gate 9) — launchd generator + collision-probe tests.
 *
 * The load-bearing case (gate-9 constraint 3): an EXISTING relay already serving
 * :3777 under a NONCANONICAL label must cause the installer to SKIP — no second
 * plist write, no bootstrap. Detection is label-agnostic (port /health + any
 * "bot-relay" LaunchAgent), never same-label-only, never a hard-coded name.
 */
import { describe, it, expect } from "vitest";
import http from "http";
import {
  CANONICAL_LABEL,
  buildLaunchdPlist,
  plistPathFor,
  parseLoadedRelayLabels,
  classifyHealthProbe,
  decideDaemonAction,
  chooseRestartTarget,
  installDaemon,
  type InstallDeps,
} from "../src/cli/launchd.js";
import { probeHealth } from "../src/cli/init.js"; // the REAL res.json() adapter

const BASE_OPTS = {
  nodePath: "/usr/local/bin/node",
  distEntry: "/repo/dist/index.js",
  workingDir: "/repo",
  port: 3777,
  transport: "http",
  logPath: "/tmp/relay-3777.log",
};

describe("buildLaunchdPlist", () => {
  it("emits a valid RunAtLoad+KeepAlive plist with the port/transport env, XML-escaped", () => {
    const plist = buildLaunchdPlist({ ...BASE_OPTS, label: CANONICAL_LABEL, workingDir: "/a & b/<x>" });
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain(`<string>${CANONICAL_LABEL}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>3777</string>");
    expect(plist).toContain("<string>http</string>");
    expect(plist).toContain("/a &amp; b/&lt;x&gt;"); // escaped
    expect(plist).not.toContain("/a & b/<x>"); // raw special chars not present
  });
});

describe("plistPathFor", () => {
  it("resolves under ~/Library/LaunchAgents", () => {
    expect(plistPathFor(CANONICAL_LABEL, "/home/u")).toBe(
      "/home/u/Library/LaunchAgents/com.bot-relay.daemon.plist",
    );
  });
});

describe("parseLoadedRelayLabels — label-agnostic", () => {
  it("catches ANY label containing 'bot-relay', ignores unrelated agents", () => {
    const out = [
      "PID\tStatus\tLabel",
      "28824\t0\tcom.lumiereventures.bot-relay", // hand-authored, noncanonical
      "123\t0\tcom.apple.Safari",
      "-\t0\tcom.bot-relay.daemon",
      "999\t0\tcom.acme.somethingelse",
    ].join("\n");
    expect(parseLoadedRelayLabels(out).sort()).toEqual(
      ["com.bot-relay.daemon", "com.lumiereventures.bot-relay"].sort(),
    );
  });
});

describe("classifyHealthProbe", () => {
  const P = (o: Partial<Parameters<typeof classifyHealthProbe>[0]>) => ({
    reachable: true,
    ok: true,
    parseable: true,
    body: null as unknown,
    ...o,
  });
  it("relay/foreign/none by probe shape", () => {
    expect(classifyHealthProbe(P({ body: { status: "ok", version: "9.9.9", protocol_version: "2.4.0" } }))).toBe("relay");
    expect(classifyHealthProbe(P({ body: { status: "ok", version: "9.9.9" } }))).toBe("foreign"); // no protocol_version
    expect(classifyHealthProbe(P({ body: { hello: "world" } }))).toBe("foreign");
    // fetch REJECTED → the port is genuinely free.
    expect(classifyHealthProbe({ reachable: false, ok: false, parseable: false, body: null })).toBe("none");
  });
  it("FAIL-CLOSED (audit HIGH #3): reachable-but-unreadable is NOT 'none'", () => {
    expect(classifyHealthProbe(P({ parseable: false, body: null }))).toBe("unreadable"); // empty / non-JSON body
    expect(classifyHealthProbe(P({ ok: false, parseable: false, body: null }))).toBe("unreadable"); // non-2xx
  });
});

describe("decideDaemonAction — never double-load", () => {
  it("relay already on the port (noncanonical label) → skip-relay-present", () => {
    const d = decideDaemonAction({
      healthClass: "relay",
      loadedRelayLabels: ["com.lumiereventures.bot-relay"],
      port: 3777,
    });
    expect(d.action).toBe("skip-relay-present");
    expect(d.existingLabels).toContain("com.lumiereventures.bot-relay");
  });
  it("foreign process on the port → skip-foreign-port (don't stomp it)", () => {
    expect(decideDaemonAction({ healthClass: "foreign", loadedRelayLabels: [], port: 3777 }).action).toBe(
      "skip-foreign-port",
    );
  });
  it("port free but a bot-relay agent already loaded → skip-agent-loaded", () => {
    expect(
      decideDaemonAction({ healthClass: "none", loadedRelayLabels: ["com.x.bot-relay"], port: 3777 }).action,
    ).toBe("skip-agent-loaded");
  });
  it("port free + no agent loaded → install", () => {
    expect(decideDaemonAction({ healthClass: "none", loadedRelayLabels: [], port: 3777 }).action).toBe("install");
  });
});

function makeDeps(over: Partial<InstallDeps> & { fetchHealth: InstallDeps["fetchHealth"]; launchctlList: InstallDeps["launchctlList"] }): {
  deps: InstallDeps;
  writes: string[];
  bootstraps: string[];
} {
  const writes: string[] = [];
  const bootstraps: string[] = [];
  const deps: InstallDeps = {
    fetchHealth: over.fetchHealth,
    launchctlList: over.launchctlList,
    bootstrap: (p) => bootstraps.push(p),
    writePlist: (p) => writes.push(p),
    log: () => {},
  };
  return { deps, writes, bootstraps };
}

describe("installDaemon — MANDATORY collision: existing relay under a noncanonical label → NO second load", () => {
  it("a relay already serving :3777 (loaded as com.lumiereventures.bot-relay) → installs nothing", async () => {
    const { deps, writes, bootstraps } = makeDeps({
      fetchHealth: async () => ({ reachable: true, ok: true, parseable: true, body: { status: "ok", version: "2.15.2", protocol_version: "2.4.0" } }),
      launchctlList: () => "28824\t0\tcom.lumiereventures.bot-relay\n",
    });
    const res = await installDaemon(BASE_OPTS, deps);
    expect(res.installed).toBe(false);
    expect(res.decision.action).toBe("skip-relay-present");
    expect(res.plistPath).toBeNull();
    expect(writes, "no plist may be written").toEqual([]);
    expect(bootstraps, "no bootstrap/kickstart may run").toEqual([]);
  });

  it("port free + no agent loaded → writes the canonical plist + bootstraps exactly once", async () => {
    const { deps, writes, bootstraps } = makeDeps({
      fetchHealth: async () => ({ reachable: false, ok: false, parseable: false, body: null }), // port free
      launchctlList: () => "123\t0\tcom.apple.Safari\n",
    });
    const res = await installDaemon(BASE_OPTS, deps, "/home/u");
    expect(res.installed).toBe(true);
    expect(res.plistPath).toBe("/home/u/Library/LaunchAgents/com.bot-relay.daemon.plist");
    expect(writes.length).toBe(1);
    expect(bootstraps.length).toBe(1);
  });

  it("a fetchHealth that THROWS unexpectedly fails CLOSED (unreadable), does NOT install", async () => {
    // The real adapter (probeHealth) never throws for connection-refused — it
    // returns reachable:false. So a THROW here is an unexpected adapter failure
    // = unknown state = must not assume the port is free (audit HIGH #3).
    const { deps, writes, bootstraps } = makeDeps({
      fetchHealth: async () => {
        throw new Error("unexpected adapter failure");
      },
      launchctlList: () => "",
    });
    const res = await installDaemon(BASE_OPTS, deps, "/home/u");
    expect(res.decision.action).toBe("skip-unreadable");
    expect(res.installed).toBe(false);
    expect(writes).toEqual([]);
    expect(bootstraps).toEqual([]);
  });
});

// ============================================================================
// Audit HIGH #3 (codex) — installDaemon must FAIL CLOSED on an unreadable probe,
// exercised through the REAL res.json() adapter (probeHealth), because the harm
// lives in the adapter: an empty/malformed 200 body throws and was reclassified
// as "port free" → a competing daemon installed.
// ============================================================================
describe("installDaemon fail-closed on an unreadable probe (real adapter)", () => {
  function tinyServer(status: number, body: string): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const srv = http.createServer((_req, res) => {
        res.statusCode = status;
        res.end(body);
      });
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ port, close: () => new Promise<void>((r) => srv.close(() => r())) });
      });
    });
  }

  it("(harm) an empty 200 body → res.json() throws → unreadable → REFUSE (no plist, no bootstrap)", async () => {
    const s = await tinyServer(200, ""); // the `curl -s` empty-body case
    const { deps, writes, bootstraps } = makeDeps({ fetchHealth: probeHealth, launchctlList: () => "" });
    const res = await installDaemon({ ...BASE_OPTS, port: s.port }, deps, "/home/u");
    await s.close();
    expect(res.decision.action).toBe("skip-unreadable");
    expect(res.installed).toBe(false);
    expect(writes).toEqual([]);
    expect(bootstraps).toEqual([]);
  });

  it("(harm) a malformed-JSON 200 → unreadable → REFUSE", async () => {
    const s = await tinyServer(200, "{ not json");
    const { deps, writes } = makeDeps({ fetchHealth: probeHealth, launchctlList: () => "" });
    const res = await installDaemon({ ...BASE_OPTS, port: s.port }, deps, "/home/u");
    await s.close();
    expect(res.decision.action).toBe("skip-unreadable");
    expect(writes).toEqual([]);
  });

  it("(twin) connection refused (nothing listening) → port free → INSTALLS", async () => {
    const s = await tinyServer(200, "{}");
    const freePort = s.port;
    await s.close(); // now nothing listens on freePort → fetch rejects
    const { deps, writes } = makeDeps({ fetchHealth: probeHealth, launchctlList: () => "" });
    const res = await installDaemon({ ...BASE_OPTS, port: freePort }, deps, "/home/u");
    expect(res.installed).toBe(true);
    expect(writes.length).toBe(1);
  });
});

// ============================================================================
// Audit HIGH #3 — a stale daemon must be surfaced LOUDLY, never auto-restarted.
// ADR-0015 harm + twin on the two pure decisions.
// ============================================================================
describe("decideDaemonAction — version drift (audit HIGH #3)", () => {
  it("(harm) a relay on the port running an OLDER version → versionDrift + restart remedy, still skip", () => {
    const d = decideDaemonAction({
      healthClass: "relay",
      loadedRelayLabels: [CANONICAL_LABEL],
      port: 3777,
      installedVersion: "9.9.9",
      runningVersion: "9.9.8",
    });
    expect(d.action).toBe("skip-relay-present"); // never auto-restarts
    expect(d.versionDrift).toEqual({ running: "9.9.8", installed: "9.9.9" });
    expect(d.reason).toContain("relay restart");
    expect(d.reason).toContain("NOT taken effect");
  });

  it("(twin) matching versions → no drift, benign reason", () => {
    const d = decideDaemonAction({
      healthClass: "relay",
      loadedRelayLabels: [],
      port: 3777,
      installedVersion: "9.9.9",
      runningVersion: "9.9.9",
    });
    expect(d.versionDrift).toBeUndefined();
    expect(d.reason).toContain("leaving the existing supervisor in place");
  });

  it("(twin) unknown running version (no /health version field) → no drift claimed", () => {
    const d = decideDaemonAction({
      healthClass: "relay",
      loadedRelayLabels: [],
      port: 3777,
      installedVersion: "9.9.9",
      runningVersion: null,
    });
    expect(d.versionDrift).toBeUndefined();
  });
});

describe("chooseRestartTarget — pick or refuse (audit HIGH #3)", () => {
  it("canonical label loaded → restart it, no bootstrap", () => {
    const t = chooseRestartTarget({ loadedRelayLabels: [CANONICAL_LABEL], canonicalPlistExists: true });
    expect(t.label).toBe(CANONICAL_LABEL);
    expect(t.needsBootstrap).toBe(false);
  });

  it("canonical plist on disk but not loaded → target it, needs bootstrap", () => {
    const t = chooseRestartTarget({ loadedRelayLabels: [], canonicalPlistExists: true });
    expect(t.label).toBe(CANONICAL_LABEL);
    expect(t.needsBootstrap).toBe(true);
  });

  it("a sole hand-authored relay label → restart that one", () => {
    const t = chooseRestartTarget({ loadedRelayLabels: ["com.acme.bot-relay"], canonicalPlistExists: false });
    expect(t.label).toBe("com.acme.bot-relay");
  });

  it("(harm) multiple relay labels, none canonical → REFUSE to guess", () => {
    const t = chooseRestartTarget({
      loadedRelayLabels: ["com.a.bot-relay", "com.b.bot-relay"],
      canonicalPlistExists: false,
    });
    expect(t.label).toBeNull();
    expect(t.reason).toContain("multiple");
  });

  it("(harm) nothing loaded, no plist → REFUSE with an init hint", () => {
    const t = chooseRestartTarget({ loadedRelayLabels: [], canonicalPlistExists: false });
    expect(t.label).toBeNull();
    expect(t.reason).toContain("relay init");
  });
});

// ============================================================================
// codex HIGH #3 P1 — a fail-open caused by an over-broad catch is repaired by
// enumerating the SUCCESS condition: ONLY an unambiguous ECONNREFUSED means the
// port is free. A non-followed 3xx, a socket reset, and a timeout must all be
// unreadable → REFUSE, exercised through the REAL probeHealth adapter.
// ============================================================================
describe("installDaemon fail-closed on non-refused fetch errors (real adapter)", () => {
  function rawServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ port, close: () => new Promise<void>((r) => srv.close(() => r())) });
      });
    });
  }

  it("(harm) a 3xx redirect (to a dead target) is NOT followed → unreadable → REFUSE", async () => {
    const s = await rawServer((_req, res) => {
      res.writeHead(302, { Location: "http://127.0.0.1:1/health" });
      res.end();
    });
    const { deps, writes, bootstraps } = makeDeps({ fetchHealth: probeHealth, launchctlList: () => "" });
    const res = await installDaemon({ ...BASE_OPTS, port: s.port }, deps, "/home/u");
    await s.close();
    expect(res.decision.action).toBe("skip-unreadable");
    expect(res.installed).toBe(false);
    expect(writes).toEqual([]);
    expect(bootstraps).toEqual([]);
  });

  it("(harm) a socket reset after accept → unreadable → REFUSE (not classified as free)", async () => {
    const s = await rawServer((req) => {
      req.socket.destroy();
    });
    const { deps, writes } = makeDeps({ fetchHealth: probeHealth, launchctlList: () => "" });
    const res = await installDaemon({ ...BASE_OPTS, port: s.port }, deps, "/home/u");
    await s.close();
    expect(res.decision.action).toBe("skip-unreadable");
    expect(writes).toEqual([]);
  });

  it("(harm) a black-holed (never-responding) server → bounded timeout → unreadable → REFUSE (no hang)", async () => {
    process.env.RELAY_HEALTH_PROBE_TIMEOUT_MS = "200";
    const s = await rawServer(() => {
      /* never respond */
    });
    const { deps, writes } = makeDeps({ fetchHealth: probeHealth, launchctlList: () => "" });
    const res = await installDaemon({ ...BASE_OPTS, port: s.port }, deps, "/home/u");
    delete process.env.RELAY_HEALTH_PROBE_TIMEOUT_MS;
    await s.close();
    expect(res.decision.action).toBe("skip-unreadable");
    expect(writes).toEqual([]);
  });
});
