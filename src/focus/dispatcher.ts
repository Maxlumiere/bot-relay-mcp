// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures (MIT)

/**
 * v2.2.0 — focus dispatcher.
 *
 * Mirrors src/spawn/dispatcher.ts in shape: pick a driver by
 * process.platform, check `canHandle`, construct the command, then shell
 * out via child_process.spawn with a 3s timeout. The driver modules are
 * pure — this file is the only place that actually executes a subprocess.
 *
 * Contract with the HTTP handler:
 *   - Returns { raised: true, ... } when the driver's command exits 0.
 *   - Returns { raised: false, reason: <string> } for every failure mode
 *     (driver missing, binary missing, subprocess error, timeout, non-zero
 *     exit). The reason is stable for incident replay.
 *   - NEVER throws. The HTTP handler relies on this to avoid 500s on
 *     platforms where focus isn't wired.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { log } from "../logger.js";
import type { FocusDriver, FocusDriverContext, FocusPlatform, FocusResult } from "./types.js";
import { macosDriver } from "./drivers/macos.js";
import { linuxDriver } from "./drivers/linux.js";
import { windowsDriver } from "./drivers/windows.js";

const FOCUS_TIMEOUT_MS = 3_000;

const DRIVERS: Readonly<Record<FocusPlatform, FocusDriver>> = {
  darwin: macosDriver,
  linux: linuxDriver,
  win32: windowsDriver,
};

/**
 * Default `hasBinary` check. Walks PATH for an executable with the given
 * name. Mockable via the FocusDriverContext parameter in tests.
 *
 * We intentionally do NOT invoke `which` as a subprocess — that would
 * introduce platform-specific parsing (where on Windows, which on POSIX).
 * Scanning PATH directly is portable + fast.
 */
function defaultHasBinary(binary: string): boolean {
  const rawPath = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of rawPath.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${binary}${ext.toLowerCase() === binary.toLowerCase().slice(-ext.length) ? "" : ext.toLowerCase()}`;
      try {
        if (existsSync(candidate)) return true;
      } catch {
        // ignore — try next candidate
      }
    }
    // Also try the bare name (no ext) for POSIX shell scripts / symlinks.
    try {
      if (existsSync(`${dir}/${binary}`)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Resolve the current-platform focus driver, or null if we're on an
 * unsupported platform (freebsd / sunos / aix etc.).
 */
export function resolveDriver(
  platform: NodeJS.Platform = process.platform
): FocusDriver | null {
  if (platform === "darwin") return DRIVERS.darwin;
  if (platform === "linux") return DRIVERS.linux;
  if (platform === "win32") return DRIVERS.win32;
  return null;
}

/**
 * Build the FocusDriverContext used by canHandle + buildCommand. Exported
 * for tests; production callers should use `focusTerminal()`.
 */
export function buildContext(
  platform: FocusPlatform,
  overrides: Partial<FocusDriverContext> = {}
): FocusDriverContext {
  return {
    platform,
    hasBinary: overrides.hasBinary ?? defaultHasBinary,
    ...overrides,
  };
}

/**
 * Raise the OS window whose title matches `title`. Pure I/O — reads
 * process.platform, optionally spawns a subprocess, never touches the DB.
 */
export async function focusTerminal(title: string): Promise<FocusResult> {
  const driver = resolveDriver();
  if (!driver) {
    return {
      raised: false,
      platform: process.platform as FocusPlatform,
      title,
      reason: `unsupported platform "${process.platform}" — dashboard click-to-focus is wired for darwin/linux/win32 only`,
    };
  }
  const ctx = buildContext(driver.platform);
  if (!driver.canHandle(ctx)) {
    const hint =
      driver.platform === "linux"
        ? "wmctrl not installed — apt install wmctrl (Debian/Ubuntu) or dnf install wmctrl (Fedora)"
        : driver.platform === "darwin"
          ? "osascript not on PATH — unusual for macOS, check install integrity"
          : "powershell.exe not on PATH";
    return {
      raised: false,
      platform: driver.platform,
      title,
      reason: hint,
      driver_name: driver.name,
    };
  }
  let cmd;
  try {
    cmd = driver.buildCommand(title, ctx);
  } catch (err) {
    return {
      raised: false,
      platform: driver.platform,
      title,
      reason: `command-construction failed: ${err instanceof Error ? err.message : String(err)}`,
      driver_name: driver.name,
    };
  }
  return await runCommand(cmd.exec, cmd.args, cmd.env, driver, title);
}

function runCommand(
  exec: string,
  args: string[],
  env: Record<string, string> | undefined,
  driver: FocusDriver,
  title: string
): Promise<FocusResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(exec, args, {
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stderr?.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({
        raised: false,
        platform: driver.platform,
        title,
        reason: `focus command timed out after ${FOCUS_TIMEOUT_MS}ms`,
        driver_name: driver.name,
      });
    }, FOCUS_TIMEOUT_MS);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        raised: false,
        platform: driver.platform,
        title,
        reason: `focus spawn error: ${err.message}`,
        driver_name: driver.name,
      });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          raised: true,
          platform: driver.platform,
          title,
          driver_name: driver.name,
        });
        return;
      }
      const stderrTxt = Buffer.concat(chunks).toString("utf8").trim().slice(0, 400);
      log.warn(`[focus] ${driver.name} exit=${code} stderr="${stderrTxt}"`);
      resolve({
        raised: false,
        platform: driver.platform,
        title,
        reason: stderrTxt || `focus command exited ${code}`,
        driver_name: driver.name,
      });
    });
  });
}
