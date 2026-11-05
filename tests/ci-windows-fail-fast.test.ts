// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A CI step on a Windows runner must FAIL when any of its commands fails. GitHub runs a Windows step's `run:` with
 * pwsh by default, and pwsh reports only the step's LAST command's exit code: a red first command under a green second
 * one passed the step (MEASURED: 10 failed tests under a passing step). So a Windows-capable job's `run:` holds ONE
 * command, unless the step (or its job, or the workflow) fails fast: `shell: bash` (GitHub runs it `-eo pipefail`),
 * or a pwsh script that first sets `$ErrorActionPreference = 'Stop'` AND `$PSNativeCommandUseErrorActionPreference =
 * $true` (pwsh 7.3+: a failing native command then stops the script).
 *
 * The workflows are PARSED (a small YAML subset: block mappings, sequences, block scalars, flow lists), not grepped:
 * a step is judged by its job's runner (runs-on, or a matrix of OSes), its `shell:` (step, job defaults, workflow
 * defaults), and its commands (lines of a literal block, and `;`-separated commands outside quotes). The rule is also
 * run on forms that are NOT in the repo (the "absent forms" below), each with its twin.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(REPO, ".github", "workflows");

type Y = string | Y[] | { [k: string]: Y } | null;

/** Strip a trailing ` # comment` outside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/** A flow-style collection the subset does not parse: kept as a marker, so the guard REFUSES what it cannot judge. */
const FLOW = "\u0000flow:";
function scalar(v: string): Y {
  const t = v.trim();
  if (t.startsWith("[") && t.endsWith("]") && !/[{[]/.test(t.slice(1, -1))) {
    return t
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  if (t.startsWith("[") || t.startsWith("{")) return FLOW + t;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    // A double-quoted scalar's escapes (YAML 1.2): an escaped newline IS a second line of the script.
    return t.slice(1, -1).replace(/\\(["\\\/bfnrt0])/g, (_m, c: string) => ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0", "/": "/", '"': '"', "\\": "\\" })[c] ?? c);
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

interface Line {
  indent: number;
  text: string;
}

/** Parse the YAML subset GitHub workflows here use. */
export function parseYaml(src: string): Y {
  const lines: Line[] = src.split(/\r?\n/).map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trimStart() }));
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && (lines[i]!.text === "" || lines[i]!.text.startsWith("#"))) i++;
  };
  function blockScalar(parentIndent: number, folded: boolean): string {
    const out: string[] = [];
    let ind = -1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.text !== "" && l.indent <= parentIndent) break;
      if (l.text !== "" && ind < 0) ind = l.indent;
      out.push(l.text === "" ? "" : " ".repeat(Math.max(0, l.indent - ind)) + l.text);
      i++;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return folded ? out.join(" ") : out.join("\n");
  }
  function value(rest: string, indent: number): Y {
    const r = stripComment(rest);
    if (/^[|>][-+]?$/.test(r)) return blockScalar(indent, r.startsWith(">"));
    if (r !== "") return scalar(r);
    skipBlank();
    if (i < lines.length && lines[i]!.indent > indent) return node(lines[i]!.indent);
    if (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith("- ")) return node(indent);
    return null;
  }
  function mappingEntry(obj: { [k: string]: Y }, text: string, indent: number): void {
    const m = /^((?:"[^"]*"|'[^']*'|[^:])+):(?:\s+(.*))?$/.exec(text);
    if (!m) throw new Error(`unparsed line: ${text}`);
    const key = m[1]!.trim().replace(/^['"]|['"]$/g, "");
    obj[key] = value(m[2] ?? "", indent);
  }
  function node(indent: number): Y {
    skipBlank();
    if (i >= lines.length) return null;
    if (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-") {
      const arr: Y[] = [];
      while (true) {
        skipBlank();
        if (i >= lines.length || lines[i]!.indent !== indent || !(lines[i]!.text.startsWith("- ") || lines[i]!.text === "-")) break;
        const after = lines[i]!.text === "-" ? "" : lines[i]!.text.slice(2);
        const itemIndent = indent + 2;
        i++;
        if (/^((?:"[^"]*"|'[^']*'|[^:\s][^:]*)):(\s|$)/.test(after)) {
          const obj: { [k: string]: Y } = {};
          mappingEntry(obj, after, itemIndent);
          while (true) {
            skipBlank();
            if (i >= lines.length || lines[i]!.indent !== itemIndent || lines[i]!.text.startsWith("- ")) break;
            const t = lines[i]!.text;
            i++;
            mappingEntry(obj, t, itemIndent);
          }
          arr.push(obj);
        } else if (after.trim() === "") {
          arr.push(value("", indent));
        } else arr.push(scalar(stripComment(after)));
      }
      return arr;
    }
    const obj: { [k: string]: Y } = {};
    while (true) {
      skipBlank();
      if (i >= lines.length || lines[i]!.indent !== indent || lines[i]!.text.startsWith("- ")) break;
      const t = lines[i]!.text;
      i++;
      mappingEntry(obj, t, indent);
    }
    return obj;
  }
  return node(0);
}

const asObj = (y: Y | undefined): { [k: string]: Y } => (y && typeof y === "object" && !Array.isArray(y) ? y : {});
const asStr = (y: Y | undefined): string => (typeof y === "string" ? y : "");

/** The commands of a run script: its non-blank, non-comment lines (a trailing ` continues one), split on `;` outside quotes. */
export function commandsOf(script: string): string[] {
  const joined: string[] = [];
  let cur = "";
  for (const raw of script.split("\n")) {
    const l = raw.trim();
    if (l === "" || l.startsWith("#")) continue;
    if (l.endsWith("`")) {
      cur += l.slice(0, -1) + " ";
      continue;
    }
    joined.push(cur + l);
    cur = "";
  }
  if (cur.trim()) joined.push(cur.trim());
  const out: string[] = [];
  for (const line of joined) {
    let q: string | null = null;
    let part = "";
    for (const c of line) {
      if (q) {
        if (c === q) q = null;
        part += c;
      } else if (c === "'" || c === '"') {
        q = c;
        part += c;
      } else if (c === ";") {
        if (part.trim()) out.push(part.trim());
        part = "";
      } else part += c;
    }
    if (part.trim()) out.push(part.trim());
  }
  return out;
}

const PWSH_FAIL_FAST = [/^\$ErrorActionPreference\s*=\s*['"]Stop['"]$/i, /^\$PSNativeCommandUseErrorActionPreference\s*=\s*\$true$/i];

/** GitHub's own bash runs `bash --noprofile --norc -eo pipefail {0}`; a custom bash fails fast only with an -e flag. */
function bashFailsFast(shell: string): boolean {
  const tokens = shell.trim().split(/\s+/);
  if (tokens[0] !== "bash") return false;
  return tokens.length === 1 || tokens.slice(1).some((t) => /^-[a-zA-Z]*e[a-zA-Z]*$/.test(t));
}

/** The Windows-capable steps whose run can pass with a failed command, as "<job> / <step>: why". */
export function maskedWindowsSteps(src: string): string[] {
  const out: string[] = [];
  // Anchors, aliases and merge keys are outside the subset: refuse, never guess.
  src.split(/\r?\n/).forEach((l, n) => {
    if (/^\s*<<\s*:|:\s+[&*][\w-]+|^\s*-\s+[&*][\w-]+/.test(l)) out.push(`line ${n + 1}: unsupported YAML (an anchor, alias or merge key): judge it by hand or simplify it`);
  });
  const wf = asObj(parseYaml(src));
  const wfShell = asStr(asObj(asObj(wf.defaults).run).shell);
  for (const [jobName, jobY] of Object.entries(asObj(wf.jobs))) {
    const job = asObj(jobY);
    const runsOn = job["runs-on"];
    const oses: string[] = [];
    let unresolved = false;
    if (typeof runsOn === "string" && /\$\{\{\s*matrix\.(\w+)\s*\}\}/.test(runsOn)) {
      const key = /matrix\.(\w+)/.exec(runsOn)![1]!;
      const v = asObj(asObj(job.strategy).matrix)[key];
      if (Array.isArray(v)) for (const x of v) oses.push(asStr(x));
      else unresolved = true;
      for (const inc of (asObj(asObj(job.strategy).matrix).include as Y[] | undefined) ?? []) oses.push(asStr(asObj(inc)[key]));
    } else if (Array.isArray(runsOn)) for (const x of runsOn) oses.push(asStr(x));
    else if (runsOn && typeof runsOn === "object") {
      const labels = (runsOn as { [k: string]: Y }).labels;
      if (Array.isArray(labels)) for (const x of labels) oses.push(asStr(x));
      else if (typeof labels === "string") oses.push(labels);
      else unresolved = true; // a runner group alone: its OS is not in the workflow
    } else if (typeof runsOn === "string") {
      if (runsOn.startsWith(FLOW) || /\$\{\{/.test(runsOn)) unresolved = true;
      else oses.push(runsOn);
    } else unresolved = true;
    // Unresolvable: judged as Windows-capable (fail closed).
    if (!unresolved && !oses.some((o) => /windows/i.test(o))) continue;
    if (!Array.isArray(job.steps)) {
      out.push(`${jobName}: its steps are not a block sequence (flow style or another form the subset does not parse): unjudgeable, refused`);
      continue;
    }
    const jobShell = asStr(asObj(asObj(job.defaults).run).shell);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((stepY, idx) => {
      if (!stepY || typeof stepY !== "object" || Array.isArray(stepY)) {
        out.push(`${jobName} / step ${idx + 1}: not a block mapping (flow style?): unjudgeable, refused`);
        return;
      }
      const step = asObj(stepY);
      const run = step.run;
      if (typeof run !== "string") return;
      if (run.startsWith(FLOW)) {
        out.push(`${jobName} / ${asStr(step.name) || `step ${idx + 1}`}: a flow-style run: unjudgeable, refused`);
        return;
      }
      const shell = asStr(step.shell) || jobShell || wfShell || "pwsh";
      if (bashFailsFast(shell)) return;
      const cmds = commandsOf(run);
      if (cmds.length <= 1) return;
      if (/^(pwsh|powershell)\b/.test(shell) && PWSH_FAIL_FAST.every((re) => cmds.slice(0, 2).some((c) => re.test(c)))) return;
      out.push(`${jobName} / ${asStr(step.name) || `step ${idx + 1}`}: ${cmds.length} commands under ${shell}, only the last one's exit code decides`);
    });
  }
  return out;
}

const wrap = (runsOn: string, step: string, jobExtra = "", wfExtra = "") =>
  `name: t\n${wfExtra}on: push\njobs:\n  j:\n    runs-on: ${runsOn}\n${jobExtra}    steps:\n      - uses: actions/checkout@v4\n${step}`;
const TWO = "      - name: two\n        run: |\n          npx vitest run a\n          npx vitest run b\n";

describe("CI: a Windows step fails when any of its commands fails (pwsh reports only the last exit code)", () => {
  it("every workflow in the repo: no Windows-capable step can pass with a failed command", () => {
    const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length, "precondition: the workflows were found").toBeGreaterThan(0);
    const found = files.flatMap((f) => maskedWindowsSteps(fs.readFileSync(path.join(WORKFLOWS, f), "utf8")).map((m) => `${f}: ${m}`));
    expect(found).toEqual([]);
  });

  it("precondition: the parser reaches the repo's Windows steps (it judges more than nothing)", () => {
    const wf = asObj(parseYaml(fs.readFileSync(path.join(WORKFLOWS, "ci.yml"), "utf8")));
    const win = Object.values(asObj(wf.jobs)).filter((j) => /windows/.test(asStr(asObj(j)["runs-on"])));
    expect(win.length).toBeGreaterThan(0);
    const runs = win.flatMap((j) => ((asObj(j).steps as Y[]) ?? []).map((s) => asObj(s).run).filter((r) => typeof r === "string"));
    expect(runs.length, "Windows run steps parsed").toBeGreaterThan(2);
  });

  it.each([
    ["the MEASURED masked shape: two commands in one windows-2022 step", wrap("windows-2022", TWO), 1],
    ["twin: the same on Linux (bash -e)", wrap("ubuntu-latest", TWO), 0],
    ["twin: the same with `shell: bash` on the step", wrap("windows-2022", TWO.replace("        run: |", "        shell: bash\n        run: |")), 0],
    ["twin: the same with a job default shell bash", wrap("windows-2022", TWO, "    defaults:\n      run:\n        shell: bash\n"), 0],
    ["twin: the same with a workflow default shell bash", wrap("windows-2022", TWO, "", "defaults:\n  run:\n    shell: bash\n"), 0],
    ["twin: pwsh that fails fast first", wrap("windows-2022", "      - name: ff\n        run: |\n          $ErrorActionPreference = 'Stop'\n          $PSNativeCommandUseErrorActionPreference = $true\n          npx a\n          npx b\n"), 0],
    ["only HALF the pwsh fail-fast preamble", wrap("windows-2022", "      - name: half\n        run: |\n          $ErrorActionPreference = 'Stop'\n          npx a\n          npx b\n"), 1],
    ["a matrix that includes Windows", wrap("${{ matrix.os }}", TWO, "    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n"), 1],
    ["twin: a matrix without Windows", wrap("${{ matrix.os }}", TWO, "    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n"), 0],
    ["two commands on ONE line with `;`", wrap("windows-2022", "      - name: semi\n        run: npx a; npx b\n"), 1],
    ["twin: a `;` inside quotes is one command", wrap("windows-2022", "      - name: q\n        run: node -e \"a(); b()\"\n"), 0],
    ["twin: one command continued with a backtick, plus comments", wrap("windows-2022", "      - name: cont\n        run: |\n          # a comment\n          npx vitest run `\n            tests/a.test.ts\n"), 0],
    ["shell: cmd with two commands", wrap("windows-2022", TWO.replace("        run: |", "        shell: cmd\n        run: |")), 1],
    // Codex #385 R2: forms the first parser passed as green.
    ["FLOW-style steps", "name: t\non: push\njobs:\n  j:\n    runs-on: windows-2022\n    steps: [{run: \"npx fail; npx pass\"}]\n", 1],
    ["a runs-on MAPPING with labels", "name: t\non: push\njobs:\n  j:\n    runs-on:\n      labels: [windows-2022]\n    steps:\n" + TWO, 1],
    ["a DOUBLE-QUOTED script with an escaped newline", wrap("windows-2022", "      - name: dq\n        run: \"npx a\\nnpx b\"\n"), 1],
    ["a CUSTOM bash invocation without -e (`bash {0}`)", wrap("windows-2022", TWO.replace("        run: |", "        shell: bash {0}\n        run: |")), 1],
  ])("absent form: %s", (_label, src, expected) => {
    expect(maskedWindowsSteps(src)).toHaveLength(expected);
  });
});
