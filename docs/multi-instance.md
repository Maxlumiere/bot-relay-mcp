# Multi-instance (v2.4.0)

v2.4.0 adds **per-instance local isolation**: an operator can run several coexisting bot-relay daemons on the same machine without collisions. Each instance has its own DB, config, agent namespace, backups directory, and lock file.

Per the federation design memo (Codex 2026-04-19), isolation is per-**instance**, not per-$USER. A single OS user can run a "personal" relay + a "work" relay + a "family" relay from one shell account.

> **Scope note:** v2.4.0 supports COEXISTENCE only — two instances can run side-by-side without stepping on each other. **Cross-instance messaging is NOT supported.** That's v2.5+ federation territory.

## When to use

- You want to run separate relays for separate projects/personas on one machine without state bleeding between them.
- You're running CI runners on the same machine as a dev relay and want hard isolation.
- You're testing bot-relay itself (property tests, replay harness) and want a disposable instance alongside your main setup.

Most solo operators will stay in the **single-instance legacy mode** (the default). Opt in only when you actually need coexistence.

## Layout

### Single-instance legacy (default — no change from v2.3.x)

```
~/.bot-relay/
  config.json
  relay.db
  backups/
```

Set nothing, run nothing new. Operators upgrading from v2.3.x see identical behavior.

### Multi-instance

```
~/.bot-relay/
  instances/
    <instance_id>/
      instance.json      metadata (created_at, hostname, version_first_seen, label)
      config.json        per-instance config
      relay.db           per-instance DB
      backups/           per-instance backups
      instance.pid       PID + lock (one daemon per id)
  active-instance        symlink → <instance_id> (set by `relay use-instance`)
```

`instance_id` is a UUID by default (stable per instance, NOT tied to the OS user).

## Creating an instance

Two paths:

**A. Auto-generated UUID:**

```bash
relay init --yes --multi-instance --profile=team
# → writes ~/.bot-relay/instances/<auto-uuid>/config.json
#   prints the generated instance_id for reuse with RELAY_INSTANCE_ID / use-instance
```

**B. Named instance_id:**

```bash
relay init --yes --instance-id=work --profile=team
# → writes ~/.bot-relay/instances/work/config.json
```

Names must match `/^[A-Za-z0-9._-]+$/` (sanitized against path traversal).

## Running an instance

**Ad-hoc override (highest priority):**

```bash
RELAY_INSTANCE_ID=work bot-relay-mcp --transport=http
```

**Persistent active instance (kubectl-style):**

```bash
relay use-instance work
# → writes ~/.bot-relay/active-instance → work
bot-relay-mcp --transport=http
# → picks up the active instance automatically
```

## Enumerating instances

```bash
relay list-instances
```

```
   INSTANCE_ID                             LABEL           VERSION   CREATED
 * work                                    team            2.4.0     2026-04-23T10:00:00.000Z
   personal                                solo            2.4.0     2026-04-23T10:01:00.000Z
```

The asterisk marks the currently-active instance. `--json` emits machine-readable output.

## Lock-file semantics

Only **one daemon per instance_id** may run at a time. On start, the daemon writes its PID to `<instance_dir>/instance.pid`. A second daemon attempting to use the same `instance_id`:

- If the PID in the file is alive → **refuses to start** with a clear error + guidance.
- If the PID in the file is dead (stale file, prior crash) → reclaims the lock + logs a warning.

Two daemons with DIFFERENT `instance_id`s coexist freely — each holds its own lock.

## Coexistence guarantees

A message sent to `alice` on instance `work` does NOT appear on instance `personal`. Each instance has its own DB + its own agent namespace + its own audit log + its own backups. An agent named `alice` on `work` and an agent named `alice` on `personal` are entirely unrelated.

## Backward compatibility

- Operators with an existing `~/.bot-relay/relay.db` see NO behavior change. Single-instance legacy mode stays the default.
- `RELAY_DB_PATH` still wins as an explicit override (e.g. for test harnesses). When set, the per-instance resolver is skipped.
- Existing hook scripts + MCP server entries keep working. Point them at the per-instance paths only if you intentionally want to drive a specific instance.

## Migration paths

**Stay on legacy** (most operators): do nothing. `relay init` without `--instance-id` / `--multi-instance` keeps writing to `~/.bot-relay/` flat.

**Move to multi-instance preserving existing state:** not supported in v2.4.0 as a one-shot migration. Workaround — run `relay backup`, `relay init --instance-id=<pick>`, `relay restore` the backup into the per-instance DB path. File an issue if this flow feels friction-heavy; v2.4.x might add a one-shot migrator.

**Add a second instance alongside the legacy one:** `relay init --yes --multi-instance`. The flat `~/.bot-relay/relay.db` keeps working for its own clients; the new instance is isolated under `instances/`.

## Federation (NOT in v2.4.0)

Everything above is strictly local. Two instances on the same machine can't talk to each other in v2.4.0 — that's v2.5+ federation territory (hub/edge mode, cross-machine routing, encryption envelope). v2.4.0 is the foundation; v2.5 layers routing on top without a schema churn.
