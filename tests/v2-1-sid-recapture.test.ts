// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4f.1 — capturedSessionId re-capture on mid-lifetime register.
 *
 * Verifies:
 *   1. Fresh stdio process + no pre-register → handleRegisterAgent via the
 *      stdio dispatcher updates the captured session_id to the fresh value.
 *   2. Re-register rotates session_id → captured sid updates to the NEW one.
 *   3. Registering a DIFFERENT name than RELAY_AGENT_NAME → captured sid unchanged.
 *   4. HTTP transport → captured sid unchanged (no stdio state to track).
 *
 * Tests exercise the handler directly with a synthesized request-context
 * (same pattern as the withCaller wrapper in tools.test.ts). That's faithful
 * to production: the real dispatcher always establishes a context before
 * calling a handler, so wrapping in requestContext.run(...) mirrors it
 * exactly without spawning a process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-sid-recapture-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { updateCapturedSessionId, getCapturedSessionId } = await import("../src/transport/stdio.js");
const { closeDb, registerAgent } = await import("../src/db.js");
const { requestContext } = await import("../src/request-context.js");

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  closeDb();
  delete process.env.RELAY_AGENT_NAME;
  updateCapturedSessionId(null);
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}
beforeEach(cleanup);
afterEach(cleanup);

function runWith<T>(
  transport: "stdio" | "http",
  fn: () => T
): T {
  return requestContext.run({ transport }, fn);
}

describe("v2.1 Phase 4f.1 — capturedSessionId re-capture", () => {
  it("(1) fresh stdio + no pre-register → register updates captured sid", () => {
    process.env.RELAY_AGENT_NAME = "mid-reg";
    expect(getCapturedSessionId()).toBeNull();

    const resp = runWith("stdio", () =>
      handleRegisterAgent({ name: "mid-reg", role: "r", capabilities: [] })
    );
    const body = parseResult(resp);
    expect(body.success).toBe(true);
    const newSid = body.agent.session_id as string;
    expect(newSid).toBeTruthy();

    expect(getCapturedSessionId()).toBe(newSid);
  });

  it("(2) re-register rotates session_id → captured sid updates to the NEW sid", () => {
    process.env.RELAY_AGENT_NAME = "rotator";

    // First register (pre-existing row simulation via db directly so we can
    // compare sids across the re-register call).
    const first = registerAgent("rotator", "r", []);
    const token = first.plaintext_token!;
    const firstSid = first.agent.session_id!;
    updateCapturedSessionId(firstSid); // simulate startup captureSessionId()

    // Re-register via handler — carries the agent_token for auth path, and
    // rotates the session_id.
    // v2.2.1 B2: force=true to bypass active-name collision gate; this
    // test exercises the captureSessionId re-capture semantic, which is
    // independent of the collision policy.
    const resp = runWith("stdio", () =>
      handleRegisterAgent({
        name: "rotator",
        role: "r",
        capabilities: [],
        agent_token: token,
        force: true,
      } as any)
    );
    const body = parseResult(resp);
    const secondSid = body.agent.session_id as string;
    expect(secondSid).not.toBe(firstSid);
    expect(getCapturedSessionId()).toBe(secondSid);
  });

  it("(3) register a DIFFERENT name than RELAY_AGENT_NAME → captured sid unchanged", () => {
    process.env.RELAY_AGENT_NAME = "owner";
    updateCapturedSessionId("preserved-sid");

    runWith("stdio", () =>
      handleRegisterAgent({ name: "some-other-agent", role: "r", capabilities: [] })
    );

    // Our own sid should NOT have been touched by registering someone else.
    expect(getCapturedSessionId()).toBe("preserved-sid");
  });

  it("(4) HTTP transport → captured sid unchanged (stateless path)", () => {
    process.env.RELAY_AGENT_NAME = "http-caller";
    updateCapturedSessionId("preserved-http");

    runWith("http", () =>
      handleRegisterAgent({ name: "http-caller", role: "r", capabilities: [] })
    );

    // Even though name matches, HTTP transport has no process-scoped sid to
    // track — the setter must not fire.
    expect(getCapturedSessionId()).toBe("preserved-http");
  });
});
