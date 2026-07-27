// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * applyTheme CSS-value validation — positive grammar, WRITE-path primary control.
 *
 * A custom-theme token value feeds the CSS `background:` shorthand, which accepts
 * `url(...)`, so an unvalidated token was a CSS-beaconing / defacement vector from
 * the authenticated dashboard (LOW — authed write). The fix validates each token
 * against a POSITIVE grammar (hex / numeric rgb-hsl / closed named-color set) on
 * the WRITE path (the theme schema), with a client-side guard as defence in depth.
 *
 * Harm tests: url(), escaped url() (\75 rl), var(), comment-split, bare "(", and a
 * ";"-injection are all refused; every permitted form is accepted; the innocent
 * twin — a legitimate theme — still validates and the dashboard still ships its
 * read-side guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v245-theme-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { isSafeCssColorValue } = await import("../src/css-color.js");
const { CustomThemeSchema, SetDashboardThemeSchema } = await import("../src/types.js");
const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");

const TOKENS = ["bg","panel","panel-2","border","text","muted","accent","online","stale","offline","critical","high","normal","low"] as const;
function theme(v: string, override?: Partial<Record<string, string>>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const t of TOKENS) o[t] = v;
  return { ...o, ...(override ?? {}) };
}

describe("v2.24.5 — theme CSS-value validation (positive grammar)", () => {
  describe("isSafeCssColorValue — the grammar", () => {
    it("ACCEPTS every permitted form", () => {
      for (const ok of [
        "#fff", "#ffff", "#ffffff", "#ffffffff", "#1E1E2E",
        "rgb(255,0,0)", "rgba(1, 2, 3, 0.5)", "rgb(255 0 0 / 50%)",
        "hsl(120,50%,50%)", "hsla(120, 50%, 50%, .5)",
        "red", "REBECCAPURPLE", "cornflowerblue", "transparent", "currentColor",
      ]) {
        expect(isSafeCssColorValue(ok), `should accept ${ok}`).toBe(true);
      }
    });
    it("REFUSES the injection forms (the harm)", () => {
      for (const bad of [
        "url(https://attacker.example/x)",
        "\\75 rl(https://attacker.example/x)", // escaped url()
        "var(--x)",
        "rgb/* */(0,0,0)",                     // comment-split
        "(",                                    // bare paren
        "#fff;background:url(https://x)",       // ;-injection
        "color(display-p3 1 0 0)",             // refuse-by-default (not in grammar)
        "expression(alert(1))",
        "#gggggg", "123456", "", "notacolorword-with-dash",
        "a".repeat(65),
      ]) {
        expect(isSafeCssColorValue(bad), `should refuse ${JSON.stringify(bad)}`).toBe(false);
      }
    });
  });

  describe("write-path schema — the primary control", () => {
    it("(innocent twin) a fully-valid theme passes the schema", () => {
      expect(CustomThemeSchema.safeParse(theme("#1e1e2e")).success).toBe(true);
      expect(SetDashboardThemeSchema.safeParse({ mode: "custom", custom_json: theme("#1e1e2e") }).success).toBe(true);
    });
    it("(harm) a theme with a url() token is REJECTED at the schema", () => {
      const r = CustomThemeSchema.safeParse(theme("#1e1e2e", { bg: "url(https://attacker.example/x)" }));
      expect(r.success).toBe(false);
      // And through the tool schema (same field), so the WRITE cannot store it.
      expect(SetDashboardThemeSchema.safeParse({ mode: "custom", custom_json: theme("#1e1e2e", { accent: "var(--x)" }) }).success).toBe(false);
    });
  });

  describe("read-side defence in depth ships in the dashboard", () => {
    let server: HttpServer;
    let port = 0;
    beforeEach(async () => {
      _resetDashboardWsForTests();
      if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
      fs.mkdirSync(TEST_DB_DIR, { recursive: true });
      server = startHttpServer(0, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 60));
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
    });
    afterEach(() => {
      try { server.close(); } catch { /* ignore */ }
      _resetDashboardWsForTests();
      closeDb();
      if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    });

    it("GET /dashboard carries the isSafeThemeColor guard on setProperty", async () => {
      const body: string = await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/dashboard" }, (res) => {
          let b = ""; res.setEncoding("utf8");
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(b));
        }).on("error", reject);
      });
      expect(body).toContain("function isSafeThemeColor");
      expect(body).toContain("isSafeThemeColor(obj[t])");
    });
  });
});
