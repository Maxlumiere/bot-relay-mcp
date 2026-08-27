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
  uncoveredCount: 0,
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

  it("wrong type (uncoveredCount is a string) → null", () => {
    const p = writeRaw(JSON.stringify(healthy({ uncoveredCount: "0" })));
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
      asStatus(healthy({ uncoveredCount: 1, findings: [{ agent: "realagent", verdict: "uncovered" }] })),
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
          uncoveredCount: 1,
          findings: [{ agent: "evil\nINJECTED SECOND LINE", verdict: "uncovered" }],
        }),
      ),
      NOW + 60_000,
      STALE_AFTER,
    );
    expect(line.split("\n"), "the [RELAY] briefing must be exactly one line").toHaveLength(1);
  });
});
