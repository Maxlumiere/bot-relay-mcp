// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0026 item 1 — codex round-1 BLOCKING fixes. The enumeration deliverable: ONE test per way
 * the durable sink can be wrong, each asserting the reader/formatter degrades to UNKNOWN unless
 * the record is GENUINELY healthy. Silence-as-failure applies to malformation exactly as to
 * absence: a record we cannot fully trust must never read OK.
 *
 * Failure modes covered: missing file / empty file / torn-partial write / bad JSON / wrong type /
 * missing schema version / unknown schema version / future clock-skew (BOTH sides) / stale /
 * healthy-OK / healthy-UNCOVERED / newline-injection (P2). These RED on the pre-fix head:
 *  - no runtime schema validation (partial/wrong-typed/version-less records read OK),
 *  - future skew escapes staleness (a 2099 record reads "OK (as of 0s)"),
 *  - an agent name with a newline makes the one-line briefing multi-line.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = path.join(os.tmpdir(), "wake-cov-robust-" + process.pid);
// Env seam — never resolve the live default sink from a test (mirrors wake-coverage-sink.test.ts).
process.env.RELAY_WAKE_COVERAGE_STATUS_PATH = path.join(TMP, "status.json");

const { formatWakeCoverageStatusLine, readWakeCoverageStatus } = await import(
  "../src/wake-coverage-status.js"
);

type FmtStatus = Parameters<typeof formatWakeCoverageStatusLine>[0];
// Cast helper so a deliberately-malformed object can be handed to the formatter (the whole point
// is runtime robustness, so the compile-time type is bypassed on purpose).
const asStatus = (o: unknown): FmtStatus => o as unknown as FmtStatus;

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const STALE_AFTER = 3 * HOUR;

interface HealthyOver {
  v?: unknown;
  generatedAt?: string;
  thresholdMs?: unknown;
  uncoveredCount?: unknown;
  findings?: unknown;
}
const healthy = (over: HealthyOver = {}): Record<string, unknown> => ({
  v: 1,
  generatedAt: new Date(NOW).toISOString(),
  thresholdMs: 48 * HOUR,
  findings: [],
  ...over,
});

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeRaw(content: string): string {
  const p = path.join(TMP, "s.json");
  fs.writeFileSync(p, content);
  return p;
}

