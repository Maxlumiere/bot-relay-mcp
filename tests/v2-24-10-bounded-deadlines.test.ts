// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.10 — bounded network deadlines (blocker 4).
 *
 * THE DEFECT: `fetch()` resolves on RESPONSE HEADERS, not on a finished body.
 * The CLI cleared its timeout right after `fetch()` and then read the body, so
 * body consumption had no deadline at all. A peer that sent headers and stalled
 * hung the command forever — while the code advertised a 5s timeout.
 *
 * ⚠ HARNESS ORDERING REQUIREMENT — DO NOT REORDER THESE TESTS' ASSERTIONS.
 * Capture "is it still pending?" into a local BEFORE closing/destroying the
 * server. Closing the server destroys the response, which settles the pending
 * promise; if you assert after closing, the flag flips under the assertion and
 * the test PASSES ON THE BROKEN CODE. That false pass happened while writing
 * these tests, and a harness that lies is worse than no harness — it produces a
 * confident green on a real defect, which is the exact class this fix is about.
 *
 * Every deadline claim here is measured against a REAL local HTTP server, not a
 * fetch stub: codex-lumen was explicit that these body hangs are real with
 * native fetch, and a stub would only prove our mock stalls.
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { withDeadline, DeadlineExceededError } from "../src/http-deadline.js";
// Use the REAL package version (never a hardcoded literal): a literal equal to the
// current package.json version trips the pre-publish tests-drift guard the moment
// it is released. The value here is an arbitrary mock-server field; VERSION keeps it
// correct and drift-proof.
import { VERSION } from "../src/version.js";

/** Real server: sends full headers + one byte, then never finishes the body. */
function stallingBodyServer(): Promise<{ url: string; port: number; close: () => void }> {
  const open: http.ServerResponse[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    open.push(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => {
          for (const r of open) try { r.destroy(); } catch { /* ignore */ }
          server.close();
        },
      });
    });
  });
}

/** Real server: a complete, well-formed response. The innocent twin. */
function healthyServer(body: unknown): Promise<{ url: string; port: number; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => server.close() });
    });
  });
}

