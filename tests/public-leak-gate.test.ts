// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The public leak gate (layer C): the workflow's SAFETY SHAPE, its scan step's BEHAVIOUR (run for real with bash), and
 * the public scanner copy. Fixture list only (nonsense terms); the real list is a repository secret this test never sees.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF_FILE = fs.readFileSync(path.join(REPO, ".github", "workflows", "public-leak-gate.yml"), "utf-8");
/**
 * THE MUTANTS, checkable from git objects: tests/fixtures/public-leak-gate-mutants.json holds each workflow mutation as
 * an exact {find, replace} diff. `LEAK_GATE_MUTANT=<name> npx vitest run tests/public-leak-gate.test.ts` runs this whole
 * file against the MUTATED workflow, and must go RED; without the variable it runs against the real file.
 */
const MUTANTS = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "public-leak-gate-mutants.json"), "utf-8")) as Array<{ name: string; find: string; replace: string }>;
const MUTANT = process.env.LEAK_GATE_MUTANT ?? null;
const WF = ((): string => {
  if (MUTANT === null) return WF_FILE;
  const m = MUTANTS.find((x) => x.name === MUTANT);
  if (!m || WF_FILE.split(m.find).length !== 2) throw new Error(`LEAK_GATE_MUTANT: unknown or inapplicable mutant ${MUTANT}`);
  return WF_FILE.replace(m.find, () => m.replace);
})();
const SCAN = path.join(REPO, "tools", "public-leak-scan", "scan.mjs");
/**
 * A FIXTURE list (nonsense terms), built at run time: the canary is never written contiguously in a file of this
 * public repo, whose added lines are scanned with a list that carries it.
 */
const LIST = `${["zq", "canary", "7f3e9a1d"].join("-")}\nzorblax\n`;
const FIXTURE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-list-")), "fixture.txt");
fs.writeFileSync(FIXTURE, LIST);

