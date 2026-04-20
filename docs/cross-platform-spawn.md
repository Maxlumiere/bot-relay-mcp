# Cross-Platform Spawn (v1.9)

`spawn_agent` opens a new Claude Code terminal pre-configured as a relay agent. v1.9 extends that to **macOS, Linux, and Windows** via a driver abstraction — each platform has its own native terminal-emulator dispatch chain. You never need to install bash on Windows; Node (already a requirement) is the only runtime dependency.

## How the dispatcher picks a driver

```
1. RELAY_TERMINAL_APP env var set?        → use that (allowlist-gated)
2. process.platform auto-detect           → pick the platform driver
3. Platform driver walks its fallback chain
      macOS   : bin/spawn-agent.sh (iTerm2 → Terminal.app)
      Linux   : gnome-terminal → konsole → xterm → tmux
      Windows : wt.exe → powershell.exe → cmd.exe
```

If `RELAY_TERMINAL_APP` is set but not in the allowlist, the dispatcher logs a stderr warning and falls through to auto-detect (never silent). Allowlist (v1.9):

```
iterm2  terminal  gnome-terminal  konsole  xterm  tmux  wt  powershell  cmd
```

## Platform: macOS (darwin)

Uses the existing `bin/spawn-agent.sh` — unchanged from v1.6.4. Preserves the 3-layer hardening (zod → shell allowlist → printf %q + osascript escape) and the 19+ adversarial payload integration tests.

**Requirements:** iTerm2 or Terminal.app installed. Both ship with macOS by default (Terminal.app is always present; iTerm2 is preferred if installed).

**Install check:** no action — the shell script is packaged with the relay.

## Platform: Linux

TypeScript-native driver. Tries four emulators in order and uses the first one on `PATH`.

| Sub-driver | When | Invocation |
|---|---|---|
| `gnome-terminal` | GNOME / Ubuntu desktop | `gnome-terminal -- bash -lc 'cd <cwd> && exec claude'` |
| `konsole` | KDE desktop | `konsole -e bash -lc '<launch>'` |
| `xterm` | Universal GUI fallback | `xterm -e bash -lc '<launch>'` |
| `tmux` | Headless servers, no GUI | `tmux new-session -d -s <agent-name>-<4hex> 'bash -lc "<launch>"'` |

**Headless servers:** if none of the GUI emulators are present but `tmux` is installed, the driver creates a **detached tmux session**. As of v1.9.1, the session name is `<agent-name>-<4-hex-chars>` (e.g., `worker-1-a3f8`) — the random suffix prevents silent collision when two agents share a relay name. The agent's registered relay identity stays `<agent-name>` (peers discover by relay name, not tmux session name). The actual tmux session name is logged to stderr at spawn time so operators know what to attach:

```bash
# stderr at spawn time:
# [spawn] tmux session "worker-1-a3f8" launched for agent "worker-1". Attach with: tmux attach -t worker-1-a3f8

tmux attach -t worker-1-a3f8
```

Entropy: 4 hex = 16 bits = 65,536 possible suffixes. Birthday-paradox collision probabilities: 50% at 362, 1% at 36, 0.1% at 11 concurrent same-named agents. Any collision at runtime still manifests as a clean tmux error (never a silent failure). Suffix is generated from `crypto.randomBytes` (not `Math.random`).

**Defense-in-depth quote escape:** the launch command `cd '<cwd>' && exec claude` escapes any `'` inside cwd using the standard POSIX `'\''` idiom, so even if a future feature relaxes the zod schema the tmux / gnome-terminal / konsole / xterm paths remain safe.

The agent's SessionStart hook fires on `claude` startup inside the tmux session — all relay features work.

**Install check (manual):**

```bash
# Pick one of these, OR install tmux for headless:
sudo apt-get install gnome-terminal      # Ubuntu/Debian GNOME
sudo apt-get install konsole             # KDE
sudo apt-get install xterm               # universal X11 fallback
sudo apt-get install tmux                # headless servers
```

