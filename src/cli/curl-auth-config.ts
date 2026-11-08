// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay curl-auth-config` (hook PR 1, as ruled): print the resolved instance's HTTP shared secret as ONE curl config
 * line, `header = "X-Relay-Secret: <secret>"`, or nothing when none is configured. The hooks pipe it STRAIGHT into
 * curl's config on stdin (`node … curl-auth-config | curl -K -`), the PR-D pattern: the secret is never in argv, an
 * env var, a file, a shell variable or any output a hook keeps. A value that could end the quoted curl value or add a
 * directive (a quote, a backslash, a control character) is DECLINED by name: no line, a reason on stderr (never the
 * value), exit 3, so the hook can name it instead of leaving a later 401 to decode.
 */
import { loadConfig } from "../config.js";

export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write("Usage: relay curl-auth-config (no arguments; prints one curl config line, or nothing)\n");
    return 2;
  }
  let secret: string | null = null;
  try {
    secret = loadConfig().http_secret;
  } catch {
    return 0; // no readable config: no secret line (never an error text that could carry one)
  }
  if (!secret) return 0;
  if (/["\\\x00-\x1f\x7f]/.test(secret)) {
    process.stderr.write("relay curl-auth-config: http_secret can't be sent safely: it contains a character curl config can't carry\n");
    return 3;
  }
  process.stdout.write(`header = "X-Relay-Secret: ${secret}"\n`);
  return 0;
}
