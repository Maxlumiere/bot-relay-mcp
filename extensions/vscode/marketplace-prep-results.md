# Tether VSCode extension v0.1.0 — marketplace publish prep results

Generated 2026-05-07 by victra-build during the v2.6.3 await-codex-audit window. This document is the bridge between "extension code shipped in v2.5.0" and "the maintainer runs `vsce publish`".

> **Status:** READY-WITH-CAVEATS. VSIX builds clean, installs into a temp profile cleanly, source code is sound. Visual smoke-test (status bar / auto-typing observation) requires a GUI session — the maintainer runs the runbook below when back at his computer. Do NOT publish until visual smoke is green.

## VSIX build output

`npx --yes @vscode/vsce package` from `extensions/vscode/`:

| metric | pre-prep | post-prep | delta |
|---|---|---|---|
| files | 3500 | **1999** | -1501 (-43%) |
| compressed size | 4.38 MB | **2.80 MB** | -1.58 MB (-36%) |
| unpacked size | ~14.97 MB | ~8.6 MB | -42% |
| LICENSE warning | YES | NO | resolved |
| "no .vscodeignore" warning | YES | NO | resolved |

### Changes that drove the delta

- **NEW `extensions/vscode/.vscodeignore`** — excludes `PUBLISH.md` (internal doc), `src/**` + `tsconfig.json` (build inputs, only `out/` ships), all `*.map` source maps, `.d.ts` declaration files, test fixtures, `.github/` metadata + `FUNDING.yml` files, and node_modules `CHANGELOG.md` chains.
- **NEW `extensions/vscode/LICENSE`** — copy of the repo root LICENSE (MIT, Lumiere Ventures 2026). Closes the `vsce` warning + makes the marketplace listing show the correct license.

### Remaining `vsce` warning (not a blocker for v0.1.0)

> WARNING: This extension consists of 1999 files, out of which 1094 are JavaScript files. For performance reasons, you should bundle your extension.

This is bundling advice — runtime works fine without it; users just download more bytes. **Bundling is queued for v0.2.0** (would also enable an extension icon, smaller install footprint, faster activation). For v0.1.0 / first-marketplace-listing the unbundled form is acceptable per VS Code marketplace norms (most under-100k-install extensions ship unbundled).

## Smoke-test findings

### Programmatic install (passed)

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir=/tmp/vsce-smoke-XXXXX \
  --extensions-dir=/tmp/vsce-smoke-XXXXX/exts \
  --install-extension extensions/vscode/bot-relay-tether-0.1.0.vsix
```

Result: `Extension 'bot-relay-tether-0.1.0.vsix' was successfully installed.`
Listed: `lumiere-ventures.bot-relay-tether@0.1.0`. Temp profile cleaned post-test.

This proves the VSIX is structurally valid and VS Code accepts it via the same install flow the marketplace uses.

### Source-code review (passed by inspection — no GUI run)

`extensions/vscode/src/extension.ts` activation flow inspected:
- `activate()` creates output channel + status bar before any network call → operator always sees `Tether: starting...` even if the relay is down.
- `connect()` short-circuits to `Tether: idle` if `agentName` is empty — never dials a non-existent endpoint.
- `disconnect()` is called before each new `connect()` → no zombie subscriptions on config-change.
- `setNotificationHandler` filters by URI → other agents' inbox events don't trigger this extension's handlers.
- Webview HTML escapes user content via `safe()` (replaces `&`, `<`, `>`); `enableScripts: false`. XSS surface is closed.
- Hardcoded `version: "0.1.0"` at line 167 (in the MCP `clientInfo`) — minor drift candidate; should source from `package.json` or a constant. Flagged for v0.2.0 cleanup, not a v0.1.0 blocker.

### Visual smoke-test (DEFERRED to the maintainer)

Cannot run from the build agent without a GUI session. The runbook below is the publish-blocking check the maintainer executes when back. Expect ~10 minutes.

#### the maintainer's visual smoke-test runbook

Pre-conditions:
- Live `bot-relay-mcp` daemon at `:3777` (running v2.6.2+ — verified via `curl http://127.0.0.1:3777/health`).
- A registered smoke-test agent on the daemon (e.g. `tether-smoke-001`, role `tester`, no caps). Mint via `relay mint-token tether-smoke-001`.

Steps:

