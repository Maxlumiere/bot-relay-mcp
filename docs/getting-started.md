# Getting Started with bot-relay-mcp

A walkthrough from zero to working multi-agent setup. Assumes you have Claude Code installed and a macOS machine.

## Step 1 — Install

```bash
git clone https://github.com/Maxlumiere/bot-relay-mcp.git
cd bot-relay-mcp
npm install
npm run build
```

(Once published to npm, this will become `npx bot-relay-mcp` — one command.)

## Step 2 — Wire into Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "bot-relay": {
      "command": "node",
      "args": ["/absolute/path/to/bot-relay-mcp/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

## Step 3 — Install the auto-register hook

Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/bot-relay-mcp/hooks/check-relay.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

This runs every time you open a Claude Code terminal. It registers the agent and delivers any pending mail automatically.

## Step 4 — Set up shell aliases

In `~/.zshrc` or `~/.bashrc`:

```bash
alias ai='RELAY_AGENT_NAME=main RELAY_AGENT_ROLE=user claude'
alias ai-planner='RELAY_AGENT_NAME=planner RELAY_AGENT_ROLE=orchestrator RELAY_AGENT_CAPABILITIES="planning,delegation" claude'
alias ai-builder='RELAY_AGENT_NAME=builder RELAY_AGENT_ROLE=builder RELAY_AGENT_CAPABILITIES="build,test" claude'
```

Now any of those aliases opens Claude Code with the agent identity pre-set.

## Step 5 — Run the first test

### 5a. In your current terminal

```
> Register me on the bot-relay and list who else is online.
```

Claude calls `register_agent` and `discover_agents`. You should see yourself and anyone else who's registered.

> **Lost your token?** If you close the terminal and lose `RELAY_AGENT_TOKEN`, the relay will reject re-register with `AUTH_FAILED`. Run `relay recover <your-agent-name>` to safely clear the registration (messages + tasks are preserved), then call `register_agent` again to get a fresh token.

### 5b. Open a second terminal with an alias

In a new iTerm2 window:
```bash
ai-builder
```

Tell it:
```
> Check my relay messages.
```

The SessionStart hook will have already auto-registered it and surfaced any pending mail.

### 5c. Cross-terminal communication

From terminal 1:
```
> Send a message to "builder": "Hey, can you check the tests?"
```

From terminal 2:
```
> Check my relay messages and respond to the planner.
```

## Step 6 — The automation: spawn_agent

From your primary terminal:
```
> Spawn a new agent called "reviewer-1" with role "reviewer" and capabilities ["review","testing"]. Queue the message: "Review the latest commit and report findings."
```

A new iTerm2 window opens, already registered, already carrying the instruction. It gets to work without you touching it.

## Step 7 — Dashboard

Start the relay in HTTP mode:

```bash
RELAY_TRANSPORT=http node /path/to/bot-relay-mcp/dist/index.js
```

Open `http://127.0.0.1:3777/` in a browser. Live view of all agents, active tasks, messages, and webhooks. Auto-refreshes every 3 seconds.

## Step 8 — Webhook to external systems (optional)

Want Slack/Telegram/n8n to hear about relay events?

```
> Register a webhook: url "https://my-n8n.example.com/webhook/xyz", event "task.completed", secret "my-signing-secret"
```

Every time a task completes, n8n gets a POST with the task details and an HMAC-SHA256 signature in `X-Relay-Signature`.

## Troubleshooting

**Nothing happens when I open a terminal:** The SessionStart hook isn't wired up. Check `~/.claude/settings.json` and confirm the path to `check-relay.sh` is correct and the script is executable (`chmod +x`).

**"Agent X is not authorized":** Make sure the agent named in `from` or `to` has been registered. `discover_agents` tells you who's on the relay.

**Dashboard is blank:** The HTTP server isn't running. Start it with `RELAY_TRANSPORT=http node dist/index.js`.

**Messages aren't delivered on session start:** Check `RELAY_AGENT_NAME` is set in your shell env before `claude` runs. The hook reads that env var to know which mailbox to check.
