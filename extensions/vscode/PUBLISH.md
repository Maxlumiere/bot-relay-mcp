# Publishing the Tether VSCode extension

This is a manual checklist for Maxime to run when ready to publish the extension to the VSCode Marketplace. The extension does NOT auto-publish from CI — marketplace publication is gated on the Marketplace publisher account, which only Maxime holds.

## Prerequisites (one-time)

1. Create a publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage). Suggested publisher id: `lumiere-ventures` (matches the org name in `package.json`).
2. Create a Personal Access Token (PAT) at [dev.azure.com](https://dev.azure.com/) with the **Marketplace > Manage** scope. Store it in a password manager (it's only shown once).
3. Install vsce: `npm install -g @vscode/vsce`.
4. Verify identity: `vsce login lumiere-ventures` (paste the PAT).

## Per-release checklist

1. Bump `extensions/vscode/package.json` version (semver). Tether v0.1.0 ships with bot-relay-mcp v2.5.0.
2. Update `extensions/vscode/CHANGELOG.md` with the v0.1 entry (create the file if it doesn't exist; marketplace surfaces it on the extension page).
3. `cd extensions/vscode && npm install && npm run compile`.
4. Smoke-test in the Extension Development Host (F5 from VSCode).
5. Verify the manual checklist below.
6. `vsce package` — produces `bot-relay-tether-<version>.vsix`. Inspect the file list (`unzip -l bot-relay-tether-<version>.vsix`) to confirm no test fixtures or screenshots accidentally shipped.
7. `vsce publish` — uploads to the marketplace under the configured publisher.
8. Install from marketplace into a clean VSCode profile + repeat the manual checklist against the published artifact.

## Manual verification checklist (smoke before publish)

Run in the Extension Development Host with a real bot-relay daemon at `:3777`:

- [ ] Extension activates without errors (Output channel "Tether for bot-relay-mcp" shows `connecting to http://127.0.0.1:3777/mcp ...`).
- [ ] Status bar item appears with text matching `Tether: <count> | last <time>` shape.
- [ ] Status bar color matches severity buckets: gray ≤0 pending, yellow 1-3, red 4+.
- [ ] Send a message to the configured agent via another terminal: `curl ... post send_message`. Status bar updates within 1 second.
- [ ] With `notificationLevel=event`, a toast appears on each event.
- [ ] With `notificationLevel=summary`, no toast on each event but a digest appears within ~5 min.
- [ ] With `notificationLevel=none`, status bar updates but no toast ever.
- [ ] With `autoInjectInbox=true`, an integrated terminal named exactly the agent name receives the literal string `inbox\n` on each event. With `autoInjectInbox=false`, no terminal is touched.
- [ ] Click the status bar → webview panel opens with snapshot data, no console errors.
- [ ] Stop the relay daemon: extension logs reconnect attempts in the output channel; status bar still updates after restart.
- [ ] Run command palette → "Tether: Reconnect to Relay" → connection re-establishes.
- [ ] Settings UI: every setting under `bot-relay.tether.*` shows description text.

## Post-publish

- Tag the bot-relay-mcp release that bundled the extension version: `git tag tether-vscode-v0.1.0 && git push --tags`.
- Add a marketplace badge to the main `README.md` under the Tether section.
- Watch the marketplace stats for the first 2 weeks — that's the validation signal Maxime named at dispatch (operators using it without falling back to typing `inbox`).