describe("the workflow's safety shape", () => {
  it("runs on pull_request_target only (opened, edited, synchronize, reopened)", () => {
    expect(WF).toMatch(/^on:\n {2}pull_request_target:\n {4}types: \[opened, edited, synchronize, reopened\]/m);
    expect(WF).not.toMatch(/^ {2}pull_request:/m);
  });

  it("checks out the BASE commit only, without persisted credentials, and ASSERTS HEAD is the base sha", () => {
    expect(WF).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(WF).toContain("persist-credentials: false");
    expect(WF).toContain('test "$(git rev-parse HEAD)" = "$BASE_SHA"');
    expect(WF).not.toMatch(/ref:\s*\$\{\{\s*github\.(event\.pull_request\.head|head_ref)/);
  });

  it("never interpolates untrusted PR text into a script (title and body via the API, the branch via the event file; as files)", () => {
    expect(WF).not.toMatch(/\$\{\{\s*github\.event\.pull_request\.(title|body|head\.ref|head\.label)\s*\}\}/);
    expect(WF).not.toMatch(/\$\{\{\s*github\.head_ref\s*\}\}/);
  });

  it("the secret enters only as the PUBLIC_DENYLIST env var and is read with --list-env (never an argument)", () => {
    const uses = WF.match(/secrets\.PUBLIC_DENYLIST/g) ?? [];
    expect(uses.length).toBe(1);
    expect(WF).toContain("PUBLIC_DENYLIST: ${{ secrets.PUBLIC_DENYLIST }}");
    expect(WF).toContain("--list-env PUBLIC_DENYLIST");
    expect(WF).not.toMatch(/--list\s+\S*\$\{\{/);
  });

  it("pins actions/checkout to a FULL commit sha (a privileged workflow)", () => {
    expect(WF).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v/);
    expect(WF).not.toMatch(/uses: actions\/checkout@v\d/);
  });

  it("no step may continue on error; the commits come from ONE compare response addressed by the event's own shas", () => {
    expect(WF).not.toMatch(/continue-on-error/);
    expect(WF).toContain('gh api "repos/$REPO/compare/$base...$head" > "$meta/compare.json"');
    expect(WF).not.toMatch(/pulls\/\$PR_NUMBER\/commits/); // the mutable per-PR listing is not used
    expect(WF).toContain(`base="$(jq -r '.pull_request.base.sha' "$GITHUB_EVENT_PATH")"`);
    expect(WF).toContain(`head="$(jq -r '.pull_request.head.sha' "$GITHUB_EVENT_PATH")"`);
  });

  it("every mutant in the fixture still applies to the real workflow (its find text occurs exactly once)", () => {
    expect(MUTANTS.length).toBeGreaterThanOrEqual(15);
    for (const m of MUTANTS) expect(WF_FILE.split(m.find).length - 1, m.name).toBe(1);
    expect(new Set(MUTANTS.map((m) => m.name)).size).toBe(MUTANTS.length);
  });

  it("asks for read-only permissions", () => {
    expect(WF).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: read\n/);
    expect(WF).not.toMatch(/: write/);
  });
});

/** The workflow's own "Scan" step, executed with bash against fixture metadata. */
function runScanStep(meta: Record<string, string>, env: Record<string, string>): { status: number | null; out: string } {
  const m = /- name: Scan \(prints field and term indexes only\)\n[\s\S]*?\n {8}run: \|\n([\s\S]*?)(?:\n {6}- name:|\s*$)/.exec(WF);
  expect(m, "the Scan step exists").not.toBeNull();
  const script = m![1]!.split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-"));
  fs.mkdirSync(path.join(tmp, "leak-meta"));
  for (const [k, v] of Object.entries({ "pr-title": "", "pr-body": "", branch: "", "commit-msg": "", ...meta })) fs.writeFileSync(path.join(tmp, "leak-meta", k), v);
  const r = spawnSync("bash", ["-e", "-c", script], { cwd: REPO, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: tmp, ...env } });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("the scan step, run for real (bash, fixture list)", () => {
  it("clean metadata → exit 0", () => {
    const r = runScanStep({ "pr-title": "fix(cli): a clean title", "pr-body": "an ordinary body", branch: "fix/clean", "commit-msg": "fix: clean" }, { PUBLIC_DENYLIST: LIST });
    expect(r.status, r.out).toBe(0);
  });

  it("a term in the body (and one in a commit message) → exit 1 with field + index only; the term and the text are never printed", () => {
    const r = runScanStep({ "pr-body": "thanks to Zorblax for the review", "commit-msg": "fix: zorblax said so" }, { PUBLIC_DENYLIST: LIST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL field=pr-body terms=#2");
    expect(r.out).toContain("FAIL field=commit-msg terms=#2");
    expect(r.out).toContain("only the web UI removes it");
    expect(r.out.toLowerCase()).not.toContain("zorblax");
    expect(r.out).not.toContain("thanks to");
  });

  it("the secret MISSING (unset or empty) → fails CLOSED (exit 1, 'could not run'), never a pass", () => {
    for (const env of [{}, { PUBLIC_DENYLIST: "" }] as Array<Record<string, string>>) {
      const r = runScanStep({ "pr-body": "anything" }, env);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("could not run");
    }
  });
});

describe("the public scanner copy", () => {
  it("self-tests against an ENVIRONMENT list carrying the canary (CI's public form: no secret check, no copies file)", () => {
    const r = spawnSync(process.execPath, [SCAN, "--self-test", "--list-env", "FIXTURE_LIST"], { encoding: "utf-8", env: { PATH: process.env.PATH, FIXTURE_LIST: LIST } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("self-test: PASS");
  });

  // The PRIVATE self-test's own rows (the secret's hash; copies compared with what is PUBLISHED) live with the canonical
  // scanner, outside this repo. These rows hold the same contract on THIS copy, with fixture lists and a fixture repo.
  it("a FILE list is private by definition: its self-test ALWAYS checks the secret's hash, so a missing hash file is SECRET STALE (exit 2)", () => {
    const r = spawnSync(process.execPath, [SCAN, "--self-test", "--list", FIXTURE], { encoding: "utf-8", env: { PATH: process.env.PATH } });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toMatch(/SECRET STALE: re-flatten and re-set PUBLIC_DENYLIST/);
    expect(r.stdout + r.stderr, "never a path").not.toContain(path.dirname(FIXTURE));
  });

  /** A temp copy of THIS scanner with a copies file naming a copy inside a fixture repo (a local bare origin). */
  function privateCopyWithRepo(): { dir: string; list: string; copy: string; git: (cwd: string, ...a: string[]) => void; bare: string } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-private-")));
    fs.copyFileSync(SCAN, path.join(dir, "scan.mjs"));
    const list = path.join(dir, "fixture.txt");
    fs.writeFileSync(list, LIST);
    // The secret's hash beside the FILE list: the flattening is the list's terms joined by "\n", plus a final "\n".
    const terms = LIST.split("\n").filter((t) => t.trim() !== "");
    fs.writeFileSync(path.join(dir, "public-denylist.secret.sha256"), `${crypto.createHash("sha256").update(`${terms.join("\n")}\n`).digest("hex")}\n`);
    const git = (cwd: string, ...a: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=fx", "-c", "user.email=fx@invalid", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf-8" });
      expect(r.status, `git ${a.join(" ")}: ${r.stderr}`).toBe(0);
    };
    const bare = path.join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", bare);
    const work = path.join(dir, "work");
    git(dir, "clone", "-q", bare, work);
    const copy = path.join(work, "tools", "public-leak-scan", "scan.mjs");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(SCAN, copy);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "publish");
    git(work, "push", "-q", "origin", "HEAD:main");
    fs.writeFileSync(path.join(dir, "copies.tsv"), `fixture-repo\t${copy}\n`);
    return { dir, list, copy, git, bare };
  }
  const privateSelfTest = (p: { dir: string; list: string }) =>
    spawnSync(process.execPath, [path.join(p.dir, "scan.mjs"), "--self-test", "--list", p.list], { encoding: "utf-8", env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0" } });

  it("a NARROWED refspec cannot hide a stale published copy: main is fetched explicitly → DRIFT (exit 2)", () => {
    const p = privateCopyWithRepo();
    const work = path.dirname(path.dirname(path.dirname(p.copy)));
    p.git(work, "push", "-q", "origin", "HEAD:other");
    p.git(work, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
    const other = path.join(p.dir, "other");
    p.git(p.dir, "clone", "-q", p.bare, other);
    fs.appendFileSync(path.join(other, "tools", "public-leak-scan", "scan.mjs"), "// published on main only\n");
    p.git(other, "commit", "-q", "-am", "drift");
    p.git(other, "push", "-q", "origin", "HEAD:main");
    const r = privateSelfTest(p);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toMatch(/^DRIFT: fixture-repo$/m);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  /** The fixture repo's working tree becomes a DEPLOY TREE that predates the copy: an older branch with no tools/ at all. */
  function behindWorkingTree(p: { copy: string; git: (cwd: string, ...a: string[]) => void }): string {
    const work = path.dirname(path.dirname(path.dirname(p.copy)));
    p.git(work, "checkout", "-q", "--orphan", "deploy-tree");
    p.git(work, "rm", "-rq", "--cached", ".");
    fs.rmSync(path.join(work, "tools"), { recursive: true, force: true });
    fs.writeFileSync(path.join(work, "README.md"), "a deploy tree from before the scanner existed\n");
    p.git(work, "add", "README.md");
    p.git(work, "commit", "-q", "-m", "an older deploy tree");
    expect(fs.existsSync(path.dirname(p.copy)), "precondition: the copy's directory is absent from the working tree").toBe(false);
    return work;
  }

  it("the WORKING TREE never decides: a copy whose directory is absent locally, published IDENTICAL on main → PASS (main fetched)", () => {
    const p = privateCopyWithRepo();
    const work = behindWorkingTree(p);
    const r = privateSelfTest(p);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("self-test: PASS");
    const ref = spawnSync("git", ["-C", work, "rev-parse", "--verify", "-q", "refs/leak-scan/published-main"], { encoding: "utf-8" });
    expect(ref.status, "the published main was fetched (the comparison used it)").toBe(0);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("the twin: the copy's directory absent locally AND absent from the published main → DRIFT (exit 2)", () => {
    const p = privateCopyWithRepo();
    const other = path.join(p.dir, "other");
    p.git(p.dir, "clone", "-q", p.bare, other);
    p.git(other, "rm", "-rq", "tools");
    p.git(other, "commit", "-q", "-m", "unpublish the copy");
    p.git(other, "push", "-q", "origin", "HEAD:main");
    behindWorkingTree(p);
    const r = privateSelfTest(p);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toMatch(/^DRIFT: fixture-repo$/m);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  /** The private self-test, ASYNC (a fixture server in this process keeps answering while it runs). */
  const privateSelfTestAsync = (p: { dir: string; list: string }, env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn(process.execPath, [path.join(p.dir, "scan.mjs"), "--self-test", "--list", p.list], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      c.stdout.on("data", (d: Buffer) => (out += d));
      c.stderr.on("data", (d: Buffer) => (err += d));
      c.on("close", (status) => resolve({ status, stdout: out, stderr: err }));
    });

  it.skipIf(process.platform === "win32")("git's environment is an ALLOWLIST: an inherited GIT_ASKPASS is never invoked, even by a remote that asks for credentials", async () => {
    const p = privateCopyWithRepo();
    const srv = http.createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const work = path.dirname(path.dirname(path.dirname(p.copy)));
    p.git(work, "remote", "set-url", "origin", `http://127.0.0.1:${(srv.address() as { port: number }).port}/x.git`);
    const marker = path.join(p.dir, "askpass-called");
    const askpass = path.join(p.dir, "askpass.sh");
    fs.writeFileSync(askpass, `#!/bin/sh\necho called >> ${JSON.stringify(marker)}\necho fixture-secret\n`, { mode: 0o755 });
    const r = await privateSelfTestAsync(p, { PATH: process.env.PATH ?? "", GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, LEAK_SCAN_GIT_TIMEOUT_MS: "10000" });
    srv.close();
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(fs.existsSync(marker), "the inherited askpass helper must never run").toBe(false);
    fs.rmSync(p.dir, { recursive: true, force: true });
  }, 30_000);

  it.skipIf(process.platform === "win32")("a stub ssh that hangs past the fetch timeout leaves NO survivor: git's whole process group is killed (asserted by pid)", async () => {
    const p = privateCopyWithRepo();
    p.git(path.dirname(path.dirname(path.dirname(p.copy))), "remote", "set-url", "origin", "ssh://stub-host/x.git");
    const stubDir = path.join(p.dir, "stub-bin");
    fs.mkdirSync(stubDir);
    const pidFile = path.join(p.dir, "ssh.pid");
    fs.writeFileSync(path.join(stubDir, "ssh"), `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 30\n`, { mode: 0o755 });
    const t0 = Date.now();
    const r = await privateSelfTestAsync(p, { PATH: `${stubDir}:${process.env.PATH ?? ""}`, LEAK_SCAN_GIT_TIMEOUT_MS: "1500" });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    // Bounded by the fetch timeout (1.5 s here), not by the stub's own 30 s sleep (which would end it unaided).
    expect(Date.now() - t0, "the fetch is killed at its timeout").toBeLessThan(15_000);
    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(pid, "the stub ssh ran").toBeGreaterThan(1);
    await new Promise((res) => setTimeout(res, 300));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, "SIGKILL"); // never leave it behind, even when the row fails
    expect(alive, `the stub ssh ${pid} must not survive the group kill`).toBe(false);
    fs.rmSync(p.dir, { recursive: true, force: true });
  }, 60_000);

  it("a FETCH that fails → cannot evaluate (exit 2), never a pass", () => {
    const p = privateCopyWithRepo();
    p.git(path.dirname(path.dirname(path.dirname(p.copy))), "remote", "set-url", "origin", path.join(p.dir, "gone.git"));
    const r = privateSelfTest(p);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/cannot evaluate \(a copy's published branch could not be fetched\)/);
    expect(r.stdout).not.toMatch(/PASS/);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("names no private location: no home path, no list location, no workspace path", () => {
    for (const f of [SCAN, path.join(REPO, "tools", "public-leak-scan", "README.md"), path.join(REPO, ".github", "workflows", "public-leak-gate.yml")]) {
      const text = fs.readFileSync(f, "utf-8");
      expect(text, f).not.toMatch(/\/Users\/|\.config\/|denylist\.txt|LLMs/);
    }
  });
});

/** A workflow step's run block, executed with bash. */
function stepScript(name: string): string {
  const m = new RegExp(`- name: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?\\n {8}run: \\|\\n([\\s\\S]*?)(?:\\n {6}- name:|\\s*$)`).exec(WF);
  expect(m, `the step "${name}" exists`).not.toBeNull();
  return m![1]!.split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}

describe("the metadata fetch step, run for real against a stub gh (the event's snapshot, complete, or fail closed)", () => {
  const BASE = "b".repeat(40);
  const HEAD = "c".repeat(40);
  const sha = (i: number) => i.toString(16).padStart(40, "0");
  /** A stub `gh` serving a pull JSON and ONE compare JSON; the event file names BASE...HEAD and the branch. */
  function runFetch(opts: { total: unknown; listed: number; lastIsHead?: boolean; eventHead?: string }): { status: number | null; out: string; meta: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-gh-"));
    const commits = Array.from({ length: opts.listed }, (_, i) => ({ sha: i === opts.listed - 1 && opts.lastIsHead !== false ? HEAD : sha(i + 1), commit: { message: `fix: message ${i}` } }));
    fs.writeFileSync(path.join(dir, "compare.json"), JSON.stringify({ total_commits: opts.total, commits }));
    fs.writeFileSync(path.join(dir, "pull.json"), JSON.stringify({ title: "a title", body: null, head: { sha: HEAD } }));
    fs.writeFileSync(path.join(dir, "event.json"), JSON.stringify({ pull_request: { base: { sha: BASE }, head: { sha: opts.eventHead ?? HEAD, ref: "feat/a-branch" } } }));
    fs.writeFileSync(
      path.join(dir, "gh"),
      `#!/bin/sh\ncase "$2" in\n  "repos/o/r/compare/${BASE}...${HEAD}") cat "${dir}/compare.json" ;;\n  "repos/o/r/pulls/7") cat "${dir}/pull.json" ;;\n  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-meta-"));
    const r = spawnSync("bash", ["-e", "-c", stepScript("Fetch the pull request metadata through the API (no code)")], {
      encoding: "utf-8",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, RUNNER_TEMP: tmp, GITHUB_EVENT_PATH: path.join(dir, "event.json"), PR_NUMBER: "7", REPO: "o/r", GH_TOKEN: "x" },
    });
    return { status: r.status, out: r.stdout + r.stderr, meta: path.join(tmp, "leak-meta") };
  }
  it("complete (3 of 3, ending at the event's head) → exit 0; the files carry the title, the event's branch and every message", () => {
    const r = runFetch({ total: 3, listed: 3 });
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(path.join(r.meta, "pr-title"), "utf-8")).toBe("a title\n");
    expect(fs.readFileSync(path.join(r.meta, "pr-body"), "utf-8")).toBe("\n");
    expect(fs.readFileSync(path.join(r.meta, "branch"), "utf-8")).toBe("feat/a-branch\n");
    expect(fs.readFileSync(path.join(r.meta, "commit-msg"), "utf-8")).toBe("fix: message 0\nfix: message 1\nfix: message 2\n");
  });
  it("exactly 250 passes the guard", () => {
    const r = runFetch({ total: 250, listed: 250 });
    expect(r.status, r.out).toBe(0);
  });
  it("251 fails closed (one compare response lists at most 250)", () => {
    const r = runFetch({ total: 251, listed: 250 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("more than 250 commits");
  });
  it("TRUNCATED (3 reported, 2 listed) → exit 1, 'commit list truncated: failing closed'", () => {
    const r = runFetch({ total: 3, listed: 2 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("commit list truncated: failing closed");
  });
  it("ZERO commits → exit 1 for THAT reason (an empty listing never scans clean)", () => {
    const r = runFetch({ total: 0, listed: 0 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("the pull request has no commits: failing closed");
  });
  it("an unreadable commit count → exit 1", () => {
    expect(runFetch({ total: null, listed: 1 }).status).toBe(1);
  });
  it("THE SNAPSHOT: the listed commits not ending at the event's head → exit 1, failing closed", () => {
    const r = runFetch({ total: 3, listed: 3, lastIsHead: false });
    expect(r.status).toBe(1);
    expect(r.out).toContain("do not end at the event's head");
  });
  it("the API cannot serve the event's base...head (the compare call fails) → exit 1, never a pass", () => {
    const r = runFetch({ total: 3, listed: 3, eventHead: "d".repeat(40) });
    expect(r.status).toBe(1);
  });
  it("an unreadable event sha → exit 1", () => {
    expect(runFetch({ total: 3, listed: 3, eventHead: "not-a-sha" }).status).toBe(1);
  });
});

describe("the scan step honours the scanner's caller contract (PASS = exit 0 AND exactly 'PASS')", () => {
  it("a term in the TITLE and in the BRANCH name → FAIL lines for both fields", () => {
    const r = runScanStep({ "pr-title": "zorblax approved", branch: "fix/zorblax" }, { PUBLIC_DENYLIST: LIST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL field=pr-title terms=#2");
    expect(r.out).toContain("FAIL field=branch terms=#2");
  });

  /** The Scan step with a SUBSTITUTE scanner (in a temp tree): exit code + output chosen by the row. */
  function withScanner(body: string | null): { status: number | null; out: string } {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-tree-"));
    fs.mkdirSync(path.join(tree, "tools", "public-leak-scan"), { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(tree, "tools", "public-leak-scan", "scan.mjs"), body); // null: NO scanner at the base
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-"));
    fs.mkdirSync(path.join(tmp, "leak-meta"));
    for (const k of ["pr-title", "pr-body", "branch", "commit-msg"]) fs.writeFileSync(path.join(tmp, "leak-meta", k), "clean");
    const r = spawnSync("bash", ["-e", "-c", stepScript("Scan (prints field and term indexes only)")], { cwd: tree, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: tmp, PUBLIC_DENYLIST: LIST } });
    return { status: r.status, out: r.stdout + r.stderr };
  }
  it("a scanner that exits 0 with OTHER output → 'could not run' (exit 1), never a pass", () => {
    const r = withScanner('process.stdout.write("OK\\n");\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
  it("a scanner CRASH (an uncaught exception: exit 1 without a FAIL line) → 'could not run', never read as a term", () => {
    const r = withScanner('throw new Error("boom");\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
    expect(r.out, "never the irreversible-task text for a non-hit").not.toContain("tell the maintainer");
  });
  it("NO scanner at the base (node MODULE_NOT_FOUND, exit 1) → 'could not run', never a term and never the maintainer task", () => {
    const r = withScanner(null);
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
    expect(r.out).not.toContain("tell the maintainer");
  });
  it("exit 1 with MIXED output ('PASS' then a FAIL line) → 'could not run'", () => {
    const r = withScanner('const f = process.argv[process.argv.indexOf("--field") + 1]; process.stdout.write(`PASS\\nFAIL field=${f} terms=#2\\n`); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
  });
  it("exit 1 with 'FAIL … terms=#garbage' → 'could not run'", () => {
    const r = withScanner('const f = process.argv[process.argv.indexOf("--field") + 1]; process.stdout.write(`FAIL field=${f} terms=#garbage\\n`); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
  it("exit 1 with a FAIL line for ANOTHER field → 'could not run'", () => {
    const r = withScanner('process.stdout.write("FAIL field=release-notes terms=#2\\n"); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
  });
  it("exit 0 with 'PASS' and an EXTRA newline → 'could not run' (the verdict is read from the bytes, not through $(...))", () => {
    const r = withScanner('process.stdout.write("PASS\\n\\n");\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
  it("the CONTROL: a substitute that prints exactly one valid FAIL line for its field, exit 1 → a HIT (the maintainer text)", () => {
    const r = withScanner('const f = process.argv[process.argv.indexOf("--field") + 1]; process.stdout.write(`FAIL field=${f} terms=#1,#2\\n`); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("A denylisted term");
    expect(r.out).not.toContain("could not run");
  });
  it("the CONTROL: a substitute that prints exactly 'PASS\\n', exit 0 → a pass", () => {
    const r = withScanner('process.stdout.write("PASS\\n");\n');
    expect(r.status, r.out).toBe(0);
  });
  it("a scanner exiting 3 → 'could not run'", () => {
    const r = withScanner("process.exit(3);\n");
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
});

