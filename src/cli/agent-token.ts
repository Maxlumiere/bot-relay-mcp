// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The CLI's agent-token resolution for an already-registered identity (`relay resolve`, `relay whoami`): ONE copy.
 *
 * Precedence: a REMOTE route gets only ITS credential (RELAY_AGENT_TOKEN, or its own vault scope; never the local
 * vault). Locally: $RELAY_AGENT_TOKEN (operator-explicit, trusted as provided), else the per-instance vault token, which
 * MUST authenticate against the local DB BEFORE anything is sent (the one authorizer: state, then hash). No mint path.
 * Every refusal is said on stderr with the verb's prefix and answers an exit code (2: a local refusal, nothing sent).
 */
import { isValidTokenShape } from "../spawn/validation.js";
import type { RelayRoute } from "./relay-client.js";

export type AgentTokenResult = { token: string } | { code: number };

export async function resolveCliAgentToken(verb: string, agent: string, route: RelayRoute): Promise<AgentTokenResult> {
  const say = (line: string): void => {
    process.stderr.write(`relay ${verb}: ${line}`);
  };
  const envToken = process.env.RELAY_AGENT_TOKEN;
  if (route.kind === "remote") {
    const { remoteToken, envSelects } = await import("./relay-client.js");
    const token = await remoteToken(route.host, route.port, agent, { envSelected: await envSelects(route.host, route.port) });
    if (!token) {
      say(`no token for "${agent}" on the remote relay ${route.host}:${route.port}: set RELAY_AGENT_TOKEN (the local vault is never sent to a remote).\n`);
      return { code: 2 };
    }
    return { token };
  }
  if (isValidTokenShape(envToken)) return { token: envToken as string };

  // ADR-0048: the ONE strict resolver; a fault is said and ends the verb.
  const { pinResolvedDbPath } = await import("./_instance-db.js");
  const resolveFault = await pinResolvedDbPath();
  if (resolveFault) {
    say(`instance resolution failed: ${resolveFault}\n`);
    return { code: 2 };
  }
  let dbOpen = false;
  try {
    const { initializeDb, getAgentAuthData } = await import("../db.js");
    await initializeDb();
    dbOpen = true;
    const { defaultTokenStore } = await import("../token-store.js");
    const vaultToken = await defaultTokenStore().read(agent);
    const authData = getAgentAuthData(agent);
    // SEC-20: the row's STATE first. A revoke scrubs the vault, so checking the vault first told a revoked agent
    // "mismatched, use --force".
    const { revokedStateOf } = await import("../auth-verdict.js");
    const revoked = revokedStateOf(authData);
    const revokedLine = (state: string) =>
      `agent "${agent}" is ${state === "recovery_pending" ? "awaiting recovery" : "revoked"}: its token authorizes nothing (AUTH_FAILED).\n` +
      `  • Re-register with its recovery token, or reset the identity: relay recover ${agent}\n`;
    if (revoked) {
      say(revokedLine(revoked));
      return { code: 2 };
    }
    if (authData && authData.token_hash) {
      // SEC-20: the one authorizer (state, then hash, then revalidate), never the hash alone.
      const { authorizeAgentToken } = await import("../authorize-token.js");
      const a = vaultToken ? await authorizeAgentToken(agent, vaultToken) : null;
      if (a?.ok) return { token: vaultToken as string };
      if (a && (a.refusal === "revoked" || a.refusal === "recovery_pending")) {
        say(revokedLine(a.refusal));
        return { code: 2 };
      }
      say(
        `the vault token for "${agent}" does not authenticate against the DB (missing / stale / mismatched). NOT sending a mismatched credential.\n` +
          `  • Rotate deliberately (invalidates the old token): relay mint-token ${agent} --force\n` +
          `  • Or reset the identity: relay recover ${agent}\n`,
      );
      return { code: 2 };
    }
    say(`no usable token for "${agent}" — not registered locally and env RELAY_AGENT_TOKEN is unset/invalid. Export RELAY_AGENT_TOKEN or register first.\n`);
    return { code: 2 };
  } catch (err) {
    say(`could not resolve a token: ${err instanceof Error ? err.message : String(err)}\n`);
    return { code: 2 };
  } finally {
    if (dbOpen) {
      try {
        const { closeDb } = await import("../db.js");
        closeDb();
      } catch {
        /* ignore */
      }
    }
  }
}
