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
 *   T2: no mint, register or rotate verb brings a revoked agent back: ONE harm per verb, each on its OWN revoked row
 *       (a revival by one must not break the next one's precondition), each refusal checked for its REASON (an
 *       unknown tool, a schema rejection or a broken endpoint also answers AUTH_FAILED: MEASURED 20 Oct). Twins: the
 *       same verb, with otherwise equivalent valid input, succeeds on an ACTIVE row (or a NEW name, where a revoked
 *       row's twin is a fresh one); `relay recover` then a fresh register brings it back; a recovery_pending agent
 *       comes back with its own recovery token.
 * The published 3.0.1 FAILS T1 and T2 (MEASURED 13 Oct: the revoked send was delivered; `mint-token --force`
 * revived the revoked row).
 *
 * THE OBSERVATION MARK (the known-bad control, scripts/release-invariants.mjs): a HARM sets
 * `ctx.task.meta.stimulus_returned` only AFTER its stimulus returned a well-formed response, immediately before its
 * harm assertion; every fixture call comes before it. A harm that fails WITHOUT the mark is a fixture fault, never
 * "the drift was seen".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sandbox, startHttpDaemon, relayCli, dbQuery, type HttpDaemon, type Sandbox } from "./_installed.js";

let sb: Sandbox;
let d: HttpDaemon;
const tok: Record<string, string> = {};
/** Each row's session at registration (a re-register of an ONLINE row is a takeover of its own session: ADR-0012). */
const sess: Record<string, string> = {};

const stateOf = (name: string) => (dbQuery<{ s: string | null }>(sb, "SELECT auth_state AS s FROM agents WHERE name = ?", name)[0]?.s ?? "<no row>");
const rowsFrom = (from: string) => Number(dbQuery<{ n: number }>(sb, "SELECT COUNT(*) AS n FROM messages WHERE from_agent = ?", from)[0]!.n);
const noAgentEnv = { RELAY_AGENT_TOKEN: "", RELAY_AGENT_NAME: "" };

/** One row per T2 verb: its own revoked row, and (where the twin needs one) its own active row. */
const T2_REVOKED = ["rv-mint", "rv-force", "rv-reg-secret", "rv-reg-token", "rv-rotate", "rv-rotate-admin"] as const;
const T2_ACTIVE = ["ac-reg-token", "ac-rotate", "ac-rotate-admin"] as const;

beforeAll(async () => {
  sb = sandbox("s20");
  d = await startHttpDaemon(sb);
  const rows: Array<[string, string[]]> = [
    ["acc-admin", ["admin", "rotate_others"]],
    ["acc-receiver", []],
    ["acc-revoked", []],
    ["acc-active", []],
    ["acc-pending", []],
    ...[...T2_REVOKED, ...T2_ACTIVE].map((n): [string, string[]] => [n, []]),
  ];
  for (const [name, caps] of rows) {
    const r = await d.rpc("register_agent", { name, role: "worker", capabilities: [...caps] }, d.mintHeaders());
    if (typeof r.agent_token !== "string") throw new Error(`setup: register ${name} failed: ${JSON.stringify(r)} ${d.stderr().slice(-500)}`);
    tok[name] = r.agent_token;
    sess[name] = String((r.agent as { session_id?: string } | undefined)?.session_id ?? "");
  }
  for (const name of ["acc-revoked", ...T2_REVOKED]) {
    const rv = await d.rpc("revoke_token", { target_agent_name: name, revoker_name: "acc-admin", agent_token: tok["acc-admin"], issue_recovery: false });
    if (rv.success !== true) throw new Error(`setup: revoke ${name} failed: ${JSON.stringify(rv)}`);
  }
}, 120_000);
afterAll(async () => {
  await d?.stop();
});

/** A CLI stimulus returned: the process ran to an exit code (not killed, not timed out). */
function cliReturned(r: { status: number | null; stdout: string; stderr: string }): void {
  expect(typeof r.status, `the CLI did not run to an exit code: ${r.stdout}${r.stderr}`).toBe("number");
}
/** An RPC stimulus returned: a parsed tool result with a boolean `success` (not a transport or JSON-RPC error). */
function rpcReturned(r: Record<string, unknown>): void {
  expect(r.rpc_error, `not a tool result: ${JSON.stringify(r)}`).toBeUndefined();
  expect(typeof r.success, `no boolean success: ${JSON.stringify(r)}`).toBe("boolean");
}

