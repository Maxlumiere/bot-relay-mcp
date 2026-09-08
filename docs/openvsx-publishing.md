# Publishing the Tether extension to Open VSX

> Maintainer doc — not shipped in the npm package. It captures the one-time setup and the per-release step needed to make the Tether VS Code extension installable in **Cursor, VSCodium, Gitpod, Windsurf** and other VS Code forks, which use [Open VSX](https://open-vsx.org) as their default extension registry (the Microsoft Marketplace restricts installs to Microsoft products). Today the extension ships only to the VS Code Marketplace, so those editors cannot install it.

## Why this matters

The README pitches a heterogeneous stack (Claude Code, Cursor, Cline, Zed, …) — that heterogeneity is the differentiator versus a Claude-only tool. But the headline **autowake** feature is delivered by the Tether extension, and a Marketplace-only extension is not installable in the forks the README names. Publishing to Open VSX makes that claim true rather than narrowing it. Verified 2026-09-08: Cursor (since June 2025) and VSCodium use Open VSX as their default registry.

## One-time setup (identity + legal — the publisher's hands only)

Verify against the current [Open VSX publishing wiki](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions) before running — the steps below were accurate 2026-09-08.

1. **Eclipse Foundation account** at [accounts.eclipse.org](https://accounts.eclipse.org), registered with the **exact GitHub username** that owns this repo (currently `Maxlumiere`).
2. **Sign the Eclipse Publisher Agreement** on the open-vsx.org profile page (Show Publisher Agreement → read → Agree). This is a legal agreement in the publisher's name — it is the real gate, not a config step.
3. **Generate an Open VSX access token** (open-vsx.org → avatar → Settings → Access Tokens; shown once — store it, e.g. `export OVSX_PAT=…`).
4. **Claim the namespace once:** `npx --yes ovsx create-namespace lumiere-ventures -p "$OVSX_PAT"`. The extension's `package.json` `publisher` is already `lumiere-ventures`, so it matches. Until ownership is verified, the listing shows an "unverified publisher" badge — that is expected.

## Per-release publish

The same vsce-packaged `.vsix` is published to both registries — it is **one artefact, two publish targets**, not two builds. From `extensions/vscode/`:

```sh
vsce publish                       # → VS Code Marketplace (existing)
npx --yes ovsx publish -p "$OVSX_PAT"   # → Open VSX (new)
```

### Prepared release script (add when the setup above exists)

To make the two targets impossible to run separately, add to `extensions/vscode/package.json` `scripts` (do NOT add it before the namespace exists — a command that cannot work should not sit in the tree):

```json
"publish:all": "vsce publish && npx --yes ovsx publish"
```

Then one command, `npm run publish:all`, publishes the current `package.json` version to both registries.

## The drift cost — name it, don't discover it later

Two publish targets that must both be remembered **will** diverge. This already happened: as of 2026-09-08 the Marketplace is at `0.6.0`, the repo is at `0.7.0` (unpublished), and Open VSX has nothing. The combined `publish:all` script is the fix — both targets publish the same version, so they cannot drift.
