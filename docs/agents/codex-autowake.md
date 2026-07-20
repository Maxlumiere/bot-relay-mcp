# Codex auto-wake — Tether wakes Codex terminals (token-free)

Claude Code agents wake themselves on relay mail via **Tether** (the VS Code
extension): it watches the relay and injects a wake into the agent's terminal
when mail arrives. The idle *waiting* is done by the extension, not the model —
so an idle agent costs **zero tokens** and stays fully typeable.

**As of relay v2.16.3, Tether wakes Codex terminals too.** All a Codex agent
needs is a **single register-only `SessionStart` hook** that reports the same
identity handshake the Claude hook sends, plus the Tether extension configured to
watch that agent.

> **No poll loop.** Earlier drafts of this doc used a `Stop`-hook keep-alive that
> re-prompted the model every ~90s. That burned a Codex turn per poll and held
> the session so you couldn't type to it. **It is removed.** Tether does the
> waking; Codex spends tokens only when there is actually mail to read.

## How Tether binds a Codex terminal

Tether binds a VS Code terminal to an agent by **process id**, host-scoped
(`pid-binding.ts`): it needs the agent's registered `host_shell_pids` **and** a
`host_id` matching this machine's GUID. The controlling shell PID (= the VS Code
`Terminal.processId`) is always somewhere in the reported ancestry chain, so
Tether binds by PID intersection — no fragile terminal-name matching.

The `SessionStart` hook (`hooks/codex/codex-session-start.sh`) computes these via
the shared helpers in `hooks/_vault-helpers.sh` (`relay_pid_chain`,
`relay_machine_guid`) and sends `host_shell_pids` + `host_id` +
`terminal_title_ref` on `register_agent` — **byte-parity with the Claude hook**
(`hooks/check-relay.sh`), so a Codex agent's `host_id` agrees with the
extension's reader (`extensions/vscode/src/host-identity.ts`).

Confirm signal — Tether Output channel shows a **non-empty** binding:
`pid-binding: resolve agent="<codex>" binding.hostId=<guid> binding.hostShellPids=[…]`.
The `∅/∅` fingerprint (empty host_id / host_shell_pids) means the handshake
didn't land — check that the agent launched via a hook-enabled `~/.codex/config.toml`.

## Prerequisites

- `codex-cli` with the `SessionStart` lifecycle hook.
- A running bot-relay daemon on `127.0.0.1:3777` (`relay`/HTTP transport).
- `curl` and `python3` on `PATH`.
- The **Tether** VS Code extension installed, with the Codex agent in its watch
  list (`bot-relay.tether.agents`, `llm: "codex"`).
- The bot-relay MCP server configured in Codex so the woken agent can call
  `get_messages` / `send_message` itself (see "Reading mail once woken" below).

## 1. Set the agent identity

The hook reads the agent name/role from the environment (the payload Codex passes
does not carry it). Launch Codex with these set, e.g. via a shell alias:

```bash
alias codex-relay='RELAY_AGENT_NAME=codex RELAY_AGENT_ROLE=auditor codex'
```

`RELAY_AGENT_NAME` is required; `RELAY_AGENT_ROLE` defaults to `user`. Optionally
export `RELAY_TERMINAL_TITLE=<name>` so the name-match fallback also has a value.

## 2. Add the register-only hook to `~/.codex/config.toml`

Add **only** the `SessionStart` block (adjust the absolute path to wherever this
repo lives). Codex also accepts a `hooks.json` file with the same shape.

```toml
[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "/path/to/bot-relay-mcp/hooks/codex/codex-session-start.sh"
statusMessage = "Registering with bot-relay"
```

> **Do NOT add a `Stop` hook.** The removed keep-alive poller is what burned
> tokens and blocked input. A register-only `SessionStart` is all that's needed —
> it fires once, sends the handshake, and exits.

Make the script executable once:

```bash
chmod +x /path/to/bot-relay-mcp/hooks/codex/codex-session-start.sh
```

## 3. Reading mail once woken

When Tether wakes the terminal, Codex takes a turn and calls
`get_messages`/`send_message` via its bot-relay MCP server — which must
authenticate as the agent. The MCP server resolves the token from the
per-instance vault when it knows `RELAY_AGENT_NAME`. Provide that to the MCP
server one of two ways:

- **Per-launch (multi-agent safe):** pass it on the codex launch as a config
  override so each alias declares its own agent:
  ```
  codex -c 'mcp_servers.bot-relay.env.RELAY_AGENT_NAME="codex-5-5"'
  ```
- **Hardcoded in config** (single-agent only): set `RELAY_AGENT_NAME` in
  `[mcp_servers.bot-relay.env]`. Do **not** hardcode the token — the vault
  resolves it. Avoid this when two Codex agents share one `~/.codex/config.toml`
  (the name would apply to both).

## 4. Test

1. **Register + handshake:** launch Codex. The `SessionStart` hook registers the
   agent with its PID chain — confirm the binding is non-empty:
   ```bash
   curl -s http://127.0.0.1:3777/api/snapshot \
     | python3 -c 'import json,sys;[print(a["name"],a.get("host_shell_pids"),a.get("host_id")) for a in json.load(sys.stdin).get("agents",[]) if a["name"]=="codex"]'
   ```
   Both fields should be populated (not `null`/`None`).
2. **Wake on mail:** from another agent (or `curl`), send the Codex agent a
   message. Tether should inject a wake into the Codex terminal and the agent
   reads + acts on the mail — no human input, no idle polling.

## Notes

- Any hook failure — daemon unreachable, missing identity — exits 0 with no
  output, so a broken setup never blocks the Codex session from starting.
- The handshake fields are best-effort: if a machine has no derivable GUID or the
  PID walk fails, the field is omitted and Tether falls back to name matching
  (which is why setting `RELAY_TERMINAL_TITLE` is a useful backstop).
- Codex's own optional `Stop`-block self-continue (for a Codex agent driving its
  own multi-step task) is a separate mechanism and unrelated to relay wake; this
  doc deliberately does **not** wire a relay poll loop into it.