If NONE are available the spawn errors with a clear message listing the four options.

## Platform: Windows (win32)

TypeScript-native driver. Tries three terminal hosts in order.

| Sub-driver | When | Invocation |
|---|---|---|
| `wt.exe` | Windows Terminal (Win10 21H2+, Win11 default) | `wt.exe -d <cwd> claude` |
| `powershell.exe` | PowerShell, any Windows | `powershell.exe -NoExit -Command "Set-Location -LiteralPath '<cwd>'; claude"` |
| `cmd.exe` | Legacy fallback, always present | `cmd.exe /K "cd /D <cwd> && claude"` |

`-NoExit` / `/K` keep the terminal window open after `claude` finishes — matches the other-platform convention where the emulator stays around as a workbench window.

**Forward-slash CWD normalization:** paths like `C:/work/project` are converted to `C:\work\project` before invocation. The zod-level allowlist still applies.

**Defense-in-depth quote escape (v1.9.1):** the PowerShell driver's `Set-Location -LiteralPath '<cwd>'` embedding doubles any `'` in cwd using PowerShell's own escape rule (`''`). Today zod rejects `'` in cwd outright; this escape is a defense-in-depth measure for any future schema relaxation.

**Install check (manual):**

```powershell
# Modern (recommended): install Windows Terminal
winget install Microsoft.WindowsTerminal

# Verify
Get-Command wt.exe
Get-Command powershell.exe
```

`cmd.exe` is always present on Windows — the spawn will find it as a last resort.

## Override via `RELAY_TERMINAL_APP`

Force a specific sub-driver (useful for testing or mixed environments):

```bash
RELAY_TERMINAL_APP=xterm claude         # Linux: force xterm even if GNOME is present
RELAY_TERMINAL_APP=tmux claude          # Linux: force headless-style session
RELAY_TERMINAL_APP=powershell claude    # Windows: skip wt.exe, use PowerShell
```

Override values are allowlist-checked (no arbitrary shell injection via env var). Unknown values fall through to auto-detect with a stderr warning.

**v1.9.1 — platform-aware allowlist:** the override must match the current platform's sub-driver list. `RELAY_TERMINAL_APP=gnome-terminal` on macOS (where the Linux driver is never invoked) is rejected, not silently accepted. The dispatcher emits a stderr warning listing the current platform's valid values.

If the forced sub-driver's binary is NOT on PATH, the driver treats it as unavailable and walks the chain normally — operators never get silently wedged on a missing binary.

## Env-var propagation — principle of least authority

Spawned agents inherit a DELIBERATELY narrow env map:

- System essentials: `PATH`, `HOME` / `USERPROFILE`, `LANG`, `TERM`, `SHELL` (POSIX-only), Windows-specific (`SYSTEMROOT`, `APPDATA`, etc.)
- Any env var prefixed with `RELAY_*`
- Explicitly set: `RELAY_AGENT_NAME`, `RELAY_AGENT_ROLE`, `RELAY_AGENT_CAPABILITIES` from the spawn call

**NOT propagated by default:** `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, etc. If you need to forward custom vars, prefix them with `RELAY_` or ask to extend the allowlist.

## Manual smoke-test checklists

Automated CI runs on macOS only. Linux and Windows are covered by unit-test mocks (see `tests/spawn-drivers.test.ts`) plus these manual-smoke checklists.

### macOS manual smoke

```bash
# From the bot-relay-mcp project directory:
RELAY_SPAWN_DRY_RUN=1 node -e '
  import("./dist/spawn/dispatcher.js").then(({spawnAgent}) =>
    console.log(JSON.stringify(spawnAgent({name:"smoke-m",role:"builder",capabilities:["test"],cwd:"/tmp"}), null, 2))
  )'
