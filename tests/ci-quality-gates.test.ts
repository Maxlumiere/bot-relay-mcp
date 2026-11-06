// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The CI quality gates: a BLOCKING secrets scan (gitleaks, pinned by SHA-256) and a BLOCKING bug lint on the lines a
 * change adds, both required through ci-ok. These rows pin the parts that need no pinned tool (the changed-lines
 * reader on real git repos, the added-line filter, the scope, the canary markers, the gitleaks config edit), the
 * verdict, and the workflow's shape. The gates themselves are proven on every CI run by their canaries (every rule /
 * the secrets scan must fire on a known-bad input) and their planted checks (a violation committed in the CI checkout
 * must BLOCK), which need the pinned tools and so run in their jobs, not here.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  hunkAddedLines, onAddedLines, inLintScope, canaryExpectations, changedFiles, addedLinesBetween, changeRange, ghData, ghProperty,
} from "../scripts/ci-lint-lib.mjs";
import { narrowConfig, ALLOWED_PATHS, UPSTREAM, UPSTREAM_URL } from "../scripts/ci-gitleaks-config.mjs";
import { verdict } from "../scripts/ci-verdict.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("the added-line filter", () => {
  it("reads one file's hunks: ranges, single lines, pure deletions (none); no file header is read", () => {
    const diff = [
      "diff --git a/src/x y.ts\t b/src/x y.ts\t",
      "+++ b/src/x y.ts\t",
      "@@ -3,0 +4,2 @@ ctx",
      "+added4",
      "+added5",
      "@@ -10 +12 @@",
      "-old",
      "+new12",
      "@@ -20,3 +21,0 @@",
      "-gone",
    ].join("\n");
    const { lines, hunks, binary } = hunkAddedLines(diff);
    expect([...lines].sort((a, b) => a - b)).toEqual([4, 5, 12]);
    expect(hunks).toBe(3);
    expect(binary).toBe(false);
    expect(hunkAddedLines("Binary files a/src/a.ts and b/src/a.ts differ\n").binary).toBe(true);
  });
  it("keeps findings on added lines only; a message with NO rule (not linted) is kept wherever it is", () => {
    const added = new Map([["src/a.ts", new Set([4])], ["src/b.ts", new Set([1, 2, 3])]]);
    const results = [
      { filePath: "/r/src/a.ts", messages: [{ line: 4, ruleId: "eqeqeq", message: "m" }, { line: 6, ruleId: "eqeqeq", message: "untouched line" }] },
      { filePath: "/r/src/b.ts", messages: [{ line: undefined, ruleId: null, message: "File ignored because outside of base path." }] },
    ];
    const kept = onAddedLines(results, added, (p: string) => p.replace("/r/", ""));
    expect(kept).toEqual([
      { file: "src/a.ts", line: 4, rule: "eqeqeq", message: "m" },
      { file: "src/b.ts", line: 1, rule: "not-linted", message: "File ignored because outside of base path." },
    ]);
  });
  it("the scope: the root package's TypeScript and the scripts, never fixtures", () => {
    for (const f of ["src/db.ts", "tests/x.test.ts", "scripts/a.mjs", "src/cli/init.ts", "src/has space.ts", "src/ünï.ts"]) expect(inLintScope(f), f).toBe(true);
    for (const f of ["tests/fixtures/bad.ts", "README.md", "hooks/check-relay.sh", "extensions/vscode/src/a.ts", "tools/lint/canary/clean.ts"]) expect(inLintScope(f), f).toBe(false);
  });
  it("a file name printed into the CI log cannot start a workflow command (newline, %, and : , in a property)", () => {
    expect(ghData("a\n::add-mask::x\r%")).toBe("a%0A::add-mask::x%0D%25");
    expect(ghProperty("src/a,b:c.ts")).toBe("src/a%2Cb%3Ac.ts");
    expect(ghData("a\n::x")).not.toMatch(/\n/);
  });
  it("the lint gate prints NOTHING interpolated except through ghData (names, refs, messages)", () => {
    const src = read("tools/lint/lint-changed.mjs");
    // The one exception is the annotation, whose property and data are each escaped (never twice: %0A must stay %0A).
    const annotation = "  console.log(`::${level} file=${ghProperty(f.file)},line=${f.line}::${ghData(`${f.rule}: ${f.message}`)}`);";
    expect(src).toContain(annotation);
    const raw = src.split("\n").filter((l) => /console\.log\(/.test(l) && /\$\{/.test(l) && !/console\.log\(ghData\(/.test(l) && l !== annotation);
    expect(raw).toEqual([]);
    expect(src).toContain("console.log(ghData(`lint: REFUSED: ${e.message}`));");
  });
  it("nor the runner's LEGACY `##[...]` form, which it recognises anywhere in a line", () => {
    expect(ghData("src/##[stop-commands]pause.ts")).toBe("src/##%5Bstop-commands]pause.ts");
    expect(ghProperty("src/##[set-env name=X;]1.ts")).not.toContain("##[");
    expect(ghData("##[group]a ##[endgroup]")).not.toContain("##[");
  });
  it("the scope sees names with ANY line terminator (LF, CR, U+2028, U+2029): no `.` decides it", () => {
    for (const t of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(inLintScope(`src/a${t}b.ts`), JSON.stringify(t)).toBe(true);
      expect(inLintScope(`tests/a${t}b.ts`), JSON.stringify(t)).toBe(true);
      expect(inLintScope(`scripts/a${t}b.mjs`), JSON.stringify(t)).toBe(true);
      expect(inLintScope(`tests/fixtures/a${t}b.ts`), JSON.stringify(t)).toBe(false);
      expect(inLintScope(`src/a.ts${t}`), JSON.stringify(t)).toBe(false);
    }
    for (const f of ["src/", "src/.ts", "tests/.mts", "scripts/.mjs", "src.ts", "srcx/a.ts"]) expect(inLintScope(f), f).toBe(false);
  });
});

/**
 * The changed-lines reader on REAL git repos, built in a temp dir: the names, attributes and ranges a pull request can
 * choose, each of which made the first version of this gate pass having linted nothing.
 */
describe("the changed-lines reader, on real git repos", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const git = (d: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: d, encoding: "utf8" }).trim();
  const repo = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lint-gate-"));
    dirs.push(d);
    git(d, "init", "-q");
    fs.mkdirSync(path.join(d, "src"));
    fs.writeFileSync(path.join(d, "src", "base.ts"), "export const base = 1;\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "base");
    return d;
  };
  const commit = (d: string, files: Record<string, string>, msg = "c") => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), text);
    }
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", msg);
    return git(d, "rev-parse", "HEAD");
  };
  type Changed = { status: string; from: string; to: string };
  const changes = (d: string, from: string, to: string) => {
    const files = (changedFiles(d, from, to) as Changed[]).filter((f) => f.status !== "D");
    return { files, ...addedLinesBetween(d, from, to, files) } as { files: Changed[]; added: Map<string, Set<number>>; unmapped: string[] };
  };
  const THREE = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";

  const names = ["src/has space.ts", "src/ünï.ts", 'src/quo"te.ts', "src/[glob]{x}.ts"];
  names.push("src/line\u2028sep.ts", "src/para\u2029sep.ts");
  if (process.platform !== "win32") names.push("src/has\ttab.ts", "src/star*.ts", "src/new\nline.ts", "src/carriage\rreturn.ts");
  it.each(names)("a file named %j: listed verbatim, IN SCOPE, every added line mapped", (name) => {
    const d = repo();
    const base = git(d, "rev-parse", "HEAD");
    const head = commit(d, { [name]: THREE });
    const { files, added, unmapped } = changes(d, base, head);
    // The same filter the gate applies before mapping: a name it drops is never linted.
    expect(files.filter((f) => inLintScope(f.to)).map((f) => f.to)).toEqual([name]);
    expect([...added.get(name)!]).toEqual([1, 2, 3]);
    expect(unmapped).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a name with glob characters is a LITERAL pathspec: its lines are its own, never a sibling's", () => {
    const d = repo();
    const base = git(d, "rev-parse", "HEAD");
    const head = commit(d, { "src/star*.ts": THREE, "src/star-sibling.ts": THREE + "export const d = 4;\nexport const e = 5;\n" });
    const { added } = changes(d, base, head);
    expect([...added.get("src/star*.ts")!]).toEqual([1, 2, 3]);
    expect([...added.get("src/star-sibling.ts")!]).toEqual([1, 2, 3, 4, 5]);
  });

  it("a file marked -diff (and `binary`) still yields its added lines: every diff is forced to text", () => {
    const d = repo();
    const base = commit(d, { ".gitattributes": "src/a.ts -diff\nsrc/b.ts binary\n" });
    const head = commit(d, { "src/a.ts": THREE, "src/b.ts": THREE });
    const { added, unmapped } = changes(d, base, head);
    expect([...added.get("src/a.ts")!]).toEqual([1, 2, 3]);
    expect([...added.get("src/b.ts")!]).toEqual([1, 2, 3]);
    expect(unmapped).toEqual([]);
  });

  it("a rename keeps only the lines the rename changed, under the NEW name", () => {
    const d = repo();
    const body = Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    const base = commit(d, { "src/old name.ts": body });
    fs.renameSync(path.join(d, "src/old name.ts"), path.join(d, "src/new name.ts"));
    const head = commit(d, { "src/new name.ts": body.replace("v4 = 4", "v4 = 40") });
    const { files, added } = changes(d, base, head);
    expect(files.map((f) => `${f.status} ${f.to}`)).toEqual(["R src/new name.ts"]);
    expect([...added.get("src/new name.ts")!]).toEqual([5]);
  });

  it("an empty new file is not unmapped; a changed file with NO textual hunk is (fail closed)", () => {
    const d = repo();
    const base = git(d, "rev-parse", "HEAD");
    const head = commit(d, { "src/empty.ts": "", "src/a.ts": THREE });
    const files = changedFiles(d, base, head);
    expect(addedLinesBetween(d, base, head, files).unmapped).toEqual([]);
    const binaryForA = (paths: string[]) => (paths.includes("src/a.ts") ? "Binary files a/src/a.ts and b/src/a.ts differ\n" : "");
    expect(addedLinesBetween(d, base, head, files, binaryForA).unmapped).toEqual(["src/a.ts"]);
    expect(addedLinesBetween(d, base, head, files, () => "").unmapped).toEqual(["src/a.ts"]);
  });

  it("a push is judged by a DIRECT tree compare: a force-push back to an ancestor still shows the lines it restores", () => {
    const d = repo();
    const x = commit(d, { "src/f.ts": THREE + "work();\n" }, "X adds the line");
    const y = commit(d, { "src/f.ts": THREE }, "Y removes it");
    const range = changeRange(d, "push", y, x);
    expect(range).toEqual({ from: y, to: x });
    expect([...changes(d, range.from, range.to).added.get("src/f.ts")!]).toEqual([4]);
    // The same two commits as a pull request (base y, head x): the merge base is x itself, so the PR adds nothing.
    expect(changeRange(d, "pr", y, x)).toEqual({ from: x, to: x });
  });

  it("a pull request is judged from the merge base, so the base branch's own later commits are not its lines", () => {
    const d = repo();
    const fork = git(d, "rev-parse", "HEAD");
    git(d, "checkout", "-q", "-b", "feature");
    const head = commit(d, { "src/feature.ts": THREE });
    git(d, "checkout", "-q", "-");
    const baseTip = commit(d, { "src/main-only.ts": THREE });
    expect(changeRange(d, "pr", baseTip, head)).toEqual({ from: fork, to: head });
    expect(changes(d, fork, head).files.map((f) => f.to)).toEqual(["src/feature.ts"]);
  });

  it("refuses what it cannot judge: a push that created the branch, an unknown before, a PR with no merge base", () => {
    const d = repo();
    const head = git(d, "rev-parse", "HEAD");
    expect(() => changeRange(d, "push", "0".repeat(40), head)).toThrow(/CREATED the branch/);
    expect(() => changeRange(d, "push", "", head)).toThrow(/CREATED the branch/);
    expect(() => changeRange(d, "push", "1".repeat(40), head)).toThrow(/not in this checkout/);
    git(d, "checkout", "-q", "--orphan", "other");
    const orphan = commit(d, { "src/o.ts": THREE });
    expect(() => changeRange(d, "pr", head, orphan)).toThrow(/no merge base/);
  });
});

