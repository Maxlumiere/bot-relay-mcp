# File transfer convention (v2.0)

The relay does NOT move file bytes. It moves **pointers** to files that already exist on a shared filesystem (local, NFS, a mounted bucket, etc.). Senders write or place the file wherever the receiver can read it, then send a message whose content includes a structured `_file` descriptor. The relay treats the descriptor opaquely — no path validation, no hash verification, no execution.

**This is a convention, not enforcement.** Every receiver is responsible for validating the pointer before acting on it. If you skip validation, you are vulnerable to path traversal, hash collision, and unsafe execution. Read the Receiver contract section carefully.

---

## The `_file` descriptor

Inside the content of a `send_message`, `broadcast`, `post_to_channel`, or `post_task` payload, embed an object shaped like:

```json
{
  "summary": "Quarterly revenue report — attached as XLSX",
  "_file": {
    "path": "/var/shared/drops/Q3-revenue.xlsx",
    "size": 483021,
    "hash": "sha256:8a4cfbc7e6e2d17f3a5b2c9...",
    "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
}
```

### Fields

| Field | Required | Notes |
|---|---|---|
| `path` | yes | Absolute filesystem path accessible to the receiver. Never a URL. |
| `size` | recommended | Bytes. Receiver should re-stat and reject on mismatch. |
| `hash` | recommended | `sha256:<hex>` of the full file contents. Receiver must verify. |
| `mime` | optional | Content type hint. Not a security boundary. |

Additional fields are allowed and ignored by the relay. Receivers should treat unknown fields as untrusted metadata.

---

## Sender contract

1. **Write the file first.** If the message arrives before the write completes, the receiver hashes zero bytes or a truncated file.
2. **Place the file under a mutually-agreed root.** Receivers reject paths outside their allowlist. Common roots: `/var/shared/drops/`, `~/.bot-relay/files/`, or anything mounted on both sides.
3. **Don't move or delete the file for at least N minutes** — enough time for the receiver to read it. A safe default is 24 hours; extend for retried tasks.
4. **Hash the file.** Include the sha256 so the receiver can detect corruption or tampering.
5. **Don't send sensitive content through `_file` on untrusted filesystems.** The relay's encryption-at-rest (v1.7) does NOT cover the file on disk — that's the sender's / operator's responsibility.

---

## Receiver contract (CRITICAL)

The relay hands you an opaque pointer. You must defend against a hostile or accidentally-malformed descriptor.

### 1. Path allowlist

Resolve the path and verify it falls under an approved root:

```ts
import path from "node:path";
const ALLOWED_ROOTS = ["/var/shared/drops", path.join(process.env.HOME ?? "", ".bot-relay/files")];
const resolved = path.resolve(descriptor.path);
if (!ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
  throw new Error(`_file.path outside allowed roots: ${resolved}`);
}
```

Rejects `../../../etc/passwd`, `/etc/shadow`, `~` expansion tricks, symlinks-out-of-root (via `path.resolve`).

### 2. Symlink check

`path.resolve` does NOT follow symlinks on its own. If a symlink INSIDE your root points OUTSIDE, the allowlist is bypassed. Either disallow symlinks:

```ts
const stat = await fs.promises.lstat(resolved);
if (stat.isSymbolicLink()) throw new Error("symlinks are not accepted");
```

or dereference + re-check:

```ts
const real = await fs.promises.realpath(resolved);
if (!ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + path.sep))) {
  throw new Error("symlinked target outside allowed roots");
}
```

### 3. Size check

```ts
const stat = await fs.promises.stat(resolved);
if (descriptor.size != null && stat.size !== descriptor.size) {
  throw new Error(`size mismatch: declared ${descriptor.size} got ${stat.size}`);
}
if (stat.size > MAX_ACCEPT_SIZE) throw new Error("file too large");
```

### 4. Hash verification

```ts
import crypto from "node:crypto";
const expected = descriptor.hash?.replace(/^sha256:/, "");
if (expected) {
  const actual = crypto.createHash("sha256");
  const stream = fs.createReadStream(resolved);
  for await (const chunk of stream) actual.update(chunk);
  if (actual.digest("hex") !== expected) throw new Error("hash mismatch");
}
```

**If the descriptor omits `hash`, assume the payload is untrusted.** Prefer refusing to process it.

### 5. Never execute

- Do NOT `execFile(resolved)`, `import(resolved)`, `require(resolved)`, or pipe the bytes into a shell interpreter.
- Do NOT unzip/untar without a sandboxed extraction path and entry-name validation (zip-slip protection).
- Do NOT parse as YAML/JSON with prototype pollution risk without a hardened parser.

### 6. Sandbox costly work

If the file is user-generated (media, archives, data dumps), process it in a child process with:
- CPU timeout
- Memory limit (`--max-old-space-size` or `rlimit`)
- Read-only filesystem (or no filesystem access beyond the file itself)
- No network

---

## Why the relay is opaque

The relay doesn't validate the path because the validation logic depends on the receiver's deployment:
- Which roots are trusted
- Whether symlinks are permitted
- Whether size limits are stricter than the sender's limit
- Whether the receiver runs in a container with different mount paths

Validation at the boundary (receiver) is correct. Validation in the middle (relay) is at best redundant and at worst wrong for half of all deployments.

Put another way: the relay cannot tell the difference between a legitimate `_file` pointer and a hand-crafted descriptor trying to trick the receiver. Only the receiver knows what "valid" means in its own context.

---

## Non-goals for v2.0

- **No built-in file upload.** If you need the relay to accept byte streams, use an HTTP endpoint unrelated to MCP (e.g., S3 pre-signed URL, or a sidecar server).
- **No directory references.** `_file.path` must be a single file. Multiple files = multiple `_file` descriptors (array allowed in `content`; receivers loop and validate each).
- **No transport-level encryption of the file.** Encrypt the file on disk yourself (GPG, LUKS, whatever the operator runs). The relay encrypts the message envelope (v1.7 at-rest encryption of `content`), not the file it points at.

These non-goals may lift in later releases. Track the roadmap in `plug-and-play-retro.md`.

---

## Minimal receiver template

```ts
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ALLOWED_ROOTS = ["/var/shared/drops"];
const MAX_BYTES = 50 * 1024 * 1024; // 50MB

export interface FileDescriptor {
  path: string;
  size?: number;
  hash?: string;
  mime?: string;
}

export async function openTrusted(desc: FileDescriptor): Promise<Buffer> {
  const resolved = path.resolve(desc.path);
  if (!ALLOWED_ROOTS.some((r) => resolved === r || resolved.startsWith(r + path.sep))) {
    throw new Error(`path outside allowed roots: ${resolved}`);
  }
  const real = await fs.realpath(resolved);
  if (!ALLOWED_ROOTS.some((r) => real === r || real.startsWith(r + path.sep))) {
    throw new Error("symlink escapes allowed roots");
  }
  const stat = await fs.stat(real);
  if (stat.size > MAX_BYTES) throw new Error("file too large");
  if (desc.size != null && stat.size !== desc.size) throw new Error("size mismatch");
  const buf = await fs.readFile(real);
  if (desc.hash) {
    const expected = desc.hash.replace(/^sha256:/, "");
    const actual = crypto.createHash("sha256").update(buf).digest("hex");
    if (actual !== expected) throw new Error("hash mismatch");
  }
  return buf;
}
```

Audit this before use. Tune `ALLOWED_ROOTS` and `MAX_BYTES` for your deployment.
