# @deepseek-ai/dsh-session-persistence-jsonl

The JSONL durable session-persistence backend — a concrete `SessionPersistence` (the `dsh-session-persistence` seam). Each session has one append-only logical JSONL log, stored as `.jsonl.zstd` by default or raw `.jsonl` when compression is disabled.

## On-disk layout

```
<root>/
  cwd-<sha256(cwd)[:12]>/        # per-project bucket (or _no-cwd/ when no cwd)
    <encoded-id>.jsonl.zstd      # default: checksummed header frame + append frames
    <encoded-id>.jsonl           # only with compression: 'none'
```

- The first logical line is the immutable `SessionHeader` tagged `{ type: 'session', version, id, cwd?, createdAt, parentSession?, seedLength?, delegationDepth }`. `delegationDepth` is required on disk and is `0` for a top-level session; a missing or invalid value rejects the log. Every subsequent logical line is one storage record; `assistant/chunk` events are never dropped, and `seq` stays contiguous across the decoded log (`events[i].seq === i`).
- A storage record is a `SessionEvent` JSON verbatim, or — written only under `packChunks` — a **packed chunk row** (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`; bare slash-less tags like the header's `session`, so row tags cannot be confused with event types): one line holding a run of ≥3 consecutive same-block `assistant/chunk` delta events, `seq0`/`time0` plus per-member `dt` gaps reconstructing every member's `seq`/`time` exactly. The lossless codec lives in `@deepseek-ai/dsh-session` (`packChunkRuns`/`decodeStorageRecord`) and whitelists exact shapes — anything unrecognized stores verbatim. Reading is layout-blind: `load` always decodes rows, so packed, unpacked, and mixed files load identically.
- Session ids are unvalidated branded strings, so they are injectively escaped to a single safe path segment before use (no traversal, no collision).

## Config

| Key | Type | Notes |
|---|---|---|
| `root` | `string` (required) | Root directory for all session files. **No default** — a `process.cwd()` default would scatter files as the process's cwd changes (bash calls, subprocesses). An existing root must be a readable directory; an absent root is created on first materialization. |
| `packChunks` | `boolean` (default `false`) | Write delta-chunk runs as packed rows (~60% smaller logical logs measured on a real coding session). Off, the written logical layout is byte-identical to the pre-packing format; reading packed rows works regardless of this switch. Off by default while the snapshot goldens stay one-event-per-line — recording with packing on rewrites every fixture `session.jsonl`. |
| `compression` | `'zstd' \| 'none'` | Defaults to `'zstd'`; `'none'` retains newline-delimited UTF-8 text. |

`locate(meta)` returns `{ kind: 'jsonl', path }` using the resolved absolute root and the same cwd-bucket/id encoding as materialization. It performs no filesystem I/O: the target can be returned before the file exists, and an existing file contains only the last flushed prefix.

## Physical encoding

The default artifact is a standard concatenation of independent [Zstandard frames](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md): one checksummed frame containing only the header line, followed by one checksummed frame per durable append batch. The backend uses Node's built-in Zstandard API with its default compression level and exposes no level knob. Listing reads and validates only the header frame. `compression: 'none'` keeps the same logical lines in the original raw representation.

A root belongs to one encoding. Startup discovery and targeted lookup reject the opposite suffix with an error naming the incompatible artifact and instructing the caller to select the matching mode or a separate root. There is no migration, mixed-root fallback, or dual write.

## Durability and crash semantics

- **Bound storage identity.** Lookup requires one matching encoded filename across the cwd buckets, then verifies that the header id equals the requested id and that the header's id/cwd derive the selected path. Listing applies the same path check and rejects duplicate ids. Identity failures occur before repair or append.
- **Lazy materialization.** `create(meta)` writes nothing; on the first `append`, the backend writes and `fsync`s the encoded header and first batch in a temporary file. POSIX publishes it without overwrite via a hard link and `fsync`s the parent directory. Windows publishes it without overwrite via `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` and creates missing directories through the same write-through pattern. A created-but-never-appended session leaves nothing on disk and is absent from `list`.
- **Append-only.** Flushed events are never rewritten. Subsequent raw batches append lines; compressed batches append one frame. Both paths `fsync`, and a caught write or sync failure rolls the file back to its prior byte length.
- **Crash recovery — preserve valid tail work.** `load` validates every complete compressed frame and scans their decompressed JSONL. If the last frame is structurally incomplete, the reader keeps its complete decoded records, truncates from that frame's start, and re-encodes those records with the synthetic tool, step, and turn closers required by the shared [persistence contract](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md). Raw mode truncates from its first incomplete line. A checksum/decompression failure in a complete frame, or a defect at or before the last committed `turn/end`, is corruption and rejects.
- **Non-mutating inspection.** `inspect()` returns the detached valid prefix without truncating an incomplete tail or closing an interrupted turn, and leaves the lightweight revision unchanged.
- **Contiguous-seq.** `append` rejects a batch whose first `seq` does not continue the stored log, and rejects non-JSON-serializable `event.data` naming the offending event type.
- **Lightweight revisions.** `listSnapshots()` identifies a log by its device, inode, size, and nanosecond timestamps, avoiding a full-log parse while changing after append, repair, replacement, or store changes.

## Write path

The plugin copies frozen session events into one controller per live session and starts an eager drain. Concurrent events share the current write; events admitted during it form a follow-up batch, while `session/flush` waits until both current and pending batches are durable. A per-session cursor prevents resumed sessions from re-appending stored events, and live sessions are seeded when the plugin loads. The owning backend instance serializes operations for one session; disposal drains every retained controller before teardown.

## Model Experience

### Resumed conversation history

#### What the model sees

JSONL storage contributes no live prompt or schema. Loading restores stored surface history and preserves prior request headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Raw `assistant/chunk` records do not duplicate messages.

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

JSONL storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

- **Only the configured encoding and current `SESSION_FORMAT_VERSION` (v0) load** — changing compression requires a separate/fresh root or selecting the legacy raw mode; the pre-release format has no migration.
- **Compressed files are not directly line-readable** — use the backend to load them, or select `compression: 'none'` before writing a fresh root when text fixtures or external line readers are required.
- **Nothing deletes session files** — logs accumulate under `root` until removed externally (the seam has no deletion surface).
- **One live writer per session** — append and repair are coordinated only inside the owning backend instance. Another backend instance or process must not write the same session until that owner reaches quiescent disposal; initial same-id publication remains collision-safe through the POSIX no-overwrite hard link or Windows write-through rename without replacement.
- **POSIX materialization requires hard-link support** — first append uses `link()` so same-id races fail instead of overwriting a committed log; Windows uses write-through rename without replacement.
