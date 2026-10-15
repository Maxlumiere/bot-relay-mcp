// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Start a NESTED vitest run of a fixture config (the tripwire's own tests: the harms run there, under the real base
 * config, tripwire and run guard, so a harm that FAILS its test does not fail this run). The env is THIS worker's,
 * minus what the nested run builds itself (the snapshot, vitest's own vars) and minus this run's private relay paths
 * (the nested base would discover them as the operator's), plus `overlay`. Started with the UNWRAPPED spawn (see
 * spawnNestedRun). Returns the exit code, the combined output, and each test's verdict from the JSON report.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnNestedRun } from "../_setup/operator-tripwire.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // never URL.pathname: it keeps %20

export interface NestedVerdict {
  status: string;
  messages: string;
}

export async function nestedVitestRun(
  configPath: string,
  filter: string,
  overlay: NodeJS.ProcessEnv,
  work: string,
): Promise<{ code: number | null; out: string; verdicts: Record<string, NestedVerdict> }> {
  const report = path.join(work, `report-${filter}.json`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith("RELAY_TEST_") || k.startsWith("VITEST") || ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_INSTANCE_ID"].includes(k)) delete childEnv[k];
  Object.assign(childEnv, overlay);
  const child = spawnNestedRun(process.execPath, [path.join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", "--config", configPath, "--reporter=json", `--outputFile=${report}`, filter], { cwd: REPO, env: childEnv });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  const verdicts: Record<string, NestedVerdict> = {};
  const json = JSON.parse(fs.readFileSync(report, "utf-8")) as { testResults: Array<{ assertionResults: Array<{ title: string; status: string; failureMessages: string[] }> }> };
  for (const f of json.testResults) for (const a of f.assertionResults) verdicts[a.title] = { status: a.status, messages: a.failureMessages.join("\n") };
  return { code, out, verdicts };
}
