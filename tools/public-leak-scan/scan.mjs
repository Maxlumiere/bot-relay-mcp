#!/usr/bin/env node
// public-leak-scan: a denylist scanner for text about to be published. It prints a field and term INDEXES only:
// never a term, never the scanned text, never a path (its output can land in a public CI log). The list is supplied by
// the caller (--list FILE or --list-env VAR); this file holds no term. Byte-identical copies are written by a sync
// script from one canonical copy: never edit a copy by hand.
//
// The SELF-TEST (and its DRIFT labels, printed verbatim) is for the private canonical copy: never run it in a public context.
// CALLERS: treat EVERY outcome except a scan-mode exit 0 with the output "PASS" as a refusal (exit 1, exit 2, a
// signal, a timeout, a spawn failure, any other output).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built-in canary (a nonsense string): every list must carry it, and the self-test must see it go RED. Built at
 * run time and NEVER written contiguously here: this file is synced into public repos, whose added lines are scanned
 * with a list that carries the canary (the quotes and commas keep normalisation from rejoining it).
 */
export const CANARY = ["zq", "canary", "7f3e9a1d"].join("-");
/** Optional, beside this file: "<label><TAB><path>" lines naming copies whose bytes must equal this file's (the private
 * canonical copy's DRIFT check; a public copy has none). */
const COPIES_FILE = "copies.tsv";
/**
 * Beside a --list FILE: line 1 = the SHA-256 of the list as flattened when the CI secret was set. A FILE list is private
 * by definition (the CI form is --list-env), so a --self-test with a FILE list ALWAYS checks it: privacy is decided by
 * how the list arrives, never by a file that could silently disappear.
 */
const SECRET_HASH_FILE = "public-denylist.secret.sha256";
/** The field labels a caller may pass: a CLOSED set, so a label can never carry derived (leaking) text. */
export const FIELDS = new Set([
  "pr-title", "pr-body", "pr-comment", "pr-review", "commit-msg", "branch", "added-lines", "issue-title", "issue-body",
  "issue-comment", "release-notes", "tag-msg", "package-file", "api-body", "repo-meta",
]);
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_INCLUDE_DEPTH = 8;

class CannotEvaluate extends Error {}

/** Strict UTF-8 (invalid bytes are refused, never replaced and passed). */
function decodeStrict(buf, what) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new CannotEvaluate(`${what} is not valid UTF-8`);
  }
}

/** Characters deleted in form B and turned into a space in form A: format/zero-width (\p{Cf}) and emphasis marks. */
const DELETABLE = /[\p{Cf}*_~`]/gu;
const PCT_ROUNDS = 4;

/** NFKC → upper → lower → NFKC (full folding: ß → ss, a final sigma ς → σ), identical for terms and text. */
const fold = (s) => s.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");

/** Percent-decode to a FIXED POINT, bounded: text still changing after PCT_ROUNDS rounds is refused (exit 2). */
function pctDecode(s) {
  let t = s;
  for (let i = 0; i <= PCT_ROUNDS; i++) {
    const next = t.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
    if (next === t) return t;
    if (i === PCT_ROUNDS) break;
    t = next;
  }
  throw new CannotEvaluate("percent-encoding nests beyond the bound");
}

/**
 * The ONE normalisation, in this ORDER, applied to the scanned text AND to every term:
 *   (1) percent-decode to a fixed point (≤ 4 rounds, else exit 2); (2) backslashes → slashes, NFKC, full fold;
 *   (3) TWO forms: A = every deletable character (\p{Cf}: zero-width, joiners, soft hyphen; and * _ ~ `) becomes a
 *   SPACE, B = it is DELETED; whitespace runs → one space in both. A term matches if it matches EITHER form.
 * OUT OF SCOPE (stated): homoglyphs across scripts, Turkish dotless ı, leetspeak. ACCEPTED over-match: a_b may match ab.
 */
export function normalizeForms(s) {
  const t = fold(pctDecode(s).replace(/\\/g, "/"));
  const ws = (x) => x.replace(/\s+/gu, " ");
  return { a: ws(t.replace(DELETABLE, " ")), b: ws(t.replace(DELETABLE, "")) };
}
/** A term's canonical form (B: deletables removed), for loading checks and matching. */
export const normalizeTerm = (s) => normalizeForms(s).b.trim();

function readListFile(p, what) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    throw new CannotEvaluate(`${what} is missing or unreadable`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new CannotEvaluate(`${what} is not a regular file`);
  if (st.size > MAX_LIST_BYTES) throw new CannotEvaluate(`${what} is too large`);
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    throw new CannotEvaluate(`${what} is missing or unreadable`);
  }
  return decodeStrict(buf, what);
}

