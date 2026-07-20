# @deepseek-ai/dsh-session-persistence-jsonl

The JSONL durable session-persistence backend — a concrete `SessionPersistence` (the `dsh-session-persistence` seam). Each session has one append-only logical JSONL log, stored as `.jsonl.zstd` by default or raw `.jsonl` when compression is disabled.

## On-disk layout

```
<root>/
  cwd-<sha256(cwd)[:12]>/        # per-project bucket (or _no-cwd/ when no cwd)
    <encoded-id>.jsonl.zstd      # default: checksummed header frame + append frames
    <encoded-id>.jsonl           # only with compression: 'none'
```

- The first logical line is the immutable `SessionHeader` tagged `{ type: 'session', version, id, cwd?, createdAt, parentSession?, seedLength?, delegationDepth }`. `delegationDepth` is required on disk and is `0` for a top-level session; a missing or invalid value rejects the log. Every subsequent line is one `SessionEvent` JSON, **verbatim including `assistant/chunk`** so `seq` stays contiguous (`events[i].seq === i`).
- Session ids are unvalidated branded strings, so they are injectively escaped to a single safe path segment before use (no traversal, no collision).

## Config

| Key | Type | Notes |
|---|---|---|
| `root` | `string` (required) | Root directory for all session files. **No default** — a `process.cwd()` default would scatter files as the process's cwd changes (bash calls, subprocesses). |
| `compression` | `'zstd' \| 'none'` | Defaults to `'zstd'`; `'none'` retains newline-delimited UTF-8 text. |

`locate(meta)` returns `{ kind: 'jsonl', path }` using the resolved absolute root and the same cwd-bucket/id encoding as materialization. It performs no filesystem I/O: the target can be returned before the file exists, and an existing file contains only the last flushed prefix.

## Physical encoding

The default artifact is a standard concatenation of independent [Zstandard frames](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md): one checksummed frame containing only the header line, followed by one checksummed frame per durable append batch. The backend uses Node's built-in Zstandard API with its default compression level and exposes no level knob. Listing reads and validates only the header frame. `compression: 'none'` keeps the same logical lines in the original raw representation.

A root belongs to one encoding. Startup discovery and targeted lookup reject the opposite suffix with an error naming the incompatible artifact and instructing the caller to select the matching mode or a separate root. There is no migration, mixed-root fallback, or dual write.

## Durability and crash semantics

- **Lazy materialization.** `create(meta)` writes nothing; on the first `append`, the backend writes and `fsync`s a temporary file, publishes it without overwrite via a hard link, then `fsync`s the directory when the host supports it. A created-but-never-appended session leaves nothing on disk and is absent from `list`.
- **Append-only.** Committed events (at or below a flushed `turn/end`) are never rewritten. Subsequent raw batches append lines; compressed batches append one frame. Both paths `fsync`, and a caught write or sync failure rolls the file back to its prior byte length.
- **Crash recovery — preserve valid tail work.** `load` validates every complete compressed frame and scans their decompressed JSONL. If the last frame is structurally incomplete, the reader keeps its complete decoded records, truncates from that frame's start, and re-encodes those records with the synthetic tool, step, and turn closers required by the shared [persistence contract](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md). Raw mode truncates from its first incomplete line. A checksum/decompression failure in a complete frame, or a defect at or before the last committed `turn/end`, is corruption and rejects.
- **Contiguous-seq.** `append` rejects a batch whose first `seq` does not continue the stored log, and rejects non-JSON-serializable `event.data` naming the offending event type.

## Write path

The plugin buffers frozen session events and drains them on flush or disposal. A per-session cursor prevents resumed sessions from re-appending stored events, and live sessions are seeded when the plugin loads. Operations for one session are serialized; disposal waits for initialization and the final drain so no write lands after teardown.

## Model Experience

### Resumed conversation history

#### What the model sees

JSONL storage contributes no live prompt or schema. Loading restores stored surface history and preserves prior request headers for reconstruction; the new loop composes its current envelope. Each unanswered call in an interrupted tail is balanced with the exact error text `Tool call interrupted by a crash; no result was recorded.` Raw `assistant/chunk` records do not duplicate messages.

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

JSONL storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

- **Only the configured encoding and current `SESSION_FORMAT_VERSION` (v0) load** — changing compression requires a separate/fresh root or selecting the legacy raw mode; the pre-release format has no migration.
- **Compressed files are not directly line-readable** — use the backend to load them, or select `compression: 'none'` before writing a fresh root when text fixtures or external line readers are required.
- **Nothing deletes session files** — logs accumulate under `root` until removed externally (the seam has no deletion surface).
- **Single-process assumption** — per-session serialization and the write cursor live in this process; two processes appending to the same `root` are not coordinated.
- **Initial materialization requires hard-link support** — first append uses `link()` so same-id races fail instead of overwriting a committed log; a filesystem that cannot create hard links cannot host this backend.
- **Windows cannot `fsync` directory handles through Node** — the backend tolerates only Windows `EPERM` from directory `fsync`; file-content `fsync` remains mandatory, but a crash can lose a newly published directory entry on a host without an equivalent directory-sync primitive.
