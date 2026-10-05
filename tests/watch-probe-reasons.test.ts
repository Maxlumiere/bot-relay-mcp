// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay watch`'s marker-writer probe (2026-10-05 finding): two instrument defects.
 *   (1) A 1 s deadline expiry read "no relay daemon reachable … nothing will ever write the
 *       marker", sending an operator to restart a healthy, momentarily slow daemon. The probe now
 *       answers with a CLOSED set of kinds, each with its own reason and remedy: slow · refused ·
 *       unreachable · http-error · bad-response · markers-off · markers-unreported.
 *   (2) The mode was decided ONCE per watch. Now LEVEL-TRIGGERED: while degraded because the probe
 *       failed, the watch re-probes and upgrades back to event-driven when the writer answers
 *       (announced once). A delivery the marker MISSED is not re-probed.
 * Every probe here runs against a REAL local HTTP server (or a really closed port).
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const W = await import("../src/cli/watch.js");

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
async function serve(handler: Handler): Promise<{ port: string; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: String((server.address() as AddressInfo).port), server };
}
const json = (body: unknown, delayMs = 0): Handler => (_req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }, delayMs);
};
const probe = (port: string, deadlineMs = 300) => W.probeMarkerWriter({ host: "127.0.0.1", port, deadlineMs });

describe("(1) a CLOSED set of probe failures, each with its own reason", () => {
  it("live: the daemon reports filesystem_markers: true", async () => {
    const { port } = await serve(json({ filesystem_markers: true }));
    expect(await probe(port)).toEqual({ live: true });
  });
  it("HARM (the finding): a daemon SLOWER than the deadline is `slow` — reachable, NOT 'no daemon reachable'", async () => {
    const { port } = await serve(json({ filesystem_markers: true }, 800));
    const p = await probe(port, 300);
    expect(p).toMatchObject({ live: false, kind: "slow" });
    expect((p as { reason: string }).reason).toMatch(/SLOW, not absent/);
    expect((p as { reason: string }).reason).not.toMatch(/no relay daemon|nothing will ever write/);
  });
  it("refused: nothing listens on the port (a closed port) → `refused`", async () => {
    const { port, server } = await serve(json({}));
    await new Promise<void>((r) => server.close(() => r()));
    servers.splice(servers.indexOf(server), 1);
    const p = await probe(port);
    expect(p).toMatchObject({ live: false, kind: "refused" });
    expect((p as { reason: string }).reason).toMatch(/connection refused/);
  });
  it("http-error: /health answers 503", async () => {
    const { port } = await serve((_q, res) => {
      res.writeHead(503);
      res.end();
    });
    expect(await probe(port)).toMatchObject({ live: false, kind: "http-error", reason: expect.stringMatching(/HTTP 503/) });
  });
  it("bad-response: /health answers 200 with a body that is not JSON", async () => {
    const { port } = await serve((_q, res) => {
      res.writeHead(200);
      res.end("<html>not json</html>");
    });
    expect(await probe(port)).toMatchObject({ live: false, kind: "bad-response" });
  });
  it("markers-off and markers-unreported stay distinct", async () => {
    const off = await serve(json({ filesystem_markers: false }));
    const old = await serve(json({ version: "2.0.0" }));
    expect((await probe(off.port)) as { kind: string }).toMatchObject({ kind: "markers-off" });
    expect((await probe(old.port)) as { kind: string }).toMatchObject({ kind: "markers-unreported" });
  });
  it("unreachable: a socket destroyed mid-request → `unreachable`, with no free-text error detail", async () => {
    const { port } = await serve((req) => req.socket.destroy());
    const p = await probe(port);
    expect(p).toMatchObject({ live: false, kind: "unreachable" });
    expect((p as { reason: string }).reason).toMatch(/unreachable \((ECONNRESET|a network error)\)$/);
  });
  it("every kind is in the closed set", () => {
    expect([...W.PROBE_FAILURES].sort()).toEqual(["bad-response", "http-error", "markers-off", "markers-unreported", "refused", "slow", "unreachable"]);
  });
  it("HARM: the remedy for `slow` never sends the operator to restart or reconfigure the daemon", () => {
    expect(W.adviceFor("slow")).toMatch(/nothing to restart/);
    expect(W.adviceFor("slow")).not.toMatch(/Start the relay daemon|RELAY_FILESYSTEM_MARKERS/);
    expect(W.adviceFor("refused")).toMatch(/Start the relay daemon/);
    expect(W.adviceFor("markers-off")).toMatch(/RELAY_FILESYSTEM_MARKERS=1/);
  });
});

