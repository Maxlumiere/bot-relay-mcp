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
import {
  CANONICAL_LABEL,
  buildLaunchdPlist,
  plistPathFor,
  parseLoadedRelayLabels,
  classifyHealthProbe,
  decideDaemonAction,
  installDaemon,
  type InstallDeps,
} from "../src/cli/launchd.js";

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
  it("relay = status ok + version + protocol_version; foreign = 200 non-relay; none = unreachable", () => {
    expect(classifyHealthProbe(true, { status: "ok", version: "9.9.9", protocol_version: "2.4.0" })).toBe("relay");
    expect(classifyHealthProbe(true, { status: "ok", version: "9.9.9" })).toBe("foreign"); // no protocol_version
    expect(classifyHealthProbe(true, { hello: "world" })).toBe("foreign");
    expect(classifyHealthProbe(false, null)).toBe("none");
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
      fetchHealth: async () => ({ ok: true, body: { status: "ok", version: "2.15.2", protocol_version: "2.4.0" } }),
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
      fetchHealth: async () => ({ ok: false, body: null }), // unreachable
      launchctlList: () => "123\t0\tcom.apple.Safari\n",
    });
    const res = await installDaemon(BASE_OPTS, deps, "/home/u");
    expect(res.installed).toBe(true);
    expect(res.plistPath).toBe("/home/u/Library/LaunchAgents/com.bot-relay.daemon.plist");
    expect(writes.length).toBe(1);
    expect(bootstraps.length).toBe(1);
  });

  it("a fetchHealth rejection is treated as 'none' (not a crash)", async () => {
    const { deps, writes } = makeDeps({
      fetchHealth: async () => {
        throw new Error("ECONNREFUSED");
      },
      launchctlList: () => "",
    });
    const res = await installDaemon(BASE_OPTS, deps, "/home/u");
    expect(res.installed).toBe(true); // unreachable → install
    expect(writes.length).toBe(1);
  });
});
