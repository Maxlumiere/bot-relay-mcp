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

/**
 * Reports a verdict only when it CHANGES (the health poll runs every few seconds).
 * observe() never throws: a sink that does (VS Code's output channel after it was
 * disposed: "Channel has been closed") has nowhere left to report to.
 */
export class ResolverSkewReporter {
  private last = "";
  constructor(private readonly sinks: { log: (line: string) => void; warn: (message: string) => void }) {}

  observe(bodyText: string | null): void {
    const v = compareResolverRevision(bodyText);
    const key = v.status === "mismatch" ? `mismatch:${v.relay}` : v.status === "match" ? "match" : `unknown:${v.why}`;
    if (key === this.last) return;
    this.last = key;
    try {
      this.report(v);
    } catch {
      /* the sink is gone: nothing to report into */
    }
  }

  private report(v: SkewVerdict): void {
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

/**
 * Ask the relay's /health for its resolver revision ONCE, on its own, at every
 * connect. /health needs no token, so a relay that REFUSES Tether's MCP
 * connection (a 401: often the very symptom of a skew, a vault Tether reads that
 * the relay no longer writes) still has its revision compared; the health poll
 * only starts after a successful connect. Never throws: an unreachable relay or
 * a non-2xx answer is "cannot compare" (logged by the reporter).
 */
export async function probeResolverRevision(opts: {
  endpoint: string;
  reporter: ResolverSkewReporter;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Aborted on teardown or a new connection: the probe then reports nothing. */
  signal?: AbortSignal;
  /** False once this probe's connection was superseded: its answer is discarded. */
  isCurrent?: () => boolean;
}): Promise<void> {
  if (opts.signal?.aborted) return;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  opts.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, opts.timeoutMs);
  let bodyText: string | null = null;
  try {
    const res = await doFetch(new URL("/health", opts.endpoint), { signal: controller.signal });
    bodyText = res.ok ? await res.text() : null;
  } catch {
    bodyText = null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
  }
  // A cancelled or superseded probe reports nothing: its connection is gone, and
  // a late answer must not overwrite the current connection's verdict.
  if (opts.signal?.aborted || (opts.isCurrent && !opts.isCurrent())) return;
  opts.reporter.observe(bodyText);
}
