// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// Codex #292 R1 #1 — the resolver revision is asked of /health ON ITS OWN, not
// only by the health poll (which starts after a SUCCESSFUL MCP connect). /health
// needs no token, so a relay that refuses Tether's MCP connection (a 401) still
// reports its revision, and a skew is still named: often the very cause of the
// refusal (a different vault, so a stale token).
//
// Drives the REAL shipped connect() against a real local HTTP server: /mcp
// answers 401, /health answers with a different resolver revision.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const warnings: string[] = [];
// Codex #292 R2 #2: after teardown, the output channel is closed and writing to
// it throws. The mocked warning sink does the same once `sinkClosed` is set.
let sinkClosed = false;
let lateReports = 0;

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: (m: string) => {
      if (sinkClosed) {
        lateReports++;
        throw new Error("Channel has been closed");
      }
      warnings.push(m);
      return Promise.resolve(undefined);
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  extensions: { getExtension: () => undefined },
  ThemeColor: class {},
}));

const { connect, deactivate } = await import("./extension.js");
const { probeResolverRevision, ResolverSkewReporter } = await import("./resolver-skew.js");
const { BUNDLED_RESOLVER_REVISION } = await import("./vault-path.js");

const OTHER = BUNDLED_RESOLVER_REVISION === "ffffffffffff" ? "eeeeeeeeeeee" : "ffffffffffff";
let server: http.Server;
let endpoint = "";
const hits: string[] = [];
let healthBody = "";
let healthStatus = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers["x-agent-token"] ? "token" : "no-token"}`);
    if (req.url === "/health") {
      res.writeHead(healthStatus, { "content-type": "application/json" });
      res.end(healthBody);
      return;
    }
    // /mcp: the relay refuses this token.
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "AUTH_FAILED" }, id: null }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  sinkClosed = false;
  lateReports = 0;
  warnings.length = 0;
  hits.length = 0;
  healthStatus = 200;
  healthBody = JSON.stringify({ status: "ok", resolver_revision: OTHER });
});

async function until(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("Codex #292 R1 #1 — a relay that answers MCP with 401 still has its resolver revision compared", () => {
  it("the SHIPPED connect(): /mcp → 401, /health → another revision ⇒ the skew is WARNED (the MCP connection failed)", async () => {
    let connectError: unknown = null;
    await connect({ endpoint, agentName: "probe-agent", agentToken: "stale-token-0000000000", autoInjectInbox: false, notificationLevel: "none" }).catch((e: unknown) => {
      connectError = e;
    });
    const warned = await until(() => warnings.length > 0);
    expect(hits.some((h) => h.startsWith("POST /mcp")), hits.join("\n")).toBe(true);
    expect(connectError, "the MCP connection really was refused").not.toBeNull();
    expect(warned, `no warning; requests: ${hits.join(", ")}`).toBe(true);
    expect(warnings[0]).toContain(`differs from the relay's (revision ${OTHER})`);
    // /health is asked WITHOUT the agent token: it needs none.
    expect(hits.filter((h) => h.startsWith("GET /health"))).toEqual(["GET /health no-token"]);
  });

  it("TWIN: /health reports THIS bundle's revision ⇒ no warning, even though MCP refused", async () => {
    healthBody = JSON.stringify({ status: "ok", resolver_revision: BUNDLED_RESOLVER_REVISION });
    await connect({ endpoint, agentName: "probe-agent", agentToken: "stale-token-0000000000", autoInjectInbox: false, notificationLevel: "none" }).catch(() => {});
    await until(() => hits.some((h) => h.startsWith("GET /health")));
    await new Promise((r) => setTimeout(r, 100));
    expect(hits.some((h) => h.startsWith("GET /health")), hits.join("\n")).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("probeResolverRevision — one /health read, never throws", () => {
  const sinks = () => {
    const out = { logs: [] as string[], warns: [] as string[] };
    return { out, reporter: new ResolverSkewReporter({ log: (l) => out.logs.push(l), warn: (m) => out.warns.push(m) }) };
  };
  it("a mismatch is warned", async () => {
    const { out, reporter } = sinks();
    await probeResolverRevision({ endpoint, reporter, timeoutMs: 2000 });
    expect(out.warns).toHaveLength(1);
  });
  it("a non-2xx /health is 'cannot compare' (logged), never a warning", async () => {
    healthStatus = 503;
    const { out, reporter } = sinks();
    await probeResolverRevision({ endpoint, reporter, timeoutMs: 2000 });
    expect(out.warns).toEqual([]);
    expect(out.logs.join("\n")).toMatch(/cannot compare revisions: no \/health body/);
  });
  it("an unreachable relay does not throw (logged: cannot compare)", async () => {
    const { out, reporter } = sinks();
    await expect(probeResolverRevision({ endpoint: "http://127.0.0.1:1", reporter, timeoutMs: 2000 })).resolves.toBeUndefined();
    expect(out.logs.join("\n")).toMatch(/cannot compare revisions/);
  });
});

/** A relay whose /health answers `revision` after `delayMs`; /mcp is refused (401). */
async function relayServer(revision: string, delayMs: number): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", resolver_revision: revision }));
      }, delayMs);
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "AUTH_FAILED" }, id: null }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    endpoint: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}
const cfg = (endpoint: string) => ({ endpoint, agentName: "probe-agent", agentToken: "stale-token-0000000000", autoInjectInbox: false, notificationLevel: "none" as const });

