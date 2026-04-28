// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.4 — tool description quality gate.
 *
 * Glama's TDQS scores the relay 60% mean + 40% MIN across the tool
 * surface, so a single thin description (the v2.4.3 baseline had three
 * one-liners: list_webhooks, delete_webhook, leave_channel) drags the
 * whole score. These tests are not aesthetic — they are a hard floor
 * preventing future PRs from regressing the tool documentation surface.
 *
 * Each tool is required to:
 *   - Have a description >= MIN_DESCRIPTION_CHARS chars (catches one-liners).
 *   - Mention either Returns or Errors (basic Behavioral Transparency).
 *   - Mention "When to use" (Usage Guidelines presence — disambiguation).
 *   - Have a description for every input parameter (no anonymous params).
 *   - Follow the `verb_noun` naming convention (case + underscore form).
 *
 * Snapshot test G6 records the SHA-256 of every tool description so
 * future PRs that touch a description surface in the diff. Update the
 * snapshot consciously when intentional changes ship.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");

// Floor was picked empirically: the v2.4.4 rewrite shortest tool
// (`get_task`) sits around 600 chars; the v2.4.3 baseline floor was 50
// (`leave_channel: "Leave a channel you are a member of."`). 300 sits
// comfortably below the new floor while still catching a regression
// to one-liner shape.
const MIN_DESCRIPTION_CHARS = 300;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
}

