// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0040 item 2 — every field that goes into a pasted shell line is validated
 * against a strict pattern and then shell-quoted. On ANY failure the line is not
 * emitted and the caller is told why (architect, "Injection applies to the Copy
 * lines too"):
 *   conversation id = UUID; name / role = [a-z0-9-]; folder = an existing
 *   directory under allowlisted roots; model = a known list.
 * Plus victra (24 Sep): a sub-agent conversation is never a resume target; the
 * refusal names the parent.
 *
 * The quoting is proven by EXECUTION, not by string comparison: each hostile value
 * is quoted, handed to a real /bin/sh (and zsh, Maxime's shell) and must come back
 * byte-identical with no side effect.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const UUID = "32e92508-b5ce-4bc3-b3c7-f96944f90d93";
const PARENT = "01a0a96c-6b52-7c11-9e6a-59da5d914e48";
const MODELS = ["claude-opus-5-5", "claude-sonnet-5", "gpt-6-sol"] as const;

let ROOT: string; // an allowlisted root
let OUTSIDE: string; // a directory outside it
let HOSTILE_DIR: string; // legal directory name that is dangerous unquoted

beforeAll(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0040-lines-")));
  ROOT = path.join(base, "root");
  OUTSIDE = path.join(base, "root-evil"); // shares ROOT as a string prefix
  fs.mkdirSync(path.join(ROOT, "Claude AI", "proj"), { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  HOSTILE_DIR = path.join(ROOT, "a'b; touch PWNED $(touch PWNED2) `touch PWNED3`");
  fs.mkdirSync(HOSTILE_DIR);
  fs.writeFileSync(path.join(ROOT, "a-file"), "x");
  fs.symlinkSync(OUTSIDE, path.join(ROOT, "link-out"));
});

afterAll(() => {
  fs.rmSync(path.dirname(ROOT), { recursive: true, force: true });
});

function policy() {
  return { allowedRoots: [ROOT], knownModels: MODELS };
}

function good(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: UUID,
    name: "victra-build",
    role: "builder",
    folder: path.join(ROOT, "Claude AI", "proj"),
    model: "claude-opus-5-5",
    parentThreadId: null,
    ...overrides,
  };
}

async function lf() {
  return import("../src/fleet-line-fields.js");
}

describe("ADR-0040 line fields — accept only what is provably safe", () => {
  it("a fully valid record passes, folder canonicalised", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good(), policy());
    expect(r).toEqual({
      ok: true,
      fields: {
        conversationId: UUID,
        name: "victra-build",
        role: "builder",
        folder: path.join(ROOT, "Claude AI", "proj"),
        model: "claude-opus-5-5",
      },
    });
  });

  it("name, role and model are optional; a missing one is null, not a refusal", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ name: null, role: undefined, model: null }), policy());
    expect(r.ok).toBe(true);
    expect(r.ok && r.fields).toMatchObject({ name: null, role: null, model: null });
  });

  it.each([
    ["not a uuid", "resume-me"],
    ["uppercase hex", UUID.toUpperCase()],
    ["trailing newline", UUID + "\n"],
    ["injection tail", UUID + "; rm -rf ~"],
    ["too short", "32e92508-b5ce-4bc3-b3c7-f96944f90d9"],
  ])("conversation id refused: %s", async (_label, id) => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ conversationId: id }), policy());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toMatch(/conversation id/i);
  });

  it.each([
    ["uppercase", "Victra"],
    ["underscore", "victra_build"],
    ["dot", "victra.build"],
    ["space", "victra build"],
    ["semicolon", "x;id"],
    ["newline", "x\nid"],
    ["empty", ""],
    ["too long", "a".repeat(65)],
  ])("name refused: %s", async (_label, name) => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ name }), policy());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toMatch(/\bname\b/i);
  });

  it("role follows the same pattern as name", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ role: "Builder;id" }), policy());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toMatch(/\brole\b/i);
  });

  it("model outside the known list is refused, naming it as unknown", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ model: "claude-opus-5-5 --dangerously-skip-permissions" }), policy());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toMatch(/model/i);
  });
});