describe("(2) LEVEL-TRIGGERED: re-probe while probe-degraded, upgrade when the writer answers", () => {
  function harness(results: W.MarkerWriterProbe[], opts: { canUpgrade?: boolean } = {}) {
    let degraded = true;
    let upgrades = 0;
    let probes = 0;
    const lines: string[] = [];
    const r = W.makeReprobe({
      agent: "probe-agent",
      probe: async () => results[Math.min(probes++, results.length - 1)],
      isProbeDegraded: () => degraded,
      upgrade: () => {
        if (opts.canUpgrade === false) return false;
        upgrades++;
        degraded = false;
        return true;
      },
      write: (l) => lines.push(l),
    });
    return { r, lines, get upgrades() { return upgrades; }, get probes() { return probes; }, setDegraded: (d: boolean) => void (degraded = d) };
  }
  const slow: W.MarkerWriterProbe = { live: false, kind: "slow", reason: "slow" };
  it("HARM (the finding): slow, slow, then live → ONE upgrade and ONE recovery line; later ticks do nothing", async () => {
    const h = harness([slow, slow, { live: true }]);
    for (let k = 0; k < 5; k++) await h.r.tick();
    expect(h.upgrades).toBe(1);
    expect(h.lines).toEqual(["[sentinel] RECOVERED — wake for probe-agent is event-driven again: the marker writer answered and is confirmed live\n"]);
    expect(h.probes).toBe(3); // no probing once upgraded
  });
  it("never a recovery line when there is nothing to upgrade to (no live marker watcher)", async () => {
    const h = harness([{ live: true }], { canUpgrade: false });
    await h.r.tick();
    expect(h.lines).toEqual([]);
  });
  it("a degradation proven at RUNTIME (a missed delivery) is never re-probed", async () => {
    const h = harness([{ live: true }]);
    h.setDegraded(false);
    await h.r.tick();
    expect([h.probes, h.upgrades]).toEqual([0, 0]);
  });
  it("ticks never overlap: a second tick while one is in flight does not probe", async () => {
    let release!: () => void;
    let calls = 0;
    const r = W.makeReprobe({
      agent: "a",
      probe: () => {
        calls++;
        return new Promise((res) => (release = () => res({ live: true })));
      },
      isProbeDegraded: () => true,
      upgrade: () => true,
      write: () => {},
    });
    const first = r.tick();
    await r.tick();
    expect(calls).toBe(1);
    release();
    await first;
  });
  it("end to end with the REAL probe: a daemon slow at first, then answering → upgraded", async () => {
    let delay = 800;
    const { port } = await serve((_q, res) => setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ filesystem_markers: true }));
    }, delay));
    let degraded = true;
    const lines: string[] = [];
    const r = W.makeReprobe({ agent: "e2e", probe: () => probe(port, 300), isProbeDegraded: () => degraded, upgrade: () => ((degraded = false), true), write: (l) => lines.push(l) });
    await r.tick();
    expect([degraded, lines.length]).toEqual([true, 0]); // still slow: stays degraded, says nothing
    delay = 0;
    await r.tick();
    expect(degraded).toBe(false);
    expect(lines).toHaveLength(1);
  });
});
