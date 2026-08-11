// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Shared test helper: list the relay's tools over a REAL MCP client round-trip.
 *
 * Spawns the built dist/index.js in stdio mode against a throwaway DB and calls
 * `tools/list` through the SDK client — i.e. the exact wire surface an external
 * MCP client (or a Glama scanner) sees. New home for this spawn logic; the
 * inputSchema contract guard uses it. (tests/v2-4-4-tool-description-quality.ts
 * still carries an equivalent inline copy that predates this helper — a trivial
 * follow-up can migrate it; left untouched here to keep this guard focused and
 * not perturb that Glama-gate test.) Requires `npm run build` first (reads
 * dist/index.js).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export function listTools(): ToolDef[] {
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
        const tmp = fs.mkdtempSync(path.join(process.cwd(), '.listtools-'));
        const t = new StdioClientTransport({
          command: process.execPath,
          args: ['${path.join(PROJECT_ROOT, "dist/index.js")}'],
          env: {
            ...process.env,
            RELAY_DB_PATH: path.join(tmp, 'relay.db'),
            RELAY_TRANSPORT: 'stdio',
            RELAY_SKIP_TTY_CHECK: '1',
            // Force the CONFIGLESS / all-bundles default surface, deterministically.
            // RELAY_CONFIG_PATH always wins over any instance config (config.ts,
            // instance.ts), so pointing it at a nonexistent file inside this
            // throwaway temp dir isolates the listing from the caller's ambient
            // config (RELAY_CONFIG_PATH / RELAY_INSTANCE_ID). Without this a
            // surface-shaping operator config leaks in and tools/list returns a
            // FILTERED set (e.g. a core-only feature_bundles → 21, not 37).
            RELAY_CONFIG_PATH: path.join(tmp, 'no-such-config.json'),
          },
        });
        const c = new Client({ name: 'list-tools-helper', version: '0.0.0' }, { capabilities: {} });
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