describe("Codex #292 R2 #2 — a probe answering after teardown reports nothing and cannot throw", () => {
  it("the SHIPPED path: connect(), then deactivate() before /health answers ⇒ no report into the closed sink, no unhandled rejection", async () => {
    const slow = await relayServer(OTHER, 300);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await connect(cfg(slow.endpoint)).catch(() => {});
      await deactivate();
      sinkClosed = true; // VS Code has disposed the channel
      await new Promise((r) => setTimeout(r, 600));
      expect(unhandled, String(unhandled[0])).toEqual([]);
      expect(lateReports, "the torn-down probe tried to report").toBe(0);
      expect(warnings).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await slow.close();
    }
  });
  it("a cancelled probe never reports", async () => {
    const slow = await relayServer(OTHER, 300);
    const out: string[] = [];
    const reporter = new ResolverSkewReporter({ log: (l) => out.push(l), warn: (m) => out.push(m) });
    const ctl = new AbortController();
    const p = probeResolverRevision({ endpoint: slow.endpoint, reporter, timeoutMs: 2000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await p;
    expect(out).toEqual([]);
    await slow.close();
  });
  it("an abort CANCELS the in-flight request: the relay sees the connection closed before it answers", async () => {
    let closedEarly = false;
    const srv = http.createServer((req, res) => {
      res.on("close", () => { if (!res.writableEnded) closedEarly = true; });
      setTimeout(() => { if (!res.destroyed) res.end("{}"); }, 400);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const ep = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const reporter = new ResolverSkewReporter({ log: () => {}, warn: () => {} });
    const ctl = new AbortController();
    const p = probeResolverRevision({ endpoint: ep, reporter, timeoutMs: 5000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await p;
    await until(() => closedEarly, 1000);
    expect(closedEarly).toBe(true);
    await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });
  });
  it("a SUPERSEDED probe (isCurrent false) never reports, even with no abort", async () => {
    const out: string[] = [];
    const reporter = new ResolverSkewReporter({ log: (l) => out.push(l), warn: (m) => out.push(m) });
    await probeResolverRevision({ endpoint, reporter, timeoutMs: 2000, isCurrent: () => false });
    expect(out).toEqual([]);
  });
  it("a reporting sink that THROWS is contained: observe() and the probe never throw", async () => {
    const reporter = new ResolverSkewReporter({
      log: () => { throw new Error("Channel has been closed"); },
      warn: () => { throw new Error("Channel has been closed"); },
    });
    expect(() => reporter.observe(JSON.stringify({ resolver_revision: OTHER }))).not.toThrow();
    const r2 = new ResolverSkewReporter({ log: () => { throw new Error("closed"); }, warn: () => { throw new Error("closed"); } });
    await expect(probeResolverRevision({ endpoint, reporter: r2, timeoutMs: 2000 })).resolves.toBeUndefined();
  });
});

describe("Codex #292 R2 #3 — a superseded connection's late /health answer is discarded", () => {
  it("connect A (slow, MISMATCH), then B (fast, MATCH) ⇒ B's verdict stands: no warning from A", async () => {
    const a = await relayServer(OTHER, 400);
    const b = await relayServer(BUNDLED_RESOLVER_REVISION, 0);
    try {
      await connect(cfg(a.endpoint)).catch(() => {});
      await connect(cfg(b.endpoint)).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      expect(warnings).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });
  it("TWIN: A alone (slow, MISMATCH) ⇒ warned (the guard discards only a SUPERSEDED answer)", async () => {
    // Start from a MATCH (the reporter reports only a change of verdict).
    const same = await relayServer(BUNDLED_RESOLVER_REVISION, 0);
    await connect(cfg(same.endpoint)).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await same.close();
    const a = await relayServer(OTHER, 400);
    try {
      await connect(cfg(a.endpoint)).catch(() => {});
      await until(() => warnings.length > 0, 3000);
      expect(warnings.length).toBe(1);
    } finally {
      await a.close();
    }
  });
});
