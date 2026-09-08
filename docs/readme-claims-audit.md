# README claims audit — checklist

> Maintainer doc — not shipped in the npm package. The README makes support claims (editors, CLIs, platforms, versions, counts) that drift out of true **without anyone editing the file** — a dependency ships, a fork changes registries, a tool is added. Re-run this checklist before a release, or whenever the surface changes. Snapshot: 2026-09-08.

## The recurring defect this guards against

Two shapes keep recurring, both are *true statements that mislead*:

- **A number that is a claim about now** (tool count) goes stale by itself. A number that is a **record of a moment** (a changelog per-version count) must never change. Same digits, opposite obligations — do not sweep them together.
- **A one-sided oracle:** the absence of a config example *in our repo* is not evidence a client doesn't work. Verify support **externally** (the vendor's docs), the way we verified Open VSX and Zed — never by grepping our own tree.

## Checklist

| Claim | Claimed in README | Status | Re-check by |
|---|---|---|---|
| **Tool count** | product-description claims are count-free ("dozens", "the full toolset"); version-history keeps exact per-version numbers | ✅ de-staled (#255). Actual count = keys in `tests/fixtures/tool-inputschemas.golden.json` (38 as of 2026-09-08) | `node -e "console.log(Object.keys(require('./tests/fixtures/tool-inputschemas.golden.json')).length)"` |
| **Claude Code** | supported MCP client (primary) | ✅ demonstrable | primary target |
| **Cursor** | supported MCP client | ✅ demonstrable (ships MCP; `~/.cursor/mcp.json`). Was in BOTH "supported" and "don't list yet" — contradiction fixed #255 | cursor.com/help/customization/extensions |
| **Zed** | supported MCP client | ✅ demonstrable — Zed supports MCP ("context servers", **stdio only, not HTTP** as of early 2026). Our stdio path works. Removed from "don't list yet" #255 | ⚠ **re-check zed.dev/docs/ai/mcp — this claim depends on Zed's roadmap; if we ever rely on HTTP MCP it does not hold today** |
| **Cline** | supported MCP client | ⬜ listed by name; not independently demonstrated here | verify Cline↔relay before relying on it |
| **Copilot** | genuinely NOT listed (in the "don't list yet" line) | ✅ honest asymmetry — the one unlisted client; a Copilot wake-driver is unbuilt | — |
| **Platforms** | macOS full (launchd); Linux/Windows daemon "not yet supervised, start manually" | ✅ honestly hedged, not overclaimed | `docs/cross-platform-spawn.md` |
| **Node** | 22+ | ✅ matches `engines >=22` + the runtime guard (`MIN_NODE_MAJOR = 22`) since #252 | `src/node-version.ts` + `package.json` engines |
| **Tether extension install** | VS Code Marketplace | ⚠ Marketplace-only → Cursor/VSCodium/forks (which use Open VSX) **cannot install it**. See `docs/openvsx-publishing.md` | Marketplace vs Open VSX listing |

## Published-vs-repo caveat

The README describes the repo (`main`). What a user `npm install`s is the last **published** version. When those diverge (e.g. main = 38 tools while npm = 37; extension repo = 0.7.0 while Marketplace = 0.6.0), a claim can be true for the repo and false for the artefact a stranger actually runs. Verify user-facing counts against the *published* artefact, not just the tree, before a release.