/** Expand a list's text into terms (in order; @include spliced in place). Every fault is CannotEvaluate. */
export function parseList(text, baseDir, seen = new Set(), depth = 0) {
  if (depth > MAX_INCLUDE_DEPTH) throw new CannotEvaluate("includes nest too deeply");
  const terms = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const inc = /^@include\s+(.+)$/.exec(line);
    if (inc) {
      if (baseDir === null) throw new CannotEvaluate("an include cannot be resolved from an environment list");
      const spec = inc[1].trim();
      const target = spec.startsWith("~/") ? path.join(os.homedir(), spec.slice(2)) : path.resolve(baseDir, spec);
      const sub = readListFile(target, "an included list");
      const real = fs.realpathSync(target);
      if (seen.has(real)) throw new CannotEvaluate("an include cycle");
      terms.push(...parseList(sub, path.dirname(real), new Set([...seen, real]), depth + 1));
      continue;
    }
    terms.push(line);
  }
  return terms;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The 1-based indexes of the terms found in `text`, ascending, each once (both sides normalised first). */
export function findTerms(text, terms) {
  const { a, b } = normalizeForms(text);
  const hits = [];
  terms.forEach((term, i) => {
    const t = normalizeTerm(term);
    const word = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, "u");
    const found = t.includes("/")
      ? a.includes(t) || b.includes(t) // a PRIVATE PATH: a substring
      : word.test(a) || word.test(b); // WHOLE WORD, on EITHER form
    if (found) hits.push(i + 1);
  });
  return hits;
}

function loadList(args) {
  let text;
  let baseDir = null;
  if (args.list && args.listEnv) throw new CannotEvaluate("both --list and --list-env given");
  let seen = new Set();
  if (args.listEnv) {
    const v = process.env[args.listEnv];
    if (typeof v !== "string") throw new CannotEvaluate("the list is missing (the environment variable is unset)");
    text = v;
  } else {
    if (!args.list) throw new CannotEvaluate("no list given (--list FILE or --list-env VAR)");
    text = readListFile(args.list, "the list");
    const real = fs.realpathSync(args.list);
    baseDir = path.dirname(real);
    seen = new Set([real]);
  }
  const terms = parseList(text, baseDir, seen);
  if (terms.length === 0) throw new CannotEvaluate("the list is empty");
  const norm = terms.map(normalizeTerm);
  if (norm.some((t) => t === "")) throw new CannotEvaluate("a list term normalises to nothing");
  if (norm.some((t) => FIELDS.has(t))) throw new CannotEvaluate("a list term collides with a field label");
  if (!norm.includes(CANARY)) throw new CannotEvaluate("the list lacks its canary");
  return terms;
}

/**
 * PRIVATE self-test: has the list drifted from the CI secret? The list is re-flattened exactly as the secret was
 * (parseList's terms, joined by "\n", plus a final "\n") and its SHA-256 compared with line 1 of SECRET_HASH_FILE
 * beside the --list file. A missing or unreadable hash file, or an environment list (no file to sit beside), is STALE.
 * Never prints the hash, a term or a path.
 */