describe("SEC-20.T1: a revoked agent's token sends nothing", () => {
  it("SEC-20.T1 HARM relay send --from a REVOKED agent is refused and writes no message", (ctx) => {
    expect(stateOf("acc-revoked"), "precondition: the sender is revoked").toBe("revoked");
    const before = rowsFrom("acc-revoked");
    const r = relayCli(sb, ["send", "acc-receiver", "from the revoked", "--from", "acc-revoked"], { RELAY_AGENT_TOKEN: tok["acc-revoked"] });
    cliReturned(r);
    const written = rowsFrom("acc-revoked") - before;
    // Not delivered: then it must be the relay's refusal of THIS token, or the send never reached the check.
    if (written === 0) expect(r.stdout + r.stderr, "refused as an auth failure of the revoked row").toMatch(/revoked/i);
    ctx.task.meta.stimulus_returned = true;
    expect(written, `a message was written: ${r.stdout}${r.stderr}`).toBe(0);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
  });

  it("SEC-20.T1 HARM with no token in its env, the refusal says the agent is revoked", (ctx) => {
    expect(stateOf("acc-revoked"), "precondition: the sender is revoked").toBe("revoked");
    const before = rowsFrom("acc-revoked");
    const r = relayCli(sb, ["send", "acc-receiver", "no env token", "--from", "acc-revoked"], noAgentEnv);
    cliReturned(r);
    const written = rowsFrom("acc-revoked") - before;
    // Not delivered: then it must be the relay's own refusal (a token or auth message), not a crash.
    if (written === 0) expect(r.stderr, `not a relay refusal: ${r.stderr}`).toMatch(/relay send|token|AUTH_FAILED|revoked/i);
    ctx.task.meta.stimulus_returned = true;
    expect(written, `a message was written: ${r.stdout}${r.stderr}`).toBe(0);
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
  type Stim = { kind: "cli"; r: ReturnType<typeof relayCli> } | { kind: "rpc"; r: Record<string, unknown> };
  const said = (x: Stim) => (x.kind === "cli" ? `exit ${x.r.status}: ${x.r.stdout}${x.r.stderr}` : JSON.stringify(x.r));
  /** Each verb on its own REVOKED row, and the refusal it must give (MEASURED 20 Oct on the candidate). */
  const verbs: Array<{ what: string; row: (typeof T2_REVOKED)[number]; run: (row: string) => Promise<Stim>; refusal: (x: Stim) => void }> = [
    {
      what: "relay mint-token",
      row: "rv-mint",
      run: async (row) => ({ kind: "cli", r: relayCli(sb, ["mint-token", row], noAgentEnv) }),
      refusal: (x) => expect(said(x)).toMatch(/is revoked: its token cannot be reused/),
    },
    {
      what: "relay mint-token --force",
      row: "rv-force",
      run: async (row) => ({ kind: "cli", r: relayCli(sb, ["mint-token", row, "--force"], noAgentEnv) }),
      refusal: (x) => expect(said(x)).toMatch(/is revoked: --force will not bring it back/),
    },
    {
      what: "register_agent (the registration secret, no token)",
      row: "rv-reg-secret",
      run: async (row) => ({ kind: "rpc", r: await d.rpc("register_agent", { name: row, role: "worker", capabilities: [] }, d.mintHeaders()) }),
      refusal: (x) => expect(said(x)).toMatch(/Agent \\"rv-reg-secret\\" is revoked/),
    },
    {
      what: "register_agent (its old token)",
      row: "rv-reg-token",
      // The same takeover input as its twin (its own token, force, the session it held): still refused as revoked.
      run: async (row) => ({ kind: "rpc", r: await d.rpc("register_agent", { name: row, role: "worker", capabilities: [], agent_token: tok[row], force: true, expected_session_id: sess[row] }, d.mintHeaders()) }),
      refusal: (x) => expect(said(x)).toMatch(/Agent \\"rv-reg-token\\" is revoked/),
    },
    {
      what: "rotate_token (its old token)",
      row: "rv-rotate",
      run: async (row) => ({ kind: "rpc", r: await d.rpc("rotate_token", { agent_name: row, agent_token: tok[row] }) }),
      refusal: (x) => expect(said(x)).toMatch(/Agent \\"rv-rotate\\" has been revoked/),
    },
    {
      what: "rotate_token_admin (an admin)",
      row: "rv-rotate-admin",
      run: async (row) => ({ kind: "rpc", r: await d.rpc("rotate_token_admin", { target_agent_name: row, rotator_name: "acc-admin", agent_token: tok["acc-admin"] }) }),
      refusal: (x) => {
        expect(x.kind === "rpc" ? x.r.error_code : null, said(x)).toBe("INVALID_STATE");
        expect(said(x)).toMatch(/auth_state=\\"revoked\\"/);
      },
    },
  ];
  /** The harm for one verb. Its test titles are LITERAL below: `vitest list` reads titles statically (a template's
   *  `${...}` stays unexpanded: MEASURED 20 Oct), and the registry resolves ids through that list. */
  const harm = (what: string) => async (ctx: { task: { meta: { stimulus_returned?: boolean } } }) => {
    const v = verbs.find((x) => x.what === what)!;
    expect(v, `no verb ${what}`).toBeDefined();
    expect(stateOf(v.row), "precondition: this verb's own row is revoked").toBe("revoked");
    const x = await v.run(v.row);
    if (x.kind === "cli") cliReturned(x.r);
    else rpcReturned(x.r);
    const state = stateOf(v.row);
    // Still revoked: then it must have been refused FOR BEING REVOKED, or the verb never reached the check.
    if (state === "revoked") v.refusal(x);
    ctx.task.meta.stimulus_returned = true;
    expect(state, `revived by ${v.what}: ${said(x)}`).toBe("revoked");
  };
  it("SEC-20.T2 HARM relay mint-token does not bring a REVOKED agent back", harm("relay mint-token"));
  it("SEC-20.T2 HARM relay mint-token --force does not bring a REVOKED agent back", harm("relay mint-token --force"));
  it("SEC-20.T2 HARM register_agent (the registration secret, no token) does not bring a REVOKED agent back", harm("register_agent (the registration secret, no token)"));
  it("SEC-20.T2 HARM register_agent (its old token) does not bring a REVOKED agent back", harm("register_agent (its old token)"));
  it("SEC-20.T2 HARM rotate_token (its old token) does not bring a REVOKED agent back", harm("rotate_token (its old token)"));
  it("SEC-20.T2 HARM rotate_token_admin (an admin) does not bring a REVOKED agent back", harm("rotate_token_admin (an admin)"));

  it("SEC-20.T2 TWIN relay mint-token mints a NEW name (the verb works)", () => {
    const r = relayCli(sb, ["mint-token", "new-mint"], noAgentEnv);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Minted token for new agent "new-mint"/);
    expect(stateOf("new-mint")).toBe("active");
  });

  it("SEC-20.T2 TWIN register_agent with the registration secret registers a NEW name (the verb works)", async () => {
    const r = await d.rpc("register_agent", { name: "new-reg-secret", role: "worker", capabilities: [] }, d.mintHeaders());
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(typeof r.agent_token).toBe("string");
    expect(stateOf("new-reg-secret")).toBe("active");
  });

  it("SEC-20.T2 TWIN register_agent with its own token re-registers an ACTIVE agent", async () => {
    const r = await d.rpc("register_agent", { name: "ac-reg-token", role: "worker", capabilities: [], agent_token: tok["ac-reg-token"], force: true, expected_session_id: sess["ac-reg-token"] }, d.mintHeaders());
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(stateOf("ac-reg-token")).toBe("active");
  });

  it("SEC-20.T2 TWIN rotate_token with its own token rotates an ACTIVE agent", async () => {
    const r = await d.rpc("rotate_token", { agent_name: "ac-rotate", agent_token: tok["ac-rotate"] });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(typeof r.new_token).toBe("string");
    expect(stateOf("ac-rotate")).toBe("active");
  });

  it("SEC-20.T2 TWIN rotate_token_admin by an admin rotates an ACTIVE agent", async () => {
    const r = await d.rpc("rotate_token_admin", { target_agent_name: "ac-rotate-admin", rotator_name: "acc-admin", agent_token: tok["acc-admin"] });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(typeof r.new_token).toBe("string");
    expect(stateOf("ac-rotate-admin")).toBe("active");
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