describe("the lint canaries", () => {
  const dir = "tools/lint/canary";
  const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts"));
  it("cover every blocking rule, one canary line each, and a clean file with none", () => {
    const exp = files.flatMap((f) => canaryExpectations(`${dir}/${f}`, read(`${dir}/${f}`)));
    const config = read("tools/lint/eslint.config.mjs");
    const rules = [...config.matchAll(/^\s+"?(@typescript-eslint\/[a-z-]+|eqeqeq)"?:/gm)].map((m) => m[1]).sort();
    expect(rules).toEqual(["@typescript-eslint/no-floating-promises", "@typescript-eslint/no-misused-promises", "@typescript-eslint/no-unused-vars", "eqeqeq"]);
    expect(exp.map((e) => e.rule).sort()).toEqual(rules);
    expect(files).toContain("clean.ts");
    expect(canaryExpectations("clean.ts", read(`${dir}/clean.ts`))).toEqual([]);
  });
});

describe("ci-ok requires both blocking gates", () => {
  const needs = (over: Record<string, string> = {}) => {
    const base: Record<string, string> = {
      changes: "success", shard: "success", checks: "success", test: "success", smoke: "success",
      "timing-bars": "success", "test-windows": "success", "test-macos": "success", secrets: "success", lint: "success",
    };
    return Object.fromEntries(Object.entries({ ...base, ...over }).map(([k, r]) => [k, { result: r, outputs: k === "changes" ? { full: "true" } : {} }]));
  };
  it("green only when secrets AND lint succeeded; a skip, failure or cancellation of either FAILS", () => {
    expect(verdict(needs(), "all").ok).toBe(true);
    for (const j of ["secrets", "lint"]) for (const r of ["skipped", "failure", "cancelled"]) expect(verdict(needs({ [j]: r }), "all").ok, `${j}=${r}`).toBe(false);
  });
  it("a missing gate (not in needs) FAILS", () => {
    const n = needs();
    delete n.secrets;
    expect(verdict(n, "all").ok).toBe(false);
  });
});