describe("wake-coverage sink robustness — UNKNOWN for every malformation, OK only when genuinely healthy", () => {
  // ---- FILE LEVEL: readWakeCoverageStatus must return null (→ formatter UNKNOWN) ----
  it("missing file → null → UNKNOWN", () => {
    const p = path.join(TMP, "does-not-exist.json");
    expect(readWakeCoverageStatus(p)).toBeNull();
    expect(formatWakeCoverageStatusLine(readWakeCoverageStatus(p), NOW, STALE_AFTER)).toMatch(/UNKNOWN/);
  });

  it("empty file → null", () => {
    expect(readWakeCoverageStatus(writeRaw(""))).toBeNull();
  });

  it("torn / partial write → null", () => {
    expect(readWakeCoverageStatus(writeRaw('{"v":1,"generatedAt":"2026-08-27T12:00'))).toBeNull();
  });

  it("bad JSON → null", () => {
    expect(readWakeCoverageStatus(writeRaw("not json at all {{{"))).toBeNull();
  });

  it("wrong type (thresholdMs is a string) → null", () => {
    const p = writeRaw(JSON.stringify(healthy({ thresholdMs: "0" })));
    expect(readWakeCoverageStatus(p), "a wrong-typed field must not read as valid").toBeNull();
  });

  it("missing schema version → null (NEVER assumed v1)", () => {
    const { v, ...noV } = healthy();
    void v;
    expect(readWakeCoverageStatus(writeRaw(JSON.stringify(noV)))).toBeNull();
  });

  it("unknown schema version (v:2) → null", () => {
    expect(readWakeCoverageStatus(writeRaw(JSON.stringify(healthy({ v: 2 }))))).toBeNull();
  });

  // ---- FORMATTER LEVEL: the SAME guard must apply (not only the reader) ----
  it("formatter: malformed object (findings missing) → UNKNOWN", () => {
    const { findings, ...noFindings } = healthy();
    void findings;
    expect(formatWakeCoverageStatusLine(asStatus(noFindings), NOW, STALE_AFTER)).toMatch(/UNKNOWN/);
  });

  it("formatter: missing version → UNKNOWN", () => {
    const { v, ...noV } = healthy();
    void v;
    expect(formatWakeCoverageStatusLine(asStatus(noV), NOW, STALE_AFTER)).toMatch(/UNKNOWN/);
  });

  // ---- CLOCK SKEW: BOTH sides ----
  it("future skew within tolerance (10s ahead) STAYS OK — NTP jitter must not manufacture UNKNOWN", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(healthy({ generatedAt: new Date(NOW + 10_000).toISOString() })),
      NOW,
      STALE_AFTER,
    );
    expect(line).toMatch(/wake-coverage: OK/);
    expect(line).not.toMatch(/UNKNOWN/);
  });

  it("material future skew (1h ahead) → UNKNOWN", () => {
    expect(
      formatWakeCoverageStatusLine(
        asStatus(healthy({ generatedAt: new Date(NOW + HOUR).toISOString() })),
        NOW,
        STALE_AFTER,
      ),
    ).toMatch(/UNKNOWN/);
  });

  it("absurd future skew (year 2099) → UNKNOWN (not 'very fresh')", () => {
    expect(
      formatWakeCoverageStatusLine(
        asStatus(healthy({ generatedAt: "2099-01-01T00:00:00.000Z" })),
        NOW,
        STALE_AFTER,
      ),
    ).toMatch(/UNKNOWN/);
  });

  // ---- STALE (past) ----
  it("stale (3 days old) → UNKNOWN", () => {
    expect(
      formatWakeCoverageStatusLine(
        asStatus(healthy({ generatedAt: new Date(NOW - 3 * 24 * HOUR).toISOString() })),
        NOW,
        STALE_AFTER,
      ),
    ).toMatch(/UNKNOWN/);
  });

  // ---- HEALTHY ----
  it("healthy fresh + 0 uncovered → OK", () => {
    const line = formatWakeCoverageStatusLine(asStatus(healthy()), NOW + 60_000, STALE_AFTER);
    expect(line).toMatch(/wake-coverage: OK/);
    expect(line).not.toMatch(/UNKNOWN/);
  });

  it("healthy fresh + uncovered → loud UNCOVERED naming the agent", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(healthy({ findings: [{ agent: "realagent", verdict: "uncovered" }] })),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line).toMatch(/UNCOVERED/);
    expect(line).toMatch(/realagent/);
  });

  // ---- P2: newline injection sanitized at the formatter SSOT ----
  it("P2: an agent name containing a newline does NOT produce a multi-line briefing", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(
        healthy({
          findings: [{ agent: "evil\nINJECTED SECOND LINE", verdict: "uncovered" }],
        }),
      ),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line.split("\n"), "the [RELAY] briefing must be exactly one line").toHaveLength(1);
  });

  // ---- MEANING axis (codex P1 r2/r3): no redundant summary field; the FINDINGS are the SOLE truth ----
  // uncoveredCount was REMOVED from the schema entirely, so the count/findings inconsistency cannot be
  // represented. A record still CARRYING the field is non-conforming (closed schema) -> UNKNOWN in BOTH
  // directions of the old mismatch. This is the axis the shape-only enumeration missed: a well-formed but
  // internally-inconsistent record. The derive-from-findings behaviour is covered by "healthy + uncovered".
  it("stray uncoveredCount:0 alongside an uncovered finding → UNKNOWN (finding #4 direction; rejected, not silently derived)", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(healthy({ uncoveredCount: 0, findings: [{ agent: "actually-uncovered", verdict: "uncovered" }] })),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line, "a record carrying the removed field is non-conforming").toMatch(/UNKNOWN/);
    expect(line).not.toMatch(/wake-coverage: OK/);
  });

  it("stray uncoveredCount:1 with EMPTY findings → UNKNOWN (codex converse #5: count-says-broken / findings-say-fine)", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(healthy({ uncoveredCount: 1, findings: [] })),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line, "a stray count claiming an uncovered agent must never read OK").toMatch(/UNKNOWN/);
    expect(line).not.toMatch(/wake-coverage: OK/);
  });

  it("any unexpected top-level field → UNKNOWN (closed schema — a writer's meaning is never silently discarded)", () => {
    expect(
      formatWakeCoverageStatusLine(asStatus({ ...healthy(), surpriseField: 123 }), NOW + 60_000, STALE_AFTER),
    ).toMatch(/UNKNOWN/);
  });

  it("unknown verdict → UNKNOWN (only known verdicts are valid)", () => {
    expect(
      formatWakeCoverageStatusLine(
        asStatus(healthy({ findings: [{ agent: "x", verdict: "definitely-not-a-verdict" }] })),
        NOW + 60_000,
        STALE_AFTER,
      ),
    ).toMatch(/UNKNOWN/);
  });

  // ---- codex #6 + victra: ONLY an EMPTY findings list is healthy — derive by EXCLUSION ----
  // An `unobservable` finding (stuck mail, no drain marker — coverage UNJUDGEABLE) is a NORMAL writer
  // output; it must NOT collapse into OK. The founding defect of this PR was UNOBSERVABLE lost in
  // stderr for 500h — converting it to OK is the same disease at the display layer. OK is reached ONLY
  // when findings is empty; ANY finding of a verdict we haven't affirmatively classified as healthy is
  // not-OK (so a future verdict defaults to visible/not-OK, never invisible/healthy).
  it("UNOBSERVABLE finding → UNKNOWN, never OK (unjudgeable stuck mail is not checked-and-healthy)", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(healthy({ findings: [{ agent: "cannot-judge", verdict: "unobservable" }] })),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line, "unobservable stuck mail must not read OK").not.toMatch(/wake-coverage: OK/);
    expect(line).toMatch(/UNOBSERVABLE|UNKNOWN/);
    expect(line, "the affected agent must be named").toMatch(/cannot-judge/);
  });

  // ---- OVER-STRICTNESS (victra): benign variation must NOT manufacture a FALSE UNKNOWN ----
  it("FLOAT thresholdMs stays OK — the shipped writer's boundMs+antiFlapMarginMs can be a float", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(healthy({ thresholdMs: 172_800_000.5 })),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line, "a benign float threshold must not cry wolf as UNKNOWN").toMatch(/wake-coverage: OK/);
    expect(line).not.toMatch(/UNKNOWN/);
  });

  it("unicode in an agent name is preserved and surfaced (not rejected, not stripped)", () => {
    const line = formatWakeCoverageStatusLine(
      asStatus(healthy({ findings: [{ agent: "café-agent-日本語", verdict: "uncovered" }] })),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line).toMatch(/UNCOVERED/);
    expect(line).toMatch(/café-agent-日本語/);
  });

  it("key order does not matter (closed schema is by membership, not position)", () => {
    const reordered = { findings: [], thresholdMs: 48 * HOUR, generatedAt: new Date(NOW).toISOString(), v: 1 };
    const line = formatWakeCoverageStatusLine(asStatus(reordered), NOW + 60_000, STALE_AFTER);
    expect(line).toMatch(/wake-coverage: OK/);
    expect(line).not.toMatch(/UNKNOWN/);
  });

  // thresholdMs INVALID cases still reject (finite, non-negative): NaN / Infinity / negative → UNKNOWN.
  it("NaN thresholdMs → UNKNOWN", () => {
    expect(formatWakeCoverageStatusLine(asStatus(healthy({ thresholdMs: NaN })), NOW + 60_000, STALE_AFTER)).toMatch(
      /UNKNOWN/,
    );
  });

  it("Infinity thresholdMs → UNKNOWN", () => {
    expect(
      formatWakeCoverageStatusLine(asStatus(healthy({ thresholdMs: Infinity })), NOW + 60_000, STALE_AFTER),
    ).toMatch(/UNKNOWN/);
  });

  it("negative thresholdMs → UNKNOWN", () => {
    expect(
      formatWakeCoverageStatusLine(asStatus(healthy({ thresholdMs: -1 })), NOW + 60_000, STALE_AFTER),
    ).toMatch(/UNKNOWN/);
  });
});