export function secretStale(terms, listPath) {
  if (!listPath) return true;
  let recorded;
  try {
    // The EXACT first line: only its line ending is stripped (a trailing space is a different line).
    recorded = fs.readFileSync(path.join(path.dirname(fs.realpathSync(listPath)), SECRET_HASH_FILE), "utf-8").split(/\r?\n/)[0];
  } catch {
    return true;
  }
  const now = crypto.createHash("sha256").update(`${terms.join("\n")}\n`).digest("hex");
  return recorded !== now;
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
/** The private ref the published main is fetched into (fully qualified: no ref-name ambiguity, no refspec dependence). */
const PUBLISHED_REF = "refs/leak-scan/published-main";
/**
 * The fetch's hardening: no inherited credential helper (the copies live in PUBLIC repos), no interactive ssh, no
 * submodule recursion, no tags, no FETCH_HEAD; main is fetched EXPLICITLY (a narrowed refspec or a single-branch
 * checkout cannot leave a stale origin/main standing in for it).
 */
const FETCH_ARGS = [
  "-c", "credential.helper=", "-c", "core.sshCommand=ssh -o BatchMode=yes", "-c", "protocol.ext.allow=never",
  "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", `+refs/heads/main:${PUBLISHED_REF}`,
];
/**
 * The PUBLISHED bytes of a copy that lives in a git repo: `git fetch`, then `git show origin/main:<path>` (never the
 * working tree: a local checkout may be a deploy tree, deliberately behind). Returns undefined when the copy is not
 * in a git repo (its file is read instead), null when origin/main does not hold it (drift). A fetch that fails is
 * CannotEvaluate: an unverifiable copy never passes.
 */
function publishedBytes(target) {
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) return null; // the copy's directory is absent: drift
  let root;
  try {
    root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV, timeout: 30_000 }).trim();
  } catch (err) {
    // Only a CONFIRMED non-repository is read from disk; any other discovery failure (no git, a timeout, a broken
    // repo) cannot be told apart from a stale published copy, so it cannot evaluate.
    const e = /** @type {{ status?: number; stderr?: string }} */ (err);
    if (e.status === 128 && /not a git repository/i.test(String(e.stderr ?? ""))) return undefined;
    throw new CannotEvaluate("a copy's repository could not be determined");
  }
  try {
    execFileSync("git", ["-C", root, ...FETCH_ARGS], { stdio: ["ignore", "ignore", "ignore"], env: GIT_ENV, timeout: 120_000 });
  } catch {
    throw new CannotEvaluate("a copy's published branch could not be fetched");
  }
  const rel = path.relative(fs.realpathSync(root), path.join(fs.realpathSync(dir), path.basename(target))).split(path.sep).join("/");
  try {
    return execFileSync("git", ["-C", root, "show", `${PUBLISHED_REF}:${rel}`], { stdio: ["ignore", "pipe", "ignore"], env: GIT_ENV, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null; // absent from the published main
  }
}

/** The labels of listed copies whose PUBLISHED bytes differ from this file's (absent copies count as drift). */
export function copyDrift(here = fileURLToPath(import.meta.url)) {
  let listing;
  try {
    listing = fs.readFileSync(path.join(path.dirname(here), COPIES_FILE), "utf-8");
  } catch {
    return []; // no copies file: nothing to compare (a public copy)
  }
  const mine = crypto.createHash("sha256").update(fs.readFileSync(here)).digest("hex");
  const drift = [];
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [label, p] = line.split("\t");
    if (!label || !p) continue;
    const target = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
    let theirs = null;
    const published = publishedBytes(target);
    if (published === undefined) {
      try {
        theirs = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      } catch {
        /* absent: drift */
      }
    } else if (published !== null) {
      theirs = crypto.createHash("sha256").update(published).digest("hex");
    }
    if (theirs !== mine) drift.push(label);
  }
  return drift;
}

function parseArgs(argv) {
  const a = { field: null, list: null, listEnv: null, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--field") a.field = argv[++i] ?? null;
    else if (k === "--list") a.list = argv[++i] ?? null;
    else if (k === "--list-env") a.listEnv = argv[++i] ?? null;
    else if (k === "--self-test") a.selfTest = true;
    else throw new CannotEvaluate("an unknown argument");
  }
  // EXCLUSIVE MODES: a self-test never scans, and a scan always names its field from the closed set.
  if (a.selfTest && a.field !== null) throw new CannotEvaluate("--self-test and --field are exclusive");
  if (!a.selfTest && (a.field === null || !FIELDS.has(a.field))) throw new CannotEvaluate("a missing or unknown --field label");
  return a;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const terms = loadList(args);
    if (args.selfTest) {
      if (findTerms(`a canary ${CANARY} here`, terms).length === 0) throw new CannotEvaluate("the canary did not go red");
      // PRIVATE checks: a FILE list (never CI's --list-env) checks the secret's hash; a copies file checks the copies.
      let failed = false;
      if (args.list && secretStale(terms, args.list)) {
        process.stdout.write("SECRET STALE: re-flatten and re-set PUBLIC_DENYLIST\n");
        failed = true;
      }
      const drift = copyDrift();
      for (const label of drift) process.stdout.write(`DRIFT: ${label}\n`);
      if (drift.length > 0) {
        process.stderr.write(`public-leak-scan: ${drift.length} cop${drift.length === 1 ? "y differs" : "ies differ"} from this file; re-run the sync script\n`);
        failed = true;
      }
      if (failed) return 2;
      process.stdout.write("self-test: PASS\n");
      return 0;
    }
    const buf = fs.readFileSync(0);
    if (buf.length > MAX_INPUT_BYTES) throw new CannotEvaluate("the input is too large");
    const hits = findTerms(decodeStrict(buf, "the input"), terms);
    if (hits.length === 0) {
      process.stdout.write("PASS\n");
      return 0;
    }
    process.stdout.write(`FAIL field=${args.field} terms=${hits.map((n) => `#${n}`).join(",")}\n`);
    return 1;
  } catch (err) {
    const why = err instanceof CannotEvaluate ? err.message : "an internal error";
    process.stderr.write(`public-leak-scan: cannot evaluate (${why}); refusing (exit 2)\n`);
    return 2;
  }
}

process.exitCode = main();
