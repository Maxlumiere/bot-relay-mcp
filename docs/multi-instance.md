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

Only **one daemon per instance_id** may run at a time. On start, the daemon atomically creates `<instance_dir>/instance.pid` via `openSync(..., 'wx')` and writes its PID.

### When the lock is already held

- **Live holder** (PID in the file is alive) → the new daemon **refuses to start** with a clear error + the holder's PID.
- **Dead holder, cross-user, or unreadable file** → the new daemon **refuses to start** and prints manual-cleanup instructions:

  ```
  instance "<id>" has a stale pidfile (PID <n>, not alive).
  Run `rm <path>` after confirming no daemon is alive, then retry.
  ```

The operator confirms no daemon is actually running + removes the pidfile manually.

Two daemons with DIFFERENT `instance_id`s coexist freely — each holds its own lock.

### Why auto-reclaim was removed (v2.4.0 SECURITY hardening)

An earlier v2.4.0 iteration auto-reclaimed stale pidfiles (dead PID → `unlink` + retry). Codex's re-audit reproduced a TOCTOU race:

1. Initial `instance.pid` contains PID 999999 (stale).
2. Process A: atomic open fails EEXIST → reads PID → probes dead → **pauses** just before the unlink.
3. Process B: same path → unlinks → wins atomic open → writes its **live** PID.
4. Process A resumes → unlinks B's live pidfile → wins atomic open → writes its own PID.
5. Both A and B believe they hold the lock. Invariant violated.

The auto-reclaim path cannot be made safe under concurrent acquisition without an atomic "test-and-replace this specific prior content" primitive, which POSIX `fs` doesn't provide. Auto-reclaim is deferred to v2.5+ with a proper primitive (fcntl lock on the open fd, or a directory-based lock) and a regression mirroring Codex's exact schedule. For v2.4.0, we fail-closed on every EEXIST — slow UX, provably safe.

### Manual-cleanup workflow

1. The daemon refuses to start and prints the stale pidfile path.
2. Verify no daemon is alive: `ps -p <pid>` (the PID is in the error message).
3. If confirmed dead: `rm <path>` (the `rm` command is in the error message verbatim).
4. Retry the daemon.

## Coexistence guarantees

A message sent to `alice` on instance `work` does NOT appear on instance `personal`. Each instance has its own DB + its own agent namespace + its own audit log + its own backups. An agent named `alice` on `work` and an agent named `alice` on `personal` are entirely unrelated.

## Backward compatibility

- Operators with an existing `~/.bot-relay/relay.db` see NO behavior change. Single-instance legacy mode stays the default.
- `RELAY_DB_PATH` still wins as an explicit override (e.g. for test harnesses). When set, the per-instance resolver is skipped.
- Existing hook scripts + MCP server entries keep working. Point them at the per-instance paths only if you intentionally want to drive a specific instance.

## v2.4.5 — every transport + hook resolves the same DB

v2.4.0 shipped per-instance isolation, but only the HTTP daemon's startup path went through `resolveInstanceDbPath()`. The bash hooks (`hooks/check-relay.sh`, `hooks/post-tool-use-check.sh`) and the `relay doctor` CLI hardcoded `~/.bot-relay/relay.db`. Result: an operator with an active per-instance setup got silent split-brain — the daemon wrote to the per-instance DB while the SessionStart hook delivered mail from legacy. Codex 5.5 caught this during the v2.4.4 R2 audit (her stdio session couldn't authenticate because her hook was reading legacy while her agent row lived per-instance).

v2.4.5 routes every DB-opening site through the same resolver. Priority for all of them:

1. `RELAY_DB_PATH` — explicit operator override (test harnesses, ad-hoc admin queries).
2. `RELAY_INSTANCE_ID` — explicit per-invocation instance pin.
3. `~/.bot-relay/active-instance` — symlink (or regular file on platforms that block symlinks) pointing at the active instance. Set by `relay use-instance <id>`.
4. Legacy fallback — `~/.bot-relay/relay.db`.

Sites updated:

- `src/cli/doctor.ts` — `relay doctor` now reports the same DB the daemon serves.
- `hooks/check-relay.sh` — SessionStart hook reads the same DB.
- `hooks/post-tool-use-check.sh` — PostToolUse mailbox check sqlite-fallback reads the same DB.
- `scripts/pre-publish-check.sh` — added a non-blocking WARN that fires when both legacy and active-per-instance DBs have agents (the symptom of a stale npx-cached bot-relay-mcp under `~/.npm/_npx/` writing to legacy in parallel with a current daemon serving per-instance).

The TS source (`src/db.ts:getDbPath`) was already correct in v2.4.0; v2.4.5 closes the bash-side gap.

### Windows hook story

The three Claude Code hook scripts (`hooks/check-relay.sh`, `hooks/post-tool-use-check.sh`, `hooks/stop-check.sh`) are bash-only by design — they shell out to `readlink`, `sqlite3`, and `python3` for JSON shaping. Native Windows (no WSL, no MSYS2) is **not** a supported hook environment in v2.4.5.

Operators on Windows have two paths:

1. **Run Claude Code inside WSL.** The `.sh` hooks work unchanged because WSL gives them a real bash. This is the recommended path — every hook feature works the same as on macOS / Linux, including the v2.4.5 per-instance resolver.
2. **Skip hook installation entirely.** All TS surfaces (HTTP daemon, stdio MCP server, `relay` CLI subcommands) run natively on Windows via Node. You lose the SessionStart auto-register + the PostToolUse/Stop near-real-time mailbox notify, but mail visibility still works via the HTTP transport (`relay daemon` on `:3777` + `RELAY_AGENT_TOKEN`) and the agent can call `get_messages` directly when it wants to drain its inbox.

`relay generate-hooks` emits a stderr WARNING when invoked on `process.platform === 'win32'` so an operator who tries the hook install workflow sees the supported-platform note immediately rather than getting confused when the `.sh` files don't run.

PowerShell mirrors of the three hook scripts are a candidate for a future release. The blocker is signal — we have no inbound demand for native-Windows hooks yet, and triplicating ~300 lines of bash into PowerShell ahead of demand would be premature.

## Migration paths

**Stay on legacy** (most operators): do nothing. `relay init` without `--instance-id` / `--multi-instance` keeps writing to `~/.bot-relay/` flat.

**Move to multi-instance preserving existing state:** not supported in v2.4.0 as a one-shot migration. Workaround — run `relay backup`, `relay init --instance-id=<pick>`, `relay restore` the backup into the per-instance DB path. File an issue if this flow feels friction-heavy; v2.4.x might add a one-shot migrator.

**Add a second instance alongside the legacy one:** `relay init --yes --multi-instance`. The flat `~/.bot-relay/relay.db` keeps working for its own clients; the new instance is isolated under `instances/`.

## Federation (NOT in v2.4.0)

Everything above is strictly local. Two instances on the same machine can't talk to each other in v2.4.0 — that's v2.5+ federation territory (hub/edge mode, cross-machine routing, encryption envelope). v2.4.0 is the foundation; v2.5 layers routing on top without a schema churn.