1. **Install into a temp profile** (don't pollute your real profile):
   ```bash
   SMOKE_DIR=/tmp/vsce-smoke-$$
   mkdir -p "$SMOKE_DIR"
   "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
     --user-data-dir="$SMOKE_DIR" \
     --extensions-dir="$SMOKE_DIR/exts" \
     --install-extension /Users/user/Documents/Ai\ stuff/Claude\ AI/bot-relay-mcp/extensions/vscode/bot-relay-tether-0.1.0.vsix
   ```

2. **Launch VS Code with the temp profile + open a workspace** (any folder works):
   ```bash
   "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
     --user-data-dir="$SMOKE_DIR" \
     --extensions-dir="$SMOKE_DIR/exts" \
     /tmp
   ```

3. **Configure the extension** — `Cmd+,` → search `bot-relay.tether`:
   - `endpoint`: `http://127.0.0.1:3777` (default)
   - `agentName`: `tether-smoke-001`
   - `agentToken`: paste the token from `relay mint-token` step
   - `notificationLevel`: `event` (default)
   - `autoInjectInbox`: `true` (test the auto-typing path)

4. **Verify activation**:
   - `View → Output → Tether for bot-relay-mcp` should show `connecting to http://127.0.0.1:3777/mcp as agent="tether-smoke-001"` followed by `connected + subscribed`.
   - Status bar (left) should show `Tether: 0 pending` (or similar — `formatStatusBar` shape).

5. **Test the event path** — from another terminal with your normal agent identity:
   ```bash
   # As your operator agent (e.g. main victra), send a message to the smoke agent:
   # via mcp__bot-relay__send_message to=tether-smoke-001 content="hello tether"
   ```
   Expected within ~1 second:
   - Toast notification appears: "tether-smoke-001 received 1 from <sender>: hello tether" (or similar — `formatToast` shape).
   - Status bar updates to `Tether: 1 pending | last <time>`.
   - Status bar background turns yellow (1-3 = `warn` severity).

6. **Test `autoInjectInbox`** — open an integrated terminal named `tether-smoke-001` (terminal name dropdown → rename, or `code --name`):
   - Send another message to `tether-smoke-001`.
   - Expected: the literal characters `inbox\n` should be written into that terminal as if you typed them.
   - If no terminal matches the agent name, the active terminal receives the keystroke (fallback).

7. **Test the inbox panel**: click the status bar tile.
   - Expected: a webview panel opens with `Tether — tether-smoke-001`, pending count, total, last-message preview.

8. **Test `Tether: Reconnect to Relay`** — `Cmd+Shift+P` → run that command.
   - Expected: output channel logs `connecting...` again + `connected + subscribed`. Status bar refreshes.

9. **Test severity colors** — flood the inbox with 4+ messages.
   - Expected: status bar background turns red (4+ = `alert` severity).

10. **Cleanup**:
    ```bash
    rm -rf "$SMOKE_DIR"
    # And in your real daemon, optionally:
    # relay revoke tether-smoke-001  (or leave as a long-lived smoke agent)
    ```

If any step fails or surprises you, **STOP the publish ceremony** and surface to victra-build for a v0.1.1 / v0.2.0 fix round. Don't publish a known-broken extension to the marketplace.

## PUBLISH.md verification

Read end-to-end. **Accurate as written**, with one minor staleness:

- Per-release checklist step 1 says "Tether v0.1.0 ships with bot-relay-mcp v2.5.0." This is technically still true — the extension code first landed in v2.5.0 — but bot-relay-mcp is now at v2.6.2 LIVE on npm. The extension's own version is independent of the daemon's, so this comment is informational. Recommend updating to "Tether v0.1.0 first shipped with bot-relay-mcp v2.5.0; tested compatible through v2.6.x." Not a blocker.

No other corrections needed. The 5-step the maintainer ceremony below mirrors PUBLISH.md verbatim plus the prep work this round delivered.

## Walked analogous surfaces

| asset | status | action |
|---|---|---|
| `extensions/vscode/README.md` | EXISTS, accurate | none |
| `extensions/vscode/LICENSE` | NEW (copy of root) | added in this round |
| `extensions/vscode/CHANGELOG.md` | NEW | added in this round |
| `extensions/vscode/.vscodeignore` | NEW | added in this round |
| Extension icon (`icon` field in `package.json`) | MISSING | **deferred to v0.2.0** (marketplace shows generic placeholder for v0.1.0; not a blocker, just less polished) |
| Bundled JS via esbuild | MISSING | **deferred to v0.2.0** (would shrink VSIX to <500 KB; not blocking for first-listing) |
| `repository.directory` field | PRESENT (`extensions/vscode`) | none |
| `homepage` URL | PRESENT (points to README) | none |
| Keywords for marketplace search | 5 set (mcp, claude-code, agent, tether, bot-relay) | none |
| `categories` | `["Other"]` | acceptable for v0.1.0; could pick a better fit in v0.2.0 |

## Final 5-step ceremony for the maintainer

When you're back at your computer and have the publisher account ready, run these in order. Steps 1-2 are one-time setup; 3-5 are per-release.

### One-time prerequisites

1. **Create the publisher** — go to https://marketplace.visualstudio.com/manage and create publisher id `lumiere-ventures` (matches `package.json:publisher`). You'll need to verify ownership of an Azure DevOps org first; create one (free) if you don't have it.

2. **Create the Personal Access Token (PAT)** — go to https://dev.azure.com/<your-org>/_usersSettings/tokens. Click "New Token". Settings:
   - Name: `vsce-publish-tether` (or similar)
   - Organization: "All accessible organizations"
   - Expiration: 1 year
   - Scopes: **Custom defined → Marketplace → Manage**
   Save the token in your password manager (1Password / Apple Keychain / Bitwarden) — it's only shown once. The token is what `vsce login` needs.

3. **Install vsce** (if not already): `npm install -g @vscode/vsce`. (Skipped if you already have it from a prior session.)

### Per-release ceremony (this is a release)

4. **Login to vsce as the publisher**:
   ```bash
   vsce login lumiere-ventures
   # Paste the PAT when prompted.
   ```

5. **Run the visual smoke-test runbook above** (10 min — the publish-blocking check). If everything green, then:
   ```bash
   cd "/Users/user/workspace/Claude AI/bot-relay-mcp/extensions/vscode"
   vsce publish
   # vsce reads the version from package.json (currently 0.1.0) and uploads the VSIX.
   # Expect: "Published lumiere-ventures.bot-relay-tether v0.1.0."
   ```

   The marketplace takes ~5-10 minutes to surface the new listing. Find it at:
   https://marketplace.visualstudio.com/items?itemName=lumiere-ventures.bot-relay-tether

### Post-publish (also for the maintainer)

- **Sanity-install from the live marketplace** into a clean profile to confirm the published artifact installs cleanly:
  ```bash
  SANITY_DIR=/tmp/vsce-sanity-$$
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    --user-data-dir="$SANITY_DIR" \
    --extensions-dir="$SANITY_DIR/exts" \
    --install-extension lumiere-ventures.bot-relay-tether
  # Should produce the same install line as the local-VSIX install.
  rm -rf "$SANITY_DIR"
  ```
- **Tag the release**: `git tag tether-vscode-v0.1.0 && git push --tags`.
- **Update the bot-relay-mcp main `README.md`** with a marketplace badge under the Tether section. Suggested form:
  ```markdown
  [![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lumiere-ventures.bot-relay-tether)](https://marketplace.visualstudio.com/items?itemName=lumiere-ventures.bot-relay-tether)
  ```
- **Watch the marketplace stats for the first 2 weeks** — that's the validation signal you named in the Tether Phase 1 dispatch.

## Files this round added or modified

| path | what | why |
|---|---|---|
| `extensions/vscode/.vscodeignore` | NEW | trim VSIX from 3500 → 1999 files; exclude PUBLISH.md, source TS, dev junk in node_modules |
| `extensions/vscode/LICENSE` | NEW (copy of repo root) | resolve `vsce` LICENSE-missing warning + show correct license on marketplace listing |
| `extensions/vscode/CHANGELOG.md` | NEW | marketplace surfaces this on the extension page; first user-facing change log |
| `extensions/vscode/marketplace-prep-results.md` | NEW (this file) | the maintainer's bridge from "ready" to "published" |
| `extensions/vscode/bot-relay-tether-0.1.0.vsix` | (build artifact) | the VSIX to ship; should NOT be committed to git (already gitignored under `extensions/vscode/.gitignore` if it exists, or via `.vsix` in the global `.gitignore`; verify) |

## Out-of-scope deferred items

Tracked here so they don't get lost. None are v0.1.0 blockers.

- **Bundled JS via esbuild** — would shrink VSIX from 2.8 MB → <500 KB. Activation would be ~5x faster. Queued v0.2.0.
- **Extension icon** — 128x128 PNG referenced via `package.json:icon`. Lumiere brand icon would be appropriate. Queued v0.2.0.
- **Hardcoded `version: "0.1.0"` in `extension.ts:167`** — drift risk on bump. Should read from `package.json` via `vscode.extensions.getExtension(...).packageJSON.version`. Queued v0.2.0 cleanup.
- **`categories` choice** — currently `["Other"]`. Better fit might be `["Notebooks"]` or a custom category once VS Code adds "AI tooling" or similar. Marketplace allows update post-publish.
- **Configurable summary digest interval** — fixed at 5min in v0.1.0; user-configurable in v0.2.0.
