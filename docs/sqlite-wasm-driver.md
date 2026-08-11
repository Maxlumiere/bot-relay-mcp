# SQLite WASM Driver (v1.11)

`better-sqlite3` is a native C addon that compiles at `npm install` time. If you're hitting install pain — Windows (Visual Studio Build Tools), Alpine/musl Linux (build-essential + python3), Docker containers (200MB+ build toolchain), CI, ARM cross-compilation — the WASM driver is a zero-native-compilation alternative.

Under the hood it uses [sql.js](https://github.com/sql-js/sql.js) — SQLite compiled to WebAssembly. Same SQL, same schema, same queries. Trade-off: slightly slower on writes (wasm overhead + write-back-to-file), but well within acceptable range for relay workloads (< 50 agents, < 100 concurrent operations).

## npm v12+ and install scripts

npm **v12** (released 2026-07-08) disables dependency **install scripts** by default (`allowScripts` off) — including native `node-gyp` / prebuild builds. `better-sqlite3` (the `native` driver) fetches its prebuilt binary via an install script, so under npm 12's defaults that binary is never fetched and the relay fails at startup with:

```
Error: Could not locate the bindings file
```

This is not live until you're on npm 12 — npm 11.x still runs install scripts (with opt-in warnings from 11.16.0+). Consumers on npm 12 have two fixes:

**A — keep the native driver (required for multi-terminal stdio).** Approve better-sqlite3's install script once; the approval is written to your `package.json` allowlist (commit it):

```bash
npm install                                   # installs; records which deps have scripts
npm approve-scripts --allow-scripts-pending   # review what's pending
npm approve-scripts better-sqlite3            # approve it
npm rebuild                                    # build the native binary
```

**B — use the wasm driver (zero approval).** `sql.js` is pure WebAssembly — no native build, no install script — so it is unaffected by the new default. Set `RELAY_SQLITE_DRIVER=wasm` (see "How to switch" below). `sql.js` is an installed *optional* dependency; if you installed with `--omit=optional`, add it back with `npm install sql.js`. Remember the single-process limit (see "Limitations").

The other npm 12 defaults — `--allow-git` / `--allow-remote` now `none` (from npm 11.10+ / 11.15+) — don't affect the relay: every dependency resolves from the npm registry, none from git or tarball URLs.

## When to use

| Scenario | Driver |
|---|---|
| Standard install (macOS, Ubuntu, Node 18+) | `native` (default) |
| npm 12+ without approving install scripts | `wasm` (or approve — see above) |
| Windows without VS Build Tools | `wasm` |
| Alpine / musl Linux Docker image | `wasm` |
| CI without compiler toolchain | `wasm` |
| ARM device with cross-compilation issues | `wasm` |
| Multi-terminal stdio (many MCP processes sharing one DB) | `native` **only** |

## How to switch

```bash
# Install sql.js (already an optional dependency; npm skips it by default)
npm install sql.js

# Set the driver flag on the relay process
RELAY_SQLITE_DRIVER=wasm RELAY_TRANSPORT=http node dist/index.js
```

That's it. The relay initializes sql.js instead of better-sqlite3, runs the same schema migrations, serves the same 36 tools.

## How to switch back

```bash
# Just remove the flag (native is the default)
RELAY_TRANSPORT=http node dist/index.js
```

Both drivers read and write the same `~/.bot-relay/relay.db` file format. You can switch between them freely (stop the relay, change the flag, restart).

## Performance characteristics

At our relay scale (< 50 agents, < 1MB database), both drivers are sub-millisecond per operation. The wasm driver is ~2-5x slower on writes due to:

1. **WASM overhead:** each SQL operation goes through the WebAssembly VM.
2. **Write-back:** after every write, the entire in-memory database is exported to disk via `db.export()` + `fs.writeFileSync()`. At < 1MB this is fast, but it is a full copy (not incremental).

Reads are ~1.5x slower (wasm overhead only, no write-back).

For relay workloads these differences are imperceptible. If you are building something that does thousands of writes per second, use the native driver.

## Limitations

### Single-process only

The wasm driver operates on an in-memory copy of the database. Two processes sharing the same `relay.db` file will overwrite each other's changes on write-back. There is no file-level locking.

**This means:**
- HTTP transport (single daemon process): safe.
- Single-terminal stdio: safe.
- Multi-terminal stdio (multiple MCP processes sharing the same DB): **NOT SAFE. Use native.**

### Backup and restore unavailable

`relay backup` and `relay restore` do **not** work on the wasm driver. Two reasons: the snapshot step is `VACUUM INTO '<path>'`, and sql.js runs in an in-memory (Emscripten) virtual filesystem — it cannot write that snapshot to a real host path; and the archive's row-count + `PRAGMA integrity_check` probes open the snapshot with the **native** `better-sqlite3` binary, which is exactly what is absent in the npm-12 scripts-off scenario this driver exists to work around. Until a driver-aware snapshot lands, take a backup with the relay **stopped** by copying `~/.bot-relay/relay.db` directly (it is a standard SQLite file), or run the native driver for backup/restore operations.

### No WAL mode

The wasm driver sets `PRAGMA journal_mode=DELETE` (SQLite's default rollback journal). WAL mode is meaningless for an in-memory database with write-back. At our scale, the performance difference is negligible.

### Write-back latency

Every write operation triggers a full database export + `fs.writeFileSync()`. At < 1MB this is sub-millisecond. At larger DB sizes (unlikely for a relay, but possible with heavy audit logging), this could become noticeable.

### Crash durability

If the process crashes between a write and the write-back flush, the last write is lost. This is the same durability model as better-sqlite3 with WAL (WAL may not be checkpointed on crash). In practice, relay operations are not financially critical — a lost message can be re-sent.

## Troubleshooting

**"Could not locate the bindings file"** — `better-sqlite3`'s native binary was never built. Most often this is npm 12's install-scripts-off default (see "npm v12+ and install scripts" above): either approve the script (`npm approve-scripts better-sqlite3 && npm rebuild`) or switch to the wasm driver (`RELAY_SQLITE_DRIVER=wasm`). On older npm it means the compile failed at install — check for a C++ toolchain, or use wasm.

**"sql.js is not installed"** — you set `RELAY_SQLITE_DRIVER=wasm` but sql.js is not in `node_modules`. Run `npm install sql.js`.

**"Failed to flush DB to disk"** — the relay cannot write to the DB path. Check permissions on `~/.bot-relay/` or set `RELAY_DB_PATH` to a writable location.

**Data seems to disappear between restarts** — check that you're not running two processes with the wasm driver on the same DB file (see "Single-process only" above).

## Related

- [README: SQLite Driver Options](../README.md) — quick overview
- [`src/sqlite-compat.ts`](../src/sqlite-compat.ts) — compatibility adapter source
- [`tests/db-wasm.test.ts`](../tests/db-wasm.test.ts) — wasm driver integration tests
