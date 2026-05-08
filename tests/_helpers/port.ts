// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.3 — shared free-port helper for integration tests.
 *
 * Pre-v2.6.3 several integration tests hardcoded specific ports in the
 * 39413-39988 range to spawn isolated HTTP daemons. When a prior gate
 * iteration crashed mid-run and left a stale `node dist/index.js` process
 * holding the port, the next run failed with port-already-in-use — flake
 * caught manually via `lsof -i :<port>` during v2.6.0 publish-prep, then
 * called out by codex on v2.6.4 R0/R2 audits as a known-flake class.
 *
 * Strategy: bind a throwaway server to port 0 (kernel-assigned), read the
 * bound port from `server.address()`, close the server, return the port
 * for the caller to use. Race window between close + caller-bind is
 * microseconds; in practice this pattern is the standard Node port-claim
 * idiom (used by `get-port` npm + most Node test rigs). No new
 * dependency added — Node `net` is stdlib.
 *
 * Used by: tests that spawn `node dist/index.js` HTTP daemon subprocesses.
 * NOT used by tests that bind their own server in-process (those can
 * pass port 0 directly and read `server.address().port`).
 */
import net from "net";

/**
 * Return a free TCP port on 127.0.0.1. The returned port is released
 * before this function resolves; the caller is expected to bind it
 * immediately. Race window with another process grabbing the port in the
 * gap is microseconds and acceptable for test rigs.
 */
export async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("getFreePort: unexpected address shape")));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}
