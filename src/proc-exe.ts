// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE EXECUTABLE IDENTITY. RED STATE: today's behaviour (no executable identity is read; comm is trusted), so the
 * rows of tests/executable-identity.test.ts each fail on their own assertion. The implementation follows.
 */
export interface ExeOpts {
  platform?: NodeJS.Platform;
  readlink?: (p: string) => string;
}

export function executableIdentity(_pid: number, _opts: ExeOpts = {}): string | undefined {
  return undefined;
}

export function isRuntimeThreadName(_comm: string): boolean {
  return false;
}
