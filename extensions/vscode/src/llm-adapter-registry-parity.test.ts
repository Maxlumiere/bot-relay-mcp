// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.6.0 (P4 — data-driven Tether) drift guard + CLI-parity matrix.
//
// The extension SOURCE can't import the relay registry (it's outside the
// extension's tsconfig rootDir), so llm-adapter.ts keeps a MIRROR (TETHER_LLM).
// This TEST *does* import the real registry (src/agent-cli-profiles.ts) and
// asserts the mirror's registry-owned wake VALUES stay byte-in-sync, plus that
// the package.json `agentLlm` enum and adapterFor() cover EVERY registry CLI.
// A new CLI added to the registry that isn't mirrored (or isn't in the enum, or
// has no adapter) fails here — the registry stays the single source of truth.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_CLI_PROFILES } from "../../../src/agent-cli-profiles.js";
import { TETHER_LLM, adapterFor, type WakeContext, type WakeTerminal } from "./llm-adapter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fakeCtx(): { ctx: WakeContext; ops: string[] } {
  const ops: string[] = [];
  const terminal: WakeTerminal = {
    sendText: (t, n) => ops.push(`sendText:${JSON.stringify(t)}:${n}`),
    show: () => {},
  };
  const ctx: WakeContext = {
    terminal,
    delay: async (ms) => {
      ops.push(`delay:${ms}`);
    },
    sendSequenceToTerminal: async (t) => {
      ops.push(`seq:${JSON.stringify(t)}`);
    },
  };
  return { ctx, ops };
}

describe("v0.6.0 — Tether LLM mirror ↔ relay registry parity", () => {
  it("DRIFT GUARD: TETHER_LLM ids == the relay registry ids", () => {
    expect(TETHER_LLM.map((e) => e.id).sort()).toEqual(AGENT_CLI_PROFILES.map((p) => p.id).sort());
  });

  it("DRIFT GUARD: each mirror wake VALUE byte-matches the registry WakeSpec", () => {
    for (const p of AGENT_CLI_PROFILES) {
      const m = TETHER_LLM.find((e) => e.id === p.id);
      expect(m, `no Tether mirror entry for registry CLI "${p.id}"`).toBeTruthy();
      // The registry OWNS these five fields — the mirror must match exactly.
      expect(m!.wake.wakeText, `${p.id}.wakeText`).toBe(p.wake.wakeText);
      expect(m!.wake.submitKey, `${p.id}.submitKey`).toBe(p.wake.submitKey);
      expect(m!.wake.submitMethod, `${p.id}.submitMethod`).toBe(p.wake.submitMethod);
      expect(m!.wake.submitDelayMs, `${p.id}.submitDelayMs`).toBe(p.wake.submitDelayMs);
      expect(m!.wake.nativeSelfWake, `${p.id}.nativeSelfWake`).toBe(p.wake.nativeSelfWake);
    }
  });

  it("DRIFT GUARD: package.json `agentLlm` enum == the registry ids", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf-8"));
    const enumVals: string[] =
      pkg.contributes.configuration.properties["bot-relay.tether.agentLlm"].enum;
    expect([...enumVals].sort()).toEqual(AGENT_CLI_PROFILES.map((p) => p.id).sort());
  });

  it("CLI-PARITY MATRIX: adapterFor resolves a working adapter for EVERY registry CLI", async () => {
    for (const p of AGENT_CLI_PROFILES) {
      const a = adapterFor(p.id);
      expect(a.id, `adapterFor("${p.id}") resolved the wrong id`).toBe(p.id);
      const { ctx, ops } = fakeCtx();
      await a.wake(ctx);
      expect(ops.length, `adapterFor("${p.id}").wake produced no ops`).toBeGreaterThan(0);
      // Every CLI's wake types its registry wakeText first.
      expect(ops[0]).toContain(JSON.stringify(p.wake.wakeText));
    }
  });

  it("adapterFor falls back to claude for an unknown / unregistered id", () => {
    expect(adapterFor("gemini-cli").id).toBe("claude");
    expect(adapterFor(undefined).id).toBe("claude");
  });
});