function listTools(): ToolDef[] {
  // Spawn the built dist/index.js with a fresh tmp DB and ask MCP for
  // tools/list. This is the live wire surface a Glama scanner sees, so
  // testing it directly is the same shape as the production gate.
  const r = spawnSync(
    "node",
    [
      "-e",
      `
      (async () => {
        const { Client } = await import('${path.join(PROJECT_ROOT, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")}');
        const { StdioClientTransport } = await import('${path.join(PROJECT_ROOT, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")}');
        const fs = await import('node:fs');
        const path = await import('node:path');
        const tmp = fs.mkdtempSync(path.join(process.cwd(), '.tdqs-'));
        const t = new StdioClientTransport({
          command: process.execPath,
          args: ['${path.join(PROJECT_ROOT, "dist/index.js")}'],
          env: {
            ...process.env,
            RELAY_DB_PATH: path.join(tmp, 'relay.db'),
            RELAY_TRANSPORT: 'stdio',
            RELAY_SKIP_TTY_CHECK: '1',
          },
        });
        const c = new Client({ name: 'tdqs', version: '0.0.0' }, { capabilities: {} });
        try {
          await c.connect(t);
          const tools = await c.listTools();
          process.stdout.write(JSON.stringify(tools.tools));
        } finally {
          try { await c.close(); } catch {}
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      })().catch((e) => { console.error(e); process.exit(1); });
      `,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (r.status !== 0) {
    throw new Error(`Failed to list tools: status=${r.status} stderr=${r.stderr}`);
  }
  return JSON.parse(r.stdout) as ToolDef[];
}

describe("v2.4.4 — tool description quality", () => {
  const tools = listTools();

  it("(Q1) every tool has a description with sufficient length", () => {
    expect(tools.length).toBe(30);
    const offenders = tools
      .filter((t) => !t.description || t.description.length < MIN_DESCRIPTION_CHARS)
      .map((t) => `${t.name}: ${t.description?.length ?? 0} chars`);
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} tool(s) have descriptions shorter than ${MIN_DESCRIPTION_CHARS} chars:\n  ` +
          offenders.join("\n  "),
      );
    }
  });

  it("(Q2) every tool description mentions 'When to use' (Usage Guidelines presence)", () => {
    const offenders = tools
      .filter((t) => !/When to use:/i.test(t.description ?? ""))
      .map((t) => t.name);
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} tool(s) missing 'When to use:' disambiguation guidance:\n  ` +
          offenders.join("\n  "),
      );
    }
  });

  it("(Q3) every tool description mentions Returns or Errors (Behavioral Transparency)", () => {
    const offenders = tools
      .filter((t) => !/Returns:|Errors:/i.test(t.description ?? ""))
      .map((t) => t.name);
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} tool(s) missing Returns: or Errors: section:\n  ` + offenders.join("\n  "),
      );
    }
  });

  it("(Q4) every tool description mentions Behavior (state-change transparency)", () => {
    const offenders = tools
      .filter((t) => !/Behavior:/i.test(t.description ?? ""))
      .map((t) => t.name);
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} tool(s) missing Behavior: section:\n  ` + offenders.join("\n  "),
      );
    }
  });

  it("(Q5) every tool follows the verb_noun naming convention", () => {
    // Lowercase letters + digits, with at least one underscore separating
    // verb from noun. Tools whose name is a single word (e.g. `broadcast`)
    // are allowed because the verb stands alone.
    const re = /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)*$/;
    const offenders = tools
      .map((t) => t.name)
      .filter((name) => !re.test(name));
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} tool name(s) violate verb_noun convention:\n  ` + offenders.join("\n  "),
      );
    }
  });

  it("(Q6) every input parameter has a description (Parameter Semantics floor)", () => {
    const violations: string[] = [];
    for (const tool of tools) {
      const props = (tool.inputSchema as any)?.properties as
        | Record<string, { description?: string }>
        | undefined;
      if (!props) continue;
      for (const [paramName, schema] of Object.entries(props)) {
        if (!schema?.description || !schema.description.trim()) {
          violations.push(`${tool.name}.${paramName}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} parameter(s) missing description:\n  ` + violations.join("\n  "),
      );
    }
  });

  it("(Q7) description hashes match the pinned snapshot — fails on any drift", () => {
    // v2.4.4 R1 (Codex 2026-04-27): the v2.4.4 R0 Q7 only checked hash
    // shape + tool-name set, so changing every description still passed.
    // Now pinned to the SHA-256 of every description AT THE TIME OF
    // COMMIT. Future PRs that touch any description will fail Q7 with a
    // clear "old vs new hash" diff and a one-line update path. This
    // forces a review pause for every description edit — exactly the
    // class of drift that introduced the v2.4.4 R0 Returns-shape bugs.
    //
    // To update intentionally:
    //   1. Make the description edit.
    //   2. Run `npm run build` so dist/index.js carries the new text.
    //   3. Run this test; copy the actual hash from the failure message
    //      into the EXPECTED_HASHES map below.
    //   4. Commit the description edit + the hash bump in the same PR.
    const EXPECTED_HASHES: Record<string, string> = {
      broadcast: "0745f040a35264b317b13c72a24f2cc57f12d741c67b100f978b377806fc49e0",
      create_channel: "fe2f8015af0266fb60327c65619542a0be390fbde2f283bb19b7073fc7caef90",
      delete_webhook: "1077b27565205f2d900437db5afafc37889d7424b45dad55f8999e56c50436d7",
      discover_agents: "1cc22950fa7478fee94c7549a0b8c46d76c59165b0f128aa07b0461b4c8d18a4",
      expand_capabilities: "f68e3c05bc1779d8bef11669895c21e14a2f1844c3e01ae1f57e39f48ebb8d09",
      get_channel_messages: "06592f4a9f58da0d111640ff64829ae49f3e388c00c9ffa9c9c7230b81f1c522",
      get_messages: "6ab5356c79e6f3c28574ee39b98ada3fc94225ebf76c82d91c528f123d750960",
      get_messages_summary: "fc5408be92b67606153c829f0dac464afeb3c465f75dd4abb3d36a9e8884d2bf",
      get_standup: "50fc69fcf51b6d21632b5e9be632f570c7cee8b1cbc18999a82d0a34dc2b1519",
      get_task: "de353b956b82f757829007fd6b9d7b7c7b89500dbf6b60681cf7080b574fce9b",
      get_tasks: "1e1416a86554d1e17346d3cc661453a4536768dfad4ef492ce60beb9aa597e7e",
      health_check: "9558d9d8d499dfaedeb980a25bc02d4c969353a919a5080fafdcee232704f465",
      join_channel: "46b2b3247d5a1115e1f72635bdfae99b63e88b344bbf3482fce93410321de45f",
      leave_channel: "654ef16a3e05b55712b155643cc92b8536b9795fa68037f203f1fb5cb7b3f9d0",
      list_webhooks: "8c0a676339308cdf9591e789636ec49ab681eed8ff662815c2bf2a9de5f87449",
      peek_inbox_version: "5d76f1442911e752555ed122a5ccd2254c4a47df1ddcd83307dcddcf906752a1",
      post_task: "76309d5c555329f7df772e65230ec243c544b82a0c519f1b5cdb0351edd69e24",
      post_task_auto: "f227175138d36cc2117dc77bbadafc2d151a33d0533996a2beb572192091a535",
      post_to_channel: "593b795f55ccd34c8d3cc668f91bc64c6a4be27f79827b09b3895ccea37e59b2",
      register_agent: "43f3d8cb5b37ffcf8f089e23727ee2110cc792938699f04ea6cc0623e74b7128",
      register_webhook: "7a1fd9852ec77d5ee5e23e081a5f1d82ab8d1fa0591d84893b1e1a55253ec006",
      revoke_token: "6d73ab6b1d8e238b10f3a006fb44f597b099de1f344ce9f03a964f21670a018f",
      rotate_token: "d3a9ed36a83157f59c01335df8b25978b5af23666c1b61d8ed5ad897680bfc25",
      rotate_token_admin: "c49dd62b8cab404d4df138ade5916a08a1527796b6126fd52dec7555499aa171",
      send_message: "b29d2537a0e3226b08965410b461e1fe7011f0eaecd7762f71cc6fb1beaa3849",
      set_dashboard_theme: "bc6b17d24b74b289c25f6f327046298d25c035f28a3830449848283631034ed8",
      set_status: "62feb957849a1b52dfa7d1b4f6619c49554e59161b8bddbc3db1d1221e73d4d1",
      spawn_agent: "aad0d0af18a29bcd8f39fc2a19e6b198604d23dac377c0c53cf2b00a3cb0e7de",
      unregister_agent: "dcd94807ba629527459cb0df2b5d73427d0b09bea7f756a47700e000685736ee",
      update_task: "05aacb80e85bf615a033a7611bb58d673dbb7bd86e5e33f846243f323cd02931",
    };

    const actualHashes: Record<string, string> = {};
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      actualHashes[tool.name] = createHash("sha256")
        .update(tool.description ?? "")
        .digest("hex");
    }

    // Lock the tool surface (catches add/remove/rename).
    expect(Object.keys(actualHashes).sort()).toEqual(
      Object.keys(EXPECTED_HASHES).sort(),
    );

    // Lock every description's content (catches drift).
    const drifted: string[] = [];
    for (const [name, expected] of Object.entries(EXPECTED_HASHES)) {
      const actual = actualHashes[name];
      if (actual !== expected) {
        drifted.push(`  ${name}: expected ${expected}, got ${actual}`);
      }
    }
    if (drifted.length > 0) {
      throw new Error(
        `${drifted.length} tool description(s) drifted from the pinned snapshot:\n` +
          drifted.join("\n") +
          `\n\nIf this drift is intentional, copy the new hash(es) from above into ` +
          `EXPECTED_HASHES in tests/v2-4-4-tool-description-quality.test.ts and ` +
          `commit alongside the description edit.`,
      );
    }
  });
});
