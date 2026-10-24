// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The live-relay guard's FIXTURE SET (tests/_setup/live-relay-guard.mjs, fixtureNamesInText): every shape in which a
 * test hands a literal to the relay as an agent identity. A fixture that is also a live fleet name is a collision the
 * guard names, so a shape the scanner misses is a collision nobody sees. Each case below is a name used in ONE shape
 * only, and must be found; the old scanner (name-ish keys only) found none of the new shapes.
 */
import { describe, it, expect } from "vitest";
import { fixtureNamesInText } from "./_setup/live-relay-guard.mjs";

const found = (text: string) => [...fixtureNamesInText(text)].sort();

describe("the guard's fixture scanner: a name in any identity shape is found", () => {
  it("a name-ish KEY (the original shape) is still found", () => {
    expect(found(`handleRegisterAgent({ name: "fx-key", role: "r" }); send({ from: "fx-a", to: "fx-b" })`)).toEqual(["fx-a", "fx-b", "fx-key"]);
  });
  it("a name used ONLY in an ENV var: an env object's key, and a shell or env string", () => {
    expect(found(`env: { ...process.env, HOME: home, RELAY_AGENT_NAME: "fx-env" }`)).toEqual(["fx-env"]);
    expect(found(`spawnSync("sh", ["-c", "RELAY_AGENT_NAME=fx-shell bash hook.sh"])`)).toEqual(["fx-shell"]);
    expect(found(`const e = { CODEX_AGENT_NAME: 'fx-other' }`)).toEqual(["fx-other"]);
  });
  it("a name used ONLY as a positional or flag CLI argument", () => {
    expect(found(`runMint(["fx-mint", "--role", "builder", "--capabilities", "x"])`)).toEqual(["fx-mint"]);
    expect(found(`pair.run([srv.url, "--name", "fx-pair", "--yes"])`)).toEqual(["fx-pair"]);
    expect(found(`cli(["watch", "--agent", "fx-watch"])`)).toEqual(["fx-watch"]);
  });
  it("a name used ONLY in an SQL INSERT … VALUES", () => {
    expect(found(`db.prepare("INSERT INTO agent_bindings (binding_id, agent_name, bound_via) VALUES ('b-1', 'fx-sql', 'launch-intent')")`)).toEqual(["b-1", "fx-sql", "launch-intent"]);
  });
  it("an agent-taking call's first argument; never an agent CLI-PROFILE lookup (a product registry id)", () => {
    expect(found(`registerAgent("fx-call", "builder", []); getAgentAuthData("fx-auth")`)).toEqual(["fx-auth", "fx-call"]);
    expect(found(`const p = getAgentCliProfile("codex")`)).toEqual([]);
  });
});
