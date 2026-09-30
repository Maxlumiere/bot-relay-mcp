// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// ADR-0048 PR D — resolver version skew, made VISIBLE.
//
// Tether bundles the relay's instance resolver (src/resolve-instance.ts) to find
// the token vault. A Tether built from one relay revision talking to a relay
// running another could read a different vault than the relay writes: the
// ADR-0047 class of silent version skew. The relay reports its resolver revision
// on /health (`resolver_revision`); Tether compares it with the one it bundled
// and says so, once per change: a match (logged), a mismatch (logged and
// warned), or a relay that does not report one (logged: older than PR D).
//
// VSCode-free: the sinks are injected (extension.ts wires its log and
// vscode.window.showWarningMessage), so the tests drive the shipped logic.
import { BUNDLED_RESOLVER_REVISION } from "./vault-path.js";

const REVISION_RE = /^[0-9a-f]{12}$/;

export type SkewVerdict =
  | { status: "match"; revision: string }
  | { status: "mismatch"; relay: string; bundled: string }
  | { status: "unknown"; why: string };

/** Compare the relay's /health body with the bundled revision. */
export function compareResolverRevision(bodyText: string | null, bundled: string = BUNDLED_RESOLVER_REVISION): SkewVerdict {
  if (bodyText == null) return { status: "unknown", why: "no /health body" };
  let rev: unknown;
  try {
    rev = (JSON.parse(bodyText) as { resolver_revision?: unknown }).resolver_revision;
  } catch {
    return { status: "unknown", why: "the /health body is not JSON" };
  }
  if (rev === undefined) return { status: "unknown", why: "the relay does not report its resolver revision (older than ADR-0048 PR D)" };
  if (typeof rev !== "string" || !REVISION_RE.test(rev)) return { status: "unknown", why: "the relay reported a malformed resolver revision" };
  return rev === bundled ? { status: "match", revision: rev } : { status: "mismatch", relay: rev, bundled };
}

/** Reports a verdict only when it CHANGES (the health poll runs every few seconds). */
export class ResolverSkewReporter {
  private last = "";
  constructor(private readonly sinks: { log: (line: string) => void; warn: (message: string) => void }) {}

  observe(bodyText: string | null): void {
    const v = compareResolverRevision(bodyText);
    const key = v.status === "mismatch" ? `mismatch:${v.relay}` : v.status === "match" ? "match" : `unknown:${v.why}`;
    if (key === this.last) return;
    this.last = key;
    if (v.status === "match") {
      this.sinks.log(`resolver: revision ${v.revision} matches the relay`);
    } else if (v.status === "mismatch") {
      const msg =
        `Tether's instance resolver (revision ${v.bundled}) differs from the relay's (revision ${v.relay}): ` +
        `Tether may read a different token vault than the relay writes. Update Tether or the relay so they match.`;
      this.sinks.log(`resolver: MISMATCH: ${msg}`);
      this.sinks.warn(msg);
    } else {
      this.sinks.log(`resolver: cannot compare revisions: ${v.why}`);
    }
  }
}