describe("ADR-0040 line fields — the folder", () => {
  it("a directory that does not exist is refused", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ folder: path.join(ROOT, "nope") }), policy());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toMatch(/folder/i);
  });

  it("a file is not a folder", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ folder: path.join(ROOT, "a-file") }), policy());
    expect(r.ok).toBe(false);
  });

  it("a relative path is refused (it would resolve against wherever Maxime pastes)", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ folder: "Claude AI/proj" }), policy());
    expect(r.ok).toBe(false);
  });

  it("outside the allowlisted roots is refused, INCLUDING a sibling that shares the root as a string prefix", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ folder: OUTSIDE }), policy());
    expect(OUTSIDE.startsWith(ROOT), "precondition: the prefix trap is real").toBe(true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toMatch(/allow/i);
  });

  it("a symlink inside a root that resolves OUTSIDE it is refused (checked after realpath)", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ folder: path.join(ROOT, "link-out") }), policy());
    expect(r.ok).toBe(false);
  });

  it("a control character in the folder is refused before anything else looks at it", async () => {
    const { validateLineFields } = await lf();
    for (const bad of [ROOT + "/x\ny", ROOT + "/x\ry", ROOT + "/x\u0000y", ROOT + "/x\u001by"]) {
      const r = validateLineFields(good({ folder: bad }), policy());
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.reasons.join(" ")).toMatch(/control/i);
    }
  });

  it("a legal but hostile directory name is ACCEPTED: it exists, and quoting (below) makes it inert", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ folder: HOSTILE_DIR }), policy());
    expect(r.ok).toBe(true);
  });

  it("with no allowlisted roots, nothing is allowed (default-deny, not default-allow)", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good(), { allowedRoots: [], knownModels: MODELS });
    expect(r.ok).toBe(false);
  });
});

describe("ADR-0040 line fields — sub-agents and complete refusals", () => {
  it("a SUB-AGENT conversation is refused and the reason names the parent to resume instead", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ parentThreadId: PARENT }), policy());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toMatch(/sub-agent/i);
    expect(!r.ok && r.reasons.join(" ")).toContain(PARENT);
  });

  it("every failing field is reported, not just the first (the panel says everything that is wrong)", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(
      good({ conversationId: "bad", name: "Bad", role: "Bad", folder: "/definitely/not/here", model: "nope" }),
      policy(),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.length).toBe(5);
  });

  it("a refusal never echoes a raw hostile value with its control characters intact", async () => {
    const { validateLineFields } = await lf();
    const r = validateLineFields(good({ name: "x\n\u001b[31mEVIL" }), policy());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("ADR-0040 shellQuote — proven by execution", () => {
  const HOSTILE = [
    "plain",
    "with space",
    "a'b",
    "''",
    "$(touch PWNED)",
    "`touch PWNED`",
    "; touch PWNED",
    "&& touch PWNED",
    "| touch PWNED",
    '"double"',
    "back\\slash",
    "*",
    "~",
    "!event",
    "$HOME",
    "${IFS}",
    "",
  ];

  const shells = ["/bin/sh", ...(fs.existsSync("/bin/zsh") ? ["/bin/zsh"] : [])];

  it.each(shells)("every hostile value round-trips byte-identical through %s with no side effect", async (shell) => {
    const { shellQuote } = await lf();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adr0040-quote-"));
    try {
      for (const v of HOSTILE) {
        const r = spawnSync(shell, ["-c", `printf '%s' ${shellQuote(v)}`], { cwd, encoding: "utf-8", env: { PATH: process.env.PATH ?? "" } });
        expect(r.status, `${shell} failed on ${JSON.stringify(v)}: ${r.stderr}`).toBe(0);
        expect(r.stdout, JSON.stringify(v)).toBe(v);
      }
      expect(fs.readdirSync(cwd), "a quoted value executed something").toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("the hostile DIRECTORY is reachable by `cd` through the quoted path, and nothing ran", async () => {
    const { shellQuote } = await lf();
    const r = spawnSync("/bin/sh", ["-c", `cd ${shellQuote(HOSTILE_DIR)} && pwd -P`], { cwd: ROOT, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(HOSTILE_DIR);
    expect(fs.readdirSync(ROOT).filter((f) => f.startsWith("PWNED"))).toEqual([]);
  });

  it("refuses control characters instead of quoting them (a newline would still end a pasted line)", async () => {
    const { shellQuote } = await lf();
    for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb", "a\tb"]) {
      expect(() => shellQuote(bad), JSON.stringify(bad)).toThrow(/control/i);
    }
  });
});
