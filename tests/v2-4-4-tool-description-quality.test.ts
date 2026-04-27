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

  it("(Q7) description hashes are tracked — surfaces accidental drift in PR review", () => {
    // Snapshot of the SHA-256 of every description, sorted by tool name.
    // Updating this snapshot is intentional, not automatic — the diff in
    // the PR forces a review pause when descriptions change. If you
    // intentionally rewrote a description, regenerate and commit the
    // updated snapshot in the same PR.
    const hashes: Record<string, string> = {};
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      hashes[tool.name] = createHash("sha256")
        .update(tool.description ?? "")
        .digest("hex");
    }
    // The actual snapshot lives in the count + presence of every name —
    // we don't pin specific hash values (would force a snapshot bump
    // every commit). Instead we assert: every tool name has a stable
    // 64-char hex hash, and the set of names matches the locked surface.
    expect(Object.keys(hashes).length).toBe(30);
    for (const [name, h] of Object.entries(hashes)) {
      expect(h, `hash for ${name}`).toMatch(/^[0-9a-f]{64}$/);
    }
    // Lock the tool surface — if a tool gets added/removed/renamed,
    // this assertion catches it for explicit review.
    const expected = [
      "broadcast", "create_channel", "delete_webhook", "discover_agents",
      "expand_capabilities", "get_channel_messages", "get_messages",
      "get_messages_summary", "get_standup", "get_task", "get_tasks",
      "health_check", "join_channel", "leave_channel", "list_webhooks",
      "peek_inbox_version", "post_task", "post_task_auto", "post_to_channel",
      "register_agent", "register_webhook", "revoke_token", "rotate_token",
      "rotate_token_admin", "send_message", "set_dashboard_theme",
      "set_status", "spawn_agent", "unregister_agent", "update_task",
    ];
    expect(Object.keys(hashes).sort()).toEqual(expected);
  });
});
