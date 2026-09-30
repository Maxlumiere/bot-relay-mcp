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

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: (m: string) => {
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

const { connect } = await import("./extension.js");
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
