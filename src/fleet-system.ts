// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 3 — the REAL system reads behind the verdict engine
 * (src/fleet-verdicts.ts SystemDeps). Read-only: ps, lsof, /proc, one HTTP GET of
 * the daemon's public /health, `node --version`. No process environment is ever
 * read (ps -E carries secrets): the daemon is excluded from the connector set by
 * its listen socket instead (ruling fd6b7757, D9.2).
 */
import fs from "fs";
import http from "http";
import { spawnSync } from "child_process";
import { buildProcessTable } from "./liveness.js";
import { readInstalled, type SystemDeps } from "./fleet-verdicts.js";

const CMD_TIMEOUT_MS = 10_000;

/** lsof -t output → pids. lsof exits 1 with no output when nothing matches: a positive "none". */
function lsofPids(args: string[]): number[] | { error: string } {
  const r = spawnSync("lsof", args, { encoding: "utf-8", timeout: CMD_TIMEOUT_MS });
  if (r.error) return { error: `lsof: ${r.error.message}` };
  if (r.status !== 0 && (r.stdout ?? "").trim() !== "") return { error: `lsof exited ${r.status}` };
  if (r.status !== 0 && r.status !== 1) return { error: `lsof exited ${r.status}` };
  return [...new Set((r.stdout ?? "").split("\n").filter((l) => /^\d+$/.test(l)).map(Number))];
}

export const realSystemDeps: SystemDeps = {
  processTable: () => buildProcessTable(),
  cwds: (pids) => {
    const out = new Map<number, string>();
    if (pids.length === 0) return out;
    // One lsof for all of them: `-a -d cwd -p a,b,c -Fpn` → "p<pid>" then "n<path>".
    const r = spawnSync("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { encoding: "utf-8", timeout: CMD_TIMEOUT_MS });
    let pid: number | null = null;
    for (const line of (r.stdout ?? "").split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid !== null && Number.isInteger(pid)) out.set(pid, line.slice(1));
    }
    return out;
  },
  exactArgv: (pid) => {
    if (process.platform !== "linux") return null;
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      const parts = raw.toString("utf-8").split("\u0000");
      if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      return parts.length > 0 ? parts : null;
    } catch {
      return null;
    }
  },
  allListeners: () => lsofPids(["-nP", "-iTCP", "-sTCP:LISTEN", "-t"]),
  portListeners: (port) => lsofPids(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]),
  health: (port) =>
    new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3000 }, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          try {
            resolve({ ok: true, body: JSON.parse(body) as unknown });
          } catch {
            resolve({ ok: false, error: "the body is not JSON" });
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("timed out after 3s")));
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
    }),
  nodeOnPath: () => {
    const r = spawnSync("node", ["--version"], { encoding: "utf-8", timeout: CMD_TIMEOUT_MS });
    const v = (r.stdout ?? "").trim();
    return r.status === 0 && /^v\d/.test(v) ? v : null;
  },
  installed: (dir) => readInstalled(dir),
};
