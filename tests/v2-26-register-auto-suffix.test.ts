// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// v2.26 — opt-in same-name instance auto-suffix. Semantic + adversarial tests
// for on_name_collision="suffix": the DEFAULT still rejects; force+CAS still
// wins; the reuse probe uses the SAME active-held predicate as the collision
// check (so it can never hand a LIVE instance's name to a new registrant); and
// a reused slot never inherits undelivered mail.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v226-suffix-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleSendMessage, handleGetMessages } = await import("../src/tools/messaging.js");
const {
  closeDb,
  resolveAvailableInstanceName,
  isNameActivelyHeld,
  markAgentOffline,
  getAgentAuthData,
} = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function register(name: string, opts: Record<string, unknown> = {}) {
  return parse(
    handleRegisterAgent({
      name,
      role: "builder",
      capabilities: [],
      ...opts,
    } as any)
  );
}

beforeAll(() => {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});

afterAll(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.26 auto-suffix — default behavior unchanged", () => {
  it("default (no on_name_collision) still rejects an actively-held name with NAME_COLLISION_ACTIVE", () => {
    expect(register("svc1").success).toBe(true);
    const second = register("svc1");
    expect(second.success).toBe(false);
    expect(second.error_code).toBe(ERROR_CODES.NAME_COLLISION_ACTIVE);
  });

  it("on_name_collision='reject' is explicit-default and also rejects", () => {
    expect(register("svc1b").success).toBe(true);
    const second = register("svc1b", { on_name_collision: "reject" });
    expect(second.success).toBe(false);
    expect(second.error_code).toBe(ERROR_CODES.NAME_COLLISION_ACTIVE);
  });

  it("suffix opt-in on a FREE name does NOT suffix — registers the plain name", () => {
    const r = register("svc3", { on_name_collision: "suffix" });
    expect(r.success).toBe(true);
    expect(r.agent.name).toBe("svc3");
    expect(r.assigned_name).toBeUndefined();
  });
});

describe("v2.26 auto-suffix — opt-in assigns a relay instance name", () => {
  it("suffix on an actively-held name registers as <name>-2 with an unmissable, not-restart-stable warning", () => {
    expect(register("svc2").success).toBe(true);
    const r = register("svc2", { on_name_collision: "suffix" });
    expect(r.success).toBe(true);
    expect(r.agent.name).toBe("svc2-2");
    expect(r.requested_name).toBe("svc2");
    expect(r.assigned_name).toBe("svc2-2");
    expect(r.instance_warning).toMatch(/NOT stable across restarts/i);
    expect(r.instance_warning).toMatch(/discover_agents/);
    // stays inside AGENT_NAME_PATTERN (no special chars → URI/shell/codex-relay safe)
    expect(r.agent.name).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  });

  it("force+expected_session_id TAKEOVER wins over suffix (precedence preserved)", () => {
    expect(register("svc8").success).toBe(true);
    const sid = getAgentAuthData("svc8")?.session_id ?? null;
    const r = register("svc8", { on_name_collision: "suffix", force: true, expected_session_id: sid });
    expect(r.success).toBe(true);
    expect(r.agent.name).toBe("svc8"); // took over the name, did NOT suffix
    expect(r.assigned_name).toBeUndefined();
  });
});

describe("v2.26 auto-suffix — reuse probe cannot disagree with the collision check", () => {
  it("isNameActivelyHeld is true for a fresh register and false after markAgentOffline", () => {
    expect(register("svc7").success).toBe(true);
    expect(isNameActivelyHeld(getAgentAuthData("svc7"))).toBe(true);
    const sid = getAgentAuthData("svc7")?.session_id as string;
    markAgentOffline("svc7", sid);
    expect(isNameActivelyHeld(getAgentAuthData("svc7"))).toBe(false);
    expect(isNameActivelyHeld(null)).toBe(false);
  });

  it("NEVER reuses a LIVE <name>-N slot (the two-live-one-name hazard) — skips to the next N", () => {
    expect(register("svc4").success).toBe(true);
    // make svc4-2 exist AND be actively held (fresh register)
    expect(register("svc4", { on_name_collision: "suffix" }).agent.name).toBe("svc4-2");
    expect(isNameActivelyHeld(getAgentAuthData("svc4-2"))).toBe(true);
    // resolve must SKIP the live -2 and pick -3, not hand the live instance's name away
    expect(resolveAvailableInstanceName("svc4")).toBe("svc4-3");
  });

  it("safely REUSES a <name>-N slot that is not-actively-held AND drained (bounds N)", () => {
    expect(register("svc5").success).toBe(true);
    expect(register("svc5", { on_name_collision: "suffix" }).agent.name).toBe("svc5-2");
    const sid = getAgentAuthData("svc5-2")?.session_id as string;
    markAgentOffline("svc5-2", sid); // not-actively-held, no mail
    expect(resolveAvailableInstanceName("svc5")).toBe("svc5-2"); // reused, not svc5-3
  });

  it("does NOT reuse a not-held slot that still holds UNDELIVERED mail (never inherit mail) — skips it", () => {
    expect(register("svc6").success).toBe(true);
    expect(register("svc6", { on_name_collision: "suffix" }).agent.name).toBe("svc6-2");
    const sid = getAgentAuthData("svc6-2")?.session_id as string;
    markAgentOffline("svc6-2", sid);
    // leave undelivered mail addressed to svc6-2
    expect(register("sender6").success).toBe(true);
    expect(parse(handleSendMessage({ from: "sender6", to: "svc6-2", content: "held", priority: "normal" } as any)).success).toBe(true);
    expect(resolveAvailableInstanceName("svc6")).toBe("svc6-3"); // skip -2 (has mail), never inherit
  });
});

describe("v2.26 auto-suffix — the suffixed instance has an independent mailbox", () => {
  it("mail sent to <name>-2 reaches -2 and is NOT visible to <name>", () => {
    expect(register("svc9").success).toBe(true);
    expect(register("svc9", { on_name_collision: "suffix" }).agent.name).toBe("svc9-2");
    expect(register("sender9").success).toBe(true);
    expect(parse(handleSendMessage({ from: "sender9", to: "svc9-2", content: "for the instance", priority: "normal" } as any)).success).toBe(true);

    const forInstance = parse(handleGetMessages({ agent_name: "svc9-2", since: "all", status: "all", limit: 100, lane: "all", peek: true } as any));
    expect(forInstance.messages.some((m: any) => m.content === "for the instance")).toBe(true);

    const forBase = parse(handleGetMessages({ agent_name: "svc9", since: "all", status: "all", limit: 100, lane: "all", peek: true } as any));
    expect(forBase.messages.some((m: any) => m.content === "for the instance")).toBe(false);
  });
});
