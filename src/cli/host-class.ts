// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay host-class <host> [--timeout-ms MS]`: the hooks' relay host check (src/host-class.ts). Prints ONE line:
 * `loopback <ip>`, `remote <ip>` (the checked address the hooks pin curl to), or `unresolved <why>`. Exit 0 with a
 * line; 2 on a usage error. A hard timer bounds the run at --timeout-ms (default 2000) + a margin.
 */
import { classifyHost } from "../host-class.js";

export async function run(argv: string[]): Promise<number> {
  const [host, ...rest] = argv;
  let timeoutMs = 2000;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--timeout-ms") {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 50 || n > 60_000) {
        process.stderr.write("relay host-class: --timeout-ms takes an integer 50-60000\n");
        return 2;
      }
      timeoutMs = n;
    } else {
      process.stderr.write(`relay host-class: unknown argument ${JSON.stringify(rest[i])}\n`);
      return 2;
    }
  }
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    process.stderr.write("Usage: relay host-class <host> [--timeout-ms MS]\n");
    return 2;
  }
  const hard = setTimeout(() => {
    process.stdout.write("unresolved the host check did not finish in time\n");
    process.exit(0);
  }, timeoutMs + 500);
  hard.unref();
  const c = await classifyHost(host, { timeoutMs });
  clearTimeout(hard);
  process.stdout.write(c.kind === "unresolved" ? `unresolved ${c.why.replace(/\s+/g, " ")}\n` : `${c.kind} ${c.ip}\n`);
  return 0;
}