# Expect: { ok: true, driverName: "macos", dryRunCommand: {...} }
```

### Linux manual smoke

```bash
# On a Linux box with at least one of gnome-terminal / konsole / xterm / tmux:
RELAY_SPAWN_DRY_RUN=1 node -e '
  import("./dist/spawn/dispatcher.js").then(({spawnAgent}) =>
    console.log(JSON.stringify(spawnAgent({name:"smoke-l",role:"builder",capabilities:["test"],cwd:"/tmp"}), null, 2))
  )'
# Expect: ok:true, driverName one of gnome-terminal/konsole/xterm/tmux, dryRunCommand shows the emulator invocation

# Force tmux:
RELAY_TERMINAL_APP=tmux RELAY_SPAWN_DRY_RUN=1 node -e '...'
# Expect: driverName:"tmux", args include "new-session -d -s smoke-l"

# Live invocation (real spawn, no dry-run):
unset RELAY_SPAWN_DRY_RUN
node -e '
  import("./dist/spawn/dispatcher.js").then(({spawnAgent}) => spawnAgent({name:"smoke-l-live",role:"builder",capabilities:[]}))
'
# Expect: new terminal window opens (or tmux session created)
# For tmux path: `tmux ls` shows session "smoke-l-live"; `tmux attach -t smoke-l-live` attaches
```

### Windows manual smoke (PowerShell)

```powershell
# From the bot-relay-mcp directory:
$env:RELAY_SPAWN_DRY_RUN="1"
node -e "import('./dist/spawn/dispatcher.js').then(({spawnAgent}) => console.log(JSON.stringify(spawnAgent({name:'smoke-w',role:'builder',capabilities:['test'],cwd:'C:\\tmp'}), null, 2)))"
# Expect: ok:true, driverName one of wt/powershell/cmd, dryRunCommand shows the invocation

# Force PowerShell sub-driver:
$env:RELAY_TERMINAL_APP="powershell"
node -e "..."
# Expect: driverName:"powershell", args include "-NoExit -Command 'Set-Location ...; claude'"

# Live invocation:
Remove-Item env:RELAY_SPAWN_DRY_RUN
node -e "import('./dist/spawn/dispatcher.js').then(({spawnAgent}) => spawnAgent({name:'smoke-w-live',role:'builder',capabilities:[]}))"
# Expect: a new terminal window opens with Claude Code starting
```

## Troubleshooting

**"Unsupported platform" error** — the dispatcher received a `process.platform` value other than `darwin`, `linux`, or `win32`. BSD / Solaris / AIX are not supported in v1.9. File an issue with the platform string.

**"No terminal emulator found" (Linux)** — install one of `gnome-terminal`, `konsole`, `xterm`, or `tmux`. If you're on a container image / minimal VM, tmux is the lightest option (~1MB).

**"No terminal available" (Windows)** — `wt.exe`, `powershell.exe`, AND `cmd.exe` were all missing from PATH. This should be impossible on a standard Windows install; check your PATH integrity or reinstall PowerShell.

**Override is ignored** — your `RELAY_TERMINAL_APP` value is not on the allowlist. Check the stderr log for the fallback warning and compare to the allowlist at the top of this doc.

**Agent spawns but doesn't register with the relay** — SessionStart hook issue, not a spawn issue. See `docs/hooks.md`.

**Path with spaces breaks on Windows** — quote the cwd in your tool call; the driver normalizes forward slashes but cannot fix missing quotes at the JSON boundary. Also see the v1.8.1 callout in `docs/post-tool-use-hook.md`.

## Related

- [`bin/spawn-agent.sh`](../bin/spawn-agent.sh) — macOS driver (shell script)
- [`src/spawn/drivers/linux.ts`](../src/spawn/drivers/linux.ts) — Linux driver
- [`src/spawn/drivers/windows.ts`](../src/spawn/drivers/windows.ts) — Windows driver
- [`src/spawn/dispatcher.ts`](../src/spawn/dispatcher.ts) — driver selection logic
- [`tests/spawn-drivers.test.ts`](../tests/spawn-drivers.test.ts) — per-driver mock tests
- [`tests/spawn-integration.test.ts`](../tests/spawn-integration.test.ts) — macOS real-subprocess adversarial suite
