// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-01 (security/invariants.json): no token is issued over HTTP without a credential bound to the row or the mint
 * secret. stdio is OUT of scope (PR-D Q6), conditional on SEC-04 holding (see the BOUNDARY twin).
 * SEC-01.T1, on the INSTALLED package: a register of a NEW name with no registration secret is refused with
 * MINT_SECRET_REQUIRED, and no agent row or token is created. Twins: the same register WITH the secret succeeds, and
 * an existing name refreshes itself with its own token. (A guard that refuses everything also passes the harm half.)
 * The KNOWN-BAD control's discriminator: the published 3.0.1 issued that token (its open mint).
 */
import { describe, it, expect, afterEach } from "vitest";
import { sandbox, startHttpDaemon, stdioCall, dbQuery, windowsSidProbe, type HttpDaemon } from "./_installed.js";

const daemons: HttpDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
});

const countAgents = (sb: ReturnType<typeof sandbox>, name?: string) =>
  Number((dbQuery<{ n: number }>(sb, name ? "SELECT COUNT(*) AS n FROM agents WHERE name = ?" : "SELECT COUNT(*) AS n FROM agents", ...(name ? [name] : []))[0] ?? { n: 0 }).n);

describe("SEC-01.T1: no token without a credential (the installed package)", () => {
  it("SEC-01.T1 HARM http: a NEW name with no registration secret is refused, and no row or token is created", async (ctx) => {
    const sb = sandbox("s01-http");
    const d = await startHttpDaemon(sb);
    daemons.push(d);
    const before = countAgents(sb);
    const r = await d.rpc("register_agent", { name: "sec01-new", role: "worker", capabilities: [] });
    // The stimulus returned a tool result (not a transport or JSON-RPC error)...
    expect(r.rpc_error, `not a tool result: ${JSON.stringify(r)}`).toBeUndefined();
    const after = countAgents(sb);
    // ...and with no token issued, it must be THE mint gate's refusal (an unknown tool or a schema error is not one).
    if (r.agent_token === undefined) expect(r.error_code, JSON.stringify(r)).toBe("MINT_SECRET_REQUIRED");
    // The observation mark (sec-20.release.ts): only now, after every fixture call, before the harm assertion.
    ctx.task.meta.stimulus_returned = true;
    expect(r.agent_token, `a token was issued with no credential: ${JSON.stringify(r)}`).toBeUndefined();
    expect(after, "no agent row was created").toBe(before);
  });

  // PR-D Q6 (ruled 13 Oct): stdio is OUT of scope, conditional on SEC-04 (a stdio register is a same-user act gated
  // by DB-file access). This BOUNDARY twin pins that: a change in either direction trips it and needs a ruling.
  it("SEC-01.T1 BOUNDARY stdio (PR-D Q6): a NEW name over stdio registers WITHOUT a secret, as ruled", async () => {
    const sb = sandbox("s01-stdio");
    const r = await stdioCall(sb, "register_agent", { name: "sec01-new-stdio", role: "worker", capabilities: [] });
    expect(typeof r.agent_token, `PR-D Q6 says stdio needs no secret; the installed package now refuses it: ${JSON.stringify(r)}`).toBe("string");
    expect(countAgents(sb, "sec01-new-stdio")).toBe(1);
  });

  it("SEC-01.T1 TWIN http: the same register WITH the registration secret issues a token", async () => {
    const sb = sandbox("s01-twin");
    const d = await startHttpDaemon(sb);
    daemons.push(d);
    const r = await d.rpc("register_agent", { name: "sec01-ok", role: "worker", capabilities: [] }, d.mintHeaders());
    expect(r.success, JSON.stringify(r) + (r.success === true ? "" : windowsSidProbe(sb))).toBe(true);
    expect(typeof r.agent_token).toBe("string");
    expect(countAgents(sb, "sec01-ok")).toBe(1);
  });

  it("SEC-01.T1 TWIN http: an existing name refreshes itself with its own token, no secret", async () => {
    const sb = sandbox("s01-self");
    const d = await startHttpDaemon(sb);
    daemons.push(d);
    const first = await d.rpc("register_agent", { name: "sec01-self", role: "worker", capabilities: [] }, d.mintHeaders());
    expect(typeof first.agent_token, JSON.stringify(first)).toBe("string");
    // The token holder re-registers its own active name: a takeover of its own session (ADR-0012: force + the
    // session it holds), with its token and NO registration secret. The mint gate must not stand in the way.
    const session = (first.agent as { session_id?: string } | undefined)?.session_id;
    expect(typeof session, JSON.stringify(first)).toBe("string");
    const again = await d.rpc("register_agent", { name: "sec01-self", role: "worker", capabilities: [], agent_token: first.agent_token, force: true, expected_session_id: session });
    expect(again.success, JSON.stringify(again)).toBe(true);
  });
});
