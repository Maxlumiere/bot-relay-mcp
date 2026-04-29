# Tether — operator-awareness layer for bot-relay-mcp

**Tether** is the codename for the layer that sits between bot-relay-mcp and an operator's IDE / notification surface. It solves one product problem:

> An autonomous agent needs to wake the operator (or another agent) when something happens — without the operator having to type `inbox` every five minutes.

The metaphor: a tether keeps an animal connected to base while letting it roam independently. Same relationship between an autonomous AI agent and the operator who needs to know when it ships back.

## The free / paid line (canonical)

This boundary is the architectural anchor for Tether. It is **non-negotiable** — features that don't fit the FREE column do not belong in this repo.

| Tether Local — FREE — bundled in `bot-relay-mcp` | Tether Cloud / Pro — PAID — separate future repo |
|---|---|
| Anything that runs ONLY on the operator's local machine | Anything requiring a server, third-party integration, or cross-machine sync |
| MCP resource subscriptions (the `relay://inbox/<agent>` resource) | Cross-machine relay event sync (federation broker) |
| Local IDE extensions consuming local relay events | Slack / Discord / Email / SMS notifications |
| Status bar / notification toast / auto-inject `inbox` keystroke | Mobile push notifications |
| Single-machine, single-operator coordination | Browser extension auto-wake |
|  | Hosted dashboard at `tether.dev` (or wherever) |
|  | Multi-IDE plugin store presence beyond VSCode |
|  | Team / multi-operator features |
|  | Subscription / auth / billing infra |

If a feature requires running a server or paying a third-party API, it does **not** belong in `bot-relay-mcp`. It belongs in the future Tether Cloud repo.

## What Tether Phase 1 ships (v2.5.0)

Three pieces, all in this repo, all free:

1. **MCP resource subscriptions** — `relay://inbox/<agent_name>` is now a subscribable resource. Any MCP-aware client (Claude Code CLI, VSCode panel, Cursor, Cline, etc.) can subscribe and receive `notifications/resources/updated` pushes when the agent's inbox mutates. See `src/mcp-resources.ts` + `src/mcp-subscriptions.ts`.
2. **VSCode extension v0.1** at `extensions/vscode/` — subscribes to the inbox resource for the agent associated with the workspace, surfaces a status-bar item ("Tether: N pending | last X ago"), opens a click-to-show webview with the last message preview, optionally auto-types `inbox` into the integrated terminal on every event.
3. **Documentation** — this file, README pointer, CHANGELOG entry, and `extensions/vscode/PUBLISH.md` for the marketplace publish steps Maxime runs when ready.

## Phase 2 — future scope (NOT in this repo)

Documented here so the architectural line stays clear. Phase 2 work happens in a separate repo (working name: `tether-cloud` or `tether-pro`) under a different licensing model — likely commercial / paid tier. Features in scope for Phase 2:

- Cross-machine relay event sync (federation broker, hub/edge mode)
- Slack / Discord bots
- Mobile PWA + push notifications
- Browser extension auto-wake
- IDE plugins beyond VSCode (JetBrains, Cursor, Cline, Continue)
- Hosted dashboard
- Subscription / auth / billing
- Team / multi-operator features
- Replay / time-travel debugging UI
- Agent-graph visualization with live message flow

The Phase 2 brief gets written **only after** Phase 1 ships and validates that operators actually use it. Validation signal Maxime named at dispatch time: he uses Tether himself for at least 2 weeks of dispatch arcs without falling back to typing `inbox` by hand.

## Pricing (TBD)

Strategic decision deferred to Maxime — pricing model, free-tier limits, paid-tier features mix. This file gets updated when that lands; until then, this section is intentionally a placeholder so the read order is "free / paid line first, pricing later."

## Why this design

- **Free Phase 1 is on-machine-only by definition.** No server-side state to manage, no cross-machine sync, no auth infra. Ship it bundled, no friction.
- **Paid Phase 2 needs server-side state by definition** (cross-machine routing, mobile push, hosted dashboard). That's where commercial value compounds and where the pricing argument becomes coherent.
- **Splitting the repos at the line** keeps `bot-relay-mcp`'s license clean (MIT, free) while leaving room for Tether Cloud to ship under whatever model makes sense without churning this repo.