describe("v2.24.10 withDeadline — the owned deadline covers connect AND body", () => {
  it("HARM: a stalled body is refused AT the bound, not after it", async () => {
    const srv = await stallingBodyServer();
    const t0 = Date.now();
    let err: unknown = null;
    try {
      await withDeadline(600, "probe", async (signal) => {
        const res = await fetch(`${srv.url}/health`, { signal });
        return await res.json(); // the read that used to be unbounded
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    srv.close();
    expect(err).toBeInstanceOf(DeadlineExceededError);
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(4000); // settles at the bound, not "eventually" — ANTI-HANG ceiling, not an SLA (#210): a real hang blows any ceiling; widen-safe, do NOT tighten
  });

  it("TWIN: a complete body inside the bound still resolves normally", async () => {
    const srv = await healthyServer({ version: VERSION });
    const body = await withDeadline(3000, "probe", async (signal) => {
      const res = await fetch(`${srv.url}/health`, { signal });
      return (await res.json()) as { version: string };
    });
    srv.close();
    expect(body.version).toBe(VERSION);
  });

  it("TWIN: a non-deadline error from inside propagates unchanged (not masked as a timeout)", async () => {
    const srv = await healthyServer({ ok: true });
    let err: unknown = null;
    try {
      await withDeadline(3000, "probe", async () => {
        throw new Error("caller-specific failure");
      });
    } catch (e) {
      err = e;
    }
    srv.close();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DeadlineExceededError);
    expect((err as Error).message).toBe("caller-specific failure");
  });

  it("the deadline error names the label and the bound, so an operator can tell WHICH call gave up", async () => {
    const srv = await stallingBodyServer();
    let msg = "";
    try {
      await withDeadline(400, "hub health probe", async (signal) => {
        const res = await fetch(`${srv.url}/health`, { signal });
        return await res.json();
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    srv.close();
    expect(msg).toContain("hub health probe");
    expect(msg).toContain("400ms");
  });
});

describe("v2.24.10 relay pair — the reproduced end-to-end hang", () => {
  it("HARM: pair settles instead of hanging past its own promise against a stalling hub", async () => {
    const srv = await stallingBodyServer();
    const pair = await import("../src/cli/pair.js");
    const t0 = Date.now();
    let settled = false;
    const p = pair
      .run([srv.url, "--name", "probe", "--yes", "--secret", "s"])
      .then(() => { settled = true; })
      .catch(() => { settled = true; });

    // The health probe's bound is 5s. Wait past it, then CAPTURE BEFORE CLOSING
    // (see the harness ordering note at the top of this file).
    await new Promise((r) => setTimeout(r, 7000));
    const settledWithinBound = settled;
    const elapsed = Date.now() - t0;
    srv.close();
    await Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);

    // Pre-fix this was FALSE at 7003ms against a 5000ms promise.
    expect(settledWithinBound).toBe(true);
    // ANTI-HANG ceiling, not an SLA (#210) — a real hang blows any ceiling; widen-safe,
    // do NOT tighten. Judgment call: was 8000, but `elapsed` has a hardcoded 7000ms floor
    // (the setTimeout above), so the old 1000ms cushion was too tight for #210 contention.
    // Widened to 16000, still bounded well under the 25s per-test timeout.
    expect(elapsed).toBeLessThan(16000);
  }, 25000);
});

describe("v2.24.10 relay init probeHealth — bounded, and still FAILS CLOSED", () => {
  it("HARM: a stalling body no longer hangs the install probe", async () => {
    const srv = await stallingBodyServer();
    const init = await import("../src/cli/init.js");
    process.env.RELAY_HEALTH_PROBE_TIMEOUT_MS = "600";
    const t0 = Date.now();
    const probe = await init.probeHealth(srv.port);
    const elapsed = Date.now() - t0;
    srv.close();
    delete process.env.RELAY_HEALTH_PROBE_TIMEOUT_MS;

    expect(elapsed).toBeLessThan(6000); // ANTI-HANG ceiling, not an SLA (#210) — a real hang blows any ceiling; widen-safe, do NOT tighten
    // FAIL CLOSED is the security-relevant half: a timeout must never report the
    // port free. ONLY ECONNREFUSED may do that, and this was not one.
    expect(probe.reachable).toBe(true);
    expect(probe.parseable).toBe(false);
    // DELIBERATE TIGHTENING, stated rather than smuggled: pre-fix a stalled body
    // returned ok=TRUE (headers said 200) with parseable=false; the deadline path
    // now reports ok=false too. The only consumer is launchd.ts:149,
    // `if (!probe.ok || !probe.parseable) return "unreadable"` — so the
    // classification is IDENTICAL either way and no behaviour depends on the
    // change. It is pinned here because a timeout claiming ok=true is a claim the
    // probe cannot support.
    expect(probe.ok).toBe(false);
  }, 15000);

  it("TWIN: a healthy daemon still probes as reachable + parseable", async () => {
    const srv = await healthyServer({ status: "ok", version: VERSION });
    const init = await import("../src/cli/init.js");
    const probe = await init.probeHealth(srv.port);
    srv.close();
    expect(probe.reachable).toBe(true);
    expect(probe.ok).toBe(true);
    expect(probe.parseable).toBe(true);
  }, 15000);

  it("TWIN: a closed port is still the ONLY thing that reports the port free", async () => {
    const srv = await healthyServer({ ok: true });
    const port = srv.port;
    srv.close();
    await new Promise((r) => setTimeout(r, 100));
    const init = await import("../src/cli/init.js");
    const probe = await init.probeHealth(port);
    expect(probe.reachable).toBe(false); // ECONNREFUSED
  }, 15000);
});

describe("v2.24.10 relay doctor --remote — hub probes are bounded", () => {
  it("HARM: a stalling hub does not hang the diagnostic", async () => {
    const srv = await stallingBodyServer();
    const doctor = await import("../src/cli/doctor.js");
    const t0 = Date.now();
    const code = await doctor.run(["--remote", srv.url]);
    const elapsed = Date.now() - t0;
    srv.close();
    // Both hub probes are 5s-bounded; a stall must surface as a FAIL/WARN
    // report, not an unbounded wait.
    // ANTI-HANG ceiling, not an SLA (#210) — a real hang blows any ceiling; widen-safe,
    // do NOT tighten. Judgment call: was 14000, but two sequential 5s-bounded probes give
    // a ~10s bounded floor, so the 4s cushion was thin for #210 contention. Widened to
    // 20000, kept under the 25s per-test timeout so a true hang still trips the harness.
    expect(elapsed).toBeLessThan(20000);
    expect(typeof code).toBe("number");
  }, 25000);
});
