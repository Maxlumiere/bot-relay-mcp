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

**B — use the wasm driver (zero approval).** `sql.js` is pure WebAssembly — no native build, no install script — so it is unaffected by the new default. Set `RELAY_SQLITE_DRIVER=wasm` for a NEW instance (see "How to switch" below); an existing database must be converted once with `relay convert-journal --to wasm` (every relay process stopped). `sql.js` is an installed *optional* dependency; if you installed with `--omit=optional`, add it back with `npm install sql.js`. Remember the single-process limit (see "Limitations").

The other npm 12 defaults — `--allow-git` / `--allow-remote` now `none` (from npm 11.10+ / 11.15+) — don't affect the relay: every dependency resolves from the npm registry, none from git or tarball URLs.

## When to use

| Scenario | Driver |
|---|---|
| Standard install (macOS, Ubuntu, Node 22+) | `native` (default) |
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

### The instance's driver (`sqlite_driver`)

The driver is a property of the **instance**: a `sqlite_driver` key in the instance's `config.json` (default `native`).

**`"wasm"` puts the instance in owner mode.** Its database is owned by ONE process, the relay daemon:
- **A new database** is created already stamped for its owner (`application_id` RLYW).
- **The owner holds a single-owner lock**, which the kernel releases when it exits:
  - macOS and Linux: a flock-class lock on a private `.<name>.relay-owner` file beside the database. Linux takes it with the system `flock` (util-linux). **Never delete that file**: a relay that finds its lock file removed or replaced stops writing.
  - Linux without a trusted system `flock` (util-linux, at a system path): owner mode is **refused** by name, with the remedies (install util-linux's flock, use the native driver, or reach a live owner over HTTP). There is no fallback lock: two kinds of lock could not exclude each other.
  - Windows: a named pipe, which is per session namespace: one container per database there.
  - A wasm database must live on a LOCAL filesystem. On Linux, owner mode is refused on a network filesystem (NFS, SMB/CIFS, 9p, Ceph, Lustre and similar, by `statfs`). macOS is not checked.
  - **FUSE is refused too**, conservatively: a FUSE filesystem may be remote (sshfs) or local (gocryptfs), and the relay cannot tell which, nor whether it shares flock locks between processes. If you need a local FUSE filesystem allowed, open an issue naming it: allowing one needs a measurement that its flock excludes a second process, not a config switch. Until then, use the native driver there.
- **Names of the form `.<db name>.<pid>.<12 hex digits>.new` beside an owned database are RESERVED for the relay** (a new database's first image). Under the lock, the owner removes such a name when it is the same file as the database (a leftover of a crash between creating and naming the database); do not keep your own files under such a name.
- **Every write is atomic** (a temp file, then a rename), made under that lock. Before each write, the owner checks that the file is still the one it last wrote (its inode, size and modification time) and refuses to write over a file another process replaced or rewrote.
  - A metadata change, such as a `chmod`, is deliberately not treated as a write (the relay itself tightens its database's mode on every open).
  - On a filesystem with coarse timestamps (HFS+ 1 s, FAT/exFAT 2 s), a same-size rewrite within that granularity is not seen. APFS, ext4 and NTFS are fine-grained.
  - The check DETECTS another writer before the owner's next write; it does not prevent a write landing between the check and the rename.
  - There is no `fsync`: the atomic replace protects against a crash of the relay, not against a power loss.
- **Other processes** reach the database through the daemon over HTTP:
  - a second process that tries to open it is refused by name;
  - so is a stdio MCP server, with the client config to use instead: `{ "type": "http", "url": "http://127.0.0.1:3777/mcp" }`;
  - so is a native opener;
  - so is every relay opener that reaches the database by its PATH on an instance that declares `"wasm"` (the declaration of the instance that HOLDS the database and the caller's own are both consulted, and an unreadable one refuses too) (the CLI verbs such as `relay bind`, `fleet`, `recover` and the `purge-*` verbs, and the synchronous fallback some callers use), even before the database exists: it names the HTTP client config and creates nothing;
  - the hooks read no database on such an instance: SessionStart prints ONE notice ("hooks deliver no mail on a wasm instance; use the HTTP owner") instead of reading mail and tasks with `sqlite3` (the relay decides this for them: the 7th line of `relay where --fields`). Delivering mail to the hooks through the owner is a later release.
- **A backup or a restore** of an owned database runs under the lock when no owner is live, and is refused while one is. A database with more than one hard link is refused by both (the lock is keyed by the file's name, so a second name could be locked by another process): remove the extra links.

**One mode only (5.0.0): every wasm database has its single owner.**
- **`RELAY_SQLITE_DRIVER=wasm` on an instance that declares nothing** is a wasm declaration: a NEW database is created owned (stamped RLYW), exactly as with `sqlite_driver: "wasm"`. A second process on it is refused by name. The legacy no-owner mode is retired.
- **An existing native (RLYN) or legacy (unstamped) database is never opened by wasm.** Either declaration on one is refused by name, naming the remedy: `relay convert-journal --to wasm`.
- **A contradiction is refused:** when the instance declares a driver and `RELAY_SQLITE_DRIVER` says the other one, the relay refuses to start and names the remedy (unset `RELAY_SQLITE_DRIVER`). Before 5.0.0 it warned and the instance won.
- **The file's header decides** for a database already stamped for an owner, whatever the environment says.

### Converting a database: `relay convert-journal`

```bash
# Close every terminal and relay process that uses this instance first, then:
relay convert-journal --to wasm      # native/legacy → wasm (single owner)
relay convert-journal --to native    # wasm → native
```

- It runs offline, under the database's single-owner lock: it is refused while a wasm owner is live, while another process has the database open (SQLite side files remain), and on a database with more than one hard link.
- An older relay running the pre-5.0.0 legacy wasm mode holds no lock and cannot be detected, so close everything first.
- Each step leaves a file its header's driver opens, and the command is idempotent: if it is interrupted, run it again and it completes.
- It also writes the instance's `sqlite_driver` (to the real file behind a symlinked `config.json`; every other field kept, mode 0600). `RELAY_CONFIG_PATH` naming a different file from the database's own instance config is refused.
- **A restore** re-stamps the archive's database to the instance's driver (its declaration, else the live database's header, else native), so a backup made before a conversion still restores. A declaration that disagrees with the live database's header refuses the restore by name.

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

### No WAL mode

The wasm driver sets `PRAGMA journal_mode=DELETE` (SQLite's default rollback journal). WAL mode is meaningless for an in-memory database with write-back. At our scale, the performance difference is negligible.

### Write-back latency

Every write operation triggers a full database export + `fs.writeFileSync()`. At < 1MB this is sub-millisecond. At larger DB sizes (unlikely for a relay, but possible with heavy audit logging), this could become noticeable.

### Crash durability

If the process crashes between a write and the write-back flush, the last write is lost. This is the same durability model as better-sqlite3 with WAL (WAL may not be checkpointed on crash). In practice, relay operations are not financially critical — a lost message can be re-sent.

## Backup and restore

`relay backup` and `relay restore` work on the wasm driver (#171). The snapshot is taken via sql.js's atomic in-memory serialization (`.export()`) instead of `VACUUM INTO` (which can't write through the Emscripten virtual filesystem), and the manifest/integrity probes open through the active driver — so no native `better-sqlite3` binary is required. The `.export()` image is captured atomically, so a snapshot can't tear even if writes are in flight. Archives are standard SQLite files and **interoperate across drivers**: a backup made on native restores on wasm and vice versa, so switching drivers (e.g. adopting wasm after the npm-12 change) doesn't strand your existing archives.

**A restore never deletes a database file or its side files** (either driver). It replaces the database's real file (a symlinked database path keeps its link), and it REQUIRES the `-wal`, `-shm` and `-journal` files to be absent beside it at the moment of the swap. A stale WAL or journal left beside a replaced database is applied to it by the next open, which would silently undo the restore. On a native database the restore first opens it once itself (a bare connection: no migration, no stamp), checkpoints its WAL and closes, which removes the side files when no other process has the database open (including the ones its own safety backup created). If one is still there, the restore is refused by name (each file, with its size) and nothing is changed: stop the other process that has the database open, and retry. A checkpoint that reports the database busy is refused the same way. The checks run again right before the rename. A stated limit: an external tool's `PERSIST`/`TRUNCATE` rollback journal or a persistent WAL also leaves such files after a clean close (the relay itself only ever sets WAL mode); confirm that nothing has the database open, then remove them.

## Troubleshooting

**"Could not locate the bindings file"** — `better-sqlite3`'s native binary was never built. Most often this is npm 12's install-scripts-off default (see "npm v12+ and install scripts" above): either approve the script (`npm approve-scripts better-sqlite3 && npm rebuild`) or switch to the wasm driver (`RELAY_SQLITE_DRIVER=wasm`). On older npm it means the compile failed at install — check for a C++ toolchain, or use wasm.

**"sql.js is not installed"** — you set `RELAY_SQLITE_DRIVER=wasm` but sql.js is not in `node_modules`. Run `npm install sql.js`.

**"Failed to flush DB to disk"** — the relay cannot write to the DB path. Check permissions on `~/.bot-relay/` or set `RELAY_DB_PATH` to a writable location.

**Data seems to disappear between restarts** — check that you're not running two processes with the wasm driver on the same DB file (see "Single-process only" above).

## Related

- [README: SQLite Driver Options](../README.md) — quick overview
- [`src/sqlite-compat.ts`](../src/sqlite-compat.ts) — compatibility adapter source
- [`tests/db-wasm.test.ts`](../tests/db-wasm.test.ts) — wasm driver integration tests