describe("the gates' pins and wiring", () => {
  const sh = read("scripts/ci-gitleaks.sh");
  const ci = read(".github/workflows/ci.yml");
  const job = (id: string) => ci.slice(ci.indexOf(`\n  ${id}:\n`), ci.indexOf("\n  # ", ci.indexOf(`\n  ${id}:\n`) + 5));
  it("gitleaks: one exact version and a 64-hex SHA-256, checked before the binary runs", () => {
    expect(sh).toMatch(/^GITLEAKS_VERSION="\d+\.\d+\.\d+"$/m);
    expect(sh).toMatch(/^GITLEAKS_SHA256="[0-9a-f]{64}"$/m);
    expect(sh).toMatch(/sha256sum "\$tgz"[\s\S]*if \[ "\$got" != "\$GITLEAKS_SHA256" \][\s\S]*exit 1[\s\S]*tar -xzf/);
    expect(sh).toMatch(/--redact/);
    expect(sh).not.toMatch(/releases\/latest|@latest/);
  });
  it("gitleaks reads git with merge diffs and forced text, always through the narrowed config", () => {
    const opts = sh.match(/^GIT_LOG_OPTS="([^"]*)"$/m)?.[1].split(" ") ?? [];
    expect(opts.sort()).toEqual(["--diff-merges=separate", "--no-ext-diff", "--no-textconv", "--text"]);
    // Every scan goes through leaks(): the narrowed config, no inline allow, only a TRUSTED ignore file, the repo's
    // git dir as its source (a commit cannot put a .gitleaksignore there) and an empty working directory.
    const direct = sh.split("\n").filter((l) => /"\$BIN" (git|dir|detect)/.test(l));
    expect(direct).toEqual([
      '  (cd "$cwd" && "$BIN" git "$gitdir" --config "$CONFIG" --ignore-gitleaks-allow --gitleaks-ignore-path "${ignore:-$cwd/none}" --redact --no-banner "$@")',
    ]);
    expect(sh).toContain('gitdir="$(git -C "$repo" rev-parse --absolute-git-dir)"');
    const calls = sh.match(/^\s+leaks .*$/gm) ?? [];
    expect(calls.length).toBe(3);
    for (const call of calls) expect(call, call).toContain("$GIT_LOG_OPTS");
    // The trusted side: a PR's base, a push's before (none for a branch-creating push), main itself for the baseline.
    expect(sh).toMatch(/pull_request\) range="\$\{PR_BASE\}\.\.\$\{PR_HEAD\}"; trusted="\$PR_BASE" ;;/);
    expect(sh).toMatch(/range="\$\{PUSH_BEFORE\}\.\.\$\{PUSH_AFTER\}"\n\s+trusted="\$PUSH_BEFORE"/);
    expect(sh).toContain('leaks "$ROOT" "$(trusted_ignore HEAD)" --log-opts');
    // A push that creates the branch scans what no other ref holds; never just the tip.
    expect(sh).not.toMatch(/range="-1 /);
    expect(sh).toContain('--not --exclude=origin/${PUSH_REF_NAME:?} --remotes --tags"');
    // The report escapes a file name like the lint gate (ghData): %, CR, LF, and the legacy `##[` command form.
    expect(sh).toContain('.replace(/%/g, "%25").replace(/\\r/g, "%0D").replace(/\\n/g, "%0A").replace(/##\\[/g, "##%5B")');
    // The six planted cases, and the canary in the paths upstream's allowlist skips and behind both self-exemptions.
    for (const c of ["setup_plain", "setup_merge", "setup_attr", "setup_zero zero", "setup_inline", "setup_selfignore"]) expect(sh).toMatch(new RegExp(`^  plant_one .* ${c}$`, "m"));
    for (const f of ["package-lock.json", "icon.svg", "node_modules/x/index.js", "my.gitleaks.toml", "inline.js", "selfignored.js"]) expect(sh).toContain(f);
  });
  it("the gitleaks config: upstream pinned by commit + SHA-256, ONLY the global path allowlist narrowed", () => {
    expect(UPSTREAM.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(UPSTREAM.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(UPSTREAM_URL).toContain(`/${UPSTREAM.commit}/config/gitleaks.toml`);
    expect(ALLOWED_PATHS).toEqual([]);
    const q = "'''";
    const upstream = [
      'title = "gitleaks config"', "", "[allowlist]", 'description = "global allow lists"', "paths = [",
      `    ${q}gitleaks\\.toml${q},`, `    ${q}(?i)\\.(?:svg)$${q},`, "]", "regexes = [", `    ${q}^true$${q},`, "]",
      "stopwords = [", '    "abc",', "]", "", "[[rules]]", 'id = "x"', `regex = ${q}x${q}`, "[[rules.allowlists]]", "paths = [", `    ${q}keep${q},`, "]", "",
    ].join("\n");
    const globalPaths = `paths = [\n    ${q}gitleaks\\.toml${q},\n    ${q}(?i)\\.(?:svg)$${q},\n]`;
    expect(upstream).toContain(globalPaths);
    const out = narrowConfig(upstream, []);
    expect(out).toBe(upstream.replace(globalPaths, "paths = [\n]"));
    expect(out).toContain(`${q}keep${q}`);
    expect(out).toContain(`${q}^true$${q}`);
    expect(() => narrowConfig(upstream + "\n[[allowlists]]\n", [])).toThrow(/exactly one global/);
    expect(() => narrowConfig(upstream.replace(globalPaths, "files = []"), [])).toThrow(/one paths array/);
  });
  it("the lint toolchain: exact versions only (no ranges) and a lockfile", () => {
    const pkg = JSON.parse(read("tools/lint/package.json"));
    for (const [name, v] of Object.entries(pkg.devDependencies as Record<string, string>)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.existsSync(path.join(ROOT, "tools/lint/package-lock.json"))).toBe(true);
  });
  it("the new jobs pin every action to a full commit SHA and install with --ignore-scripts", () => {
    for (const id of ["secrets", "lint", "quality-report"]) {
      const j = job(id);
      const uses = j.match(/uses: \S+/g) ?? [];
      expect(uses.length, id).toBeGreaterThan(0);
      for (const u of uses) expect(u, `${id}: ${u}`).toMatch(/^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      for (const line of j.match(/npm ci.*/g) ?? []) expect(line, `${id}: ${line}`).toContain("--ignore-scripts");
    }
  });
  it("both jobs run their canary and their planted check BEFORE the blocking step, and ci-ok needs both", () => {
    const sec = job("secrets");
    expect(sec.indexOf("ci-gitleaks.sh install")).toBeLessThan(sec.indexOf("ci-gitleaks.sh canary"));
    expect(sec.indexOf("ci-gitleaks.sh canary")).toBeLessThan(sec.indexOf("ci-gitleaks.sh plant-check"));
    expect(sec.indexOf("ci-gitleaks.sh plant-check")).toBeLessThan(sec.indexOf("ci-gitleaks.sh scan-event"));
    expect(sec).toMatch(/fetch-depth: 0/);
    expect(sec).toMatch(/PUSH_REF_NAME: \$\{\{ github\.ref_name \}\}/);
    const lint = job("lint");
    expect(lint.indexOf("--canary")).toBeLessThan(lint.indexOf("--plant-check"));
    expect(lint.indexOf("--plant-check")).toBeLessThan(lint.indexOf("--pr "));
    expect(lint).toMatch(/--pr "\$PR_BASE" "\$PR_HEAD"/);
    // Every push goes to the script, which refuses a branch-creating one; the workflow never skips it.
    expect(lint).toMatch(/elif \[ "\$EVENT" = push \]; then\n\s+node tools\/lint\/lint-changed\.mjs --push "\$PUSH_BEFORE" "\$PUSH_AFTER"/);
    expect(lint).not.toMatch(/0{40}/);
    expect(lint).toMatch(/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    expect(ci).toMatch(/^    needs: \[[^\]]*\bsecrets\b[^\]]*\blint\b[^\]]*\]$/m);
  });
});
