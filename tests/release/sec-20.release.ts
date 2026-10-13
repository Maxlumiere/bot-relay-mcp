// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20 (security/invariants.json): every token consumer refuses a token whose row is not authorized by auth_state.
 * Ported from the SEC-20 acceptance tool used at the 8 Oct install, on the INSTALLED package (its daemon and its
 * `relay` CLI):
 *   T1: `relay send --from` a REVOKED agent is refused and writes no message; with no token in its env the refusal
 *       says "revoked" (not "mismatched"). Twin: an ACTIVE agent delivers.
 *   T2: no mint, register or rotate verb brings a revoked agent back. Twins: the same verb on an ACTIVE agent still
 *       works; `relay recover` then a fresh register does bring it back; a recovery_pending agent comes back with
 *       its own recovery token.
 * The published 3.0.1 FAILS T1 and T2 (MEASURED 13 Oct: the revoked send was delivered; `mint-token --force`
 * revived the revoked row).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sandbox, startHttpDaemon, relayCli, dbQuery, type HttpDaemon, type Sandbox } from "./_installed.js";

let sb: Sandbox;
let d: HttpDaemon;
const tok: Record<string, string> = {};

const stateOf = (name: string) => (dbQuery<{ s: string | null }>(sb, "SELECT auth_state AS s FROM agents WHERE name = ?", name)[0]?.s ?? "<no row>");
const rowsFrom = (from: string) => Number(dbQuery<{ n: number }>(sb, "SELECT COUNT(*) AS n FROM messages WHERE from_agent = ?", from)[0]!.n);
const noAgentEnv = { RELAY_AGENT_TOKEN: "", RELAY_AGENT_NAME: "" };

beforeAll(async () => {
  sb = sandbox("s20");
  d = await startHttpDaemon(sb);
  for (const [name, caps] of [["acc-admin", ["admin", "rotate_others"]], ["acc-receiver", []], ["acc-revoked", []], ["acc-active", []], ["acc-pending", []]] as const) {
    const r = await d.rpc("register_agent", { name, role: "worker", capabilities: [...caps] }, d.mintHeaders());
    if (typeof r.agent_token !== "string") throw new Error(`setup: register ${name} failed: ${JSON.stringify(r)} ${d.stderr().slice(-500)}`);
    tok[name] = r.agent_token;
  }
  const rv = await d.rpc("revoke_token", { target_agent_name: "acc-revoked", revoker_name: "acc-admin", agent_token: tok["acc-admin"], issue_recovery: false });
  if (rv.success !== true) throw new Error(`setup: revoke failed: ${JSON.stringify(rv)}`);
}, 120_000);
afterAll(async () => {
  await d?.stop();
});

describe("SEC-20.T1: a revoked agent's token sends nothing", () => {
  it("SEC-20.T1 HARM relay send --from a REVOKED agent is refused and writes no message", () => {
    const r = relayCli(sb, ["send", "acc-receiver", "from the revoked", "--from", "acc-revoked"], { RELAY_AGENT_TOKEN: tok["acc-revoked"] });
    expect(rowsFrom("acc-revoked"), `a message was written: ${r.stdout}${r.stderr}`).toBe(0);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/AUTH_FAILED|revoked/i);
  });

  it("SEC-20.T1 HARM with no token in its env, the refusal says the agent is revoked", () => {
    const r = relayCli(sb, ["send", "acc-receiver", "no env token", "--from", "acc-revoked"], noAgentEnv);
    expect(r.status).not.toBe(0);
    expect(r.stderr, r.stderr).toMatch(/revoked/i);
    expect(r.stderr, r.stderr).not.toMatch(/mismatched/i);
  });

  it("SEC-20.T1 TWIN relay send --from an ACTIVE agent delivers", () => {
    const r = relayCli(sb, ["send", "acc-receiver", "from the active", "--from", "acc-active"], { RELAY_AGENT_TOKEN: tok["acc-active"] });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(rowsFrom("acc-active")).toBe(1);
  });
});

describe("SEC-20.T2: only relay recover (or its own recovery token) brings an agent back", () => {
  it("SEC-20.T2 HARM no mint, register or rotate verb brings a REVOKED agent back", async () => {
    const tried: string[] = [];
    const after = (what: string, result: unknown) => tried.push(`${what}: ${String(JSON.stringify(result)).slice(0, 120)} -> ${stateOf("acc-revoked")}`);
    after("relay mint-token", relayCli(sb, ["mint-token", "acc-revoked"], noAgentEnv).status);
    after("relay mint-token --force", relayCli(sb, ["mint-token", "acc-revoked", "--force"], noAgentEnv).status);
    after("register_agent (the registration secret, no token)", await d.rpc("register_agent", { name: "acc-revoked", role: "worker", capabilities: [] }, d.mintHeaders()));
    after("register_agent (its old token)", await d.rpc("register_agent", { name: "acc-revoked", role: "worker", capabilities: [], agent_token: tok["acc-revoked"] }, d.mintHeaders()));
    after("rotate_token (its old token)", await d.rpc("rotate_token", { agent_name: "acc-revoked", agent_token: tok["acc-revoked"] }));
    after("rotate_token_admin (an admin)", await d.rpc("rotate_token_admin", { target_agent_name: "acc-revoked", rotator_name: "acc-admin", agent_token: tok["acc-admin"] }));
    expect(tried.filter((t) => !t.endsWith("-> revoked")), `revived by:\n${tried.join("\n")}`).toEqual([]);
  });

  it("SEC-20.T2 TWIN relay mint-token --force still works on an ACTIVE agent", () => {
    const r = relayCli(sb, ["mint-token", "acc-active", "--force"], noAgentEnv);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(stateOf("acc-active")).toBe("active");
  });

  it("SEC-20.T2 TWIN relay recover, then a fresh register, brings a revoked agent back", async () => {
    const rec = relayCli(sb, ["recover", "acc-revoked", "--yes", "--db-path", sb.dbPath], noAgentEnv);
    expect(rec.status, rec.stdout + rec.stderr).toBe(0);
    const reg = await d.rpc("register_agent", { name: "acc-revoked", role: "worker", capabilities: [] }, d.mintHeaders());
    expect(reg.success, JSON.stringify(reg)).toBe(true);
    expect(stateOf("acc-revoked")).toBe("active");
  });

  it("SEC-20.T2 TWIN a recovery_pending agent comes back with its own recovery token", async () => {
    const rv = await d.rpc("revoke_token", { target_agent_name: "acc-pending", revoker_name: "acc-admin", agent_token: tok["acc-admin"], issue_recovery: true });
    expect(rv.success, JSON.stringify(rv)).toBe(true);
    expect(stateOf("acc-pending")).toBe("recovery_pending");
    const recovery = rv.recovery_token;
    expect(typeof recovery, JSON.stringify(rv)).toBe("string");
    const reg = await d.rpc("register_agent", { name: "acc-pending", role: "worker", capabilities: [], recovery_token: recovery });
    expect(reg.success, JSON.stringify(reg)).toBe(true);
    expect(stateOf("acc-pending")).toBe("active");
  });
});
