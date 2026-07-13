# @deepseek-ai/dsh-session-persistence-jsonl

The JSONL durable session-persistence backend — a concrete `SessionPersistence` (the `dsh-session-persistence` seam). One append-only `.jsonl` event log per session.

## On-disk layout

```
<root>/
  cwd-<sha256(cwd)[:12]>/        # per-project bucket (or _no-cwd/ when no cwd)
    <encoded-id>.jsonl           # header line + one SessionEvent per line (verbatim)
```

- The first `.jsonl` line is the immutable `SessionHeader` tagged `{ type: 'session', version, id, cwd?, createdAt, parentSession?, seedLength? }`; every subsequent line is one `SessionEvent` JSON, **verbatim including `assistant/chunk`** so `seq` stays contiguous (`events[i].seq === i`).
- Session ids are unvalidated branded strings, so they are percent-encoded to a single safe path segment before use (no traversal, no collision).

## Config

| Key | Type | Notes |
|---|---|---|
| `root` | `string` (required) | Root directory for all session files. **No default** — a `process.cwd()` default would scatter files as the process's cwd changes (bash calls, subprocesses). |

## Durability and crash semantics

- **Lazy materialization.** `create(meta)` writes nothing; the `.jsonl` (header + first batch) is written atomically (temp-write + `fsync` + rename) on the first `append`. A created-but-never-appended session leaves nothing on disk and is absent from `list`.
- **Append-only.** Committed events (at or below a flushed `turn/end`) are never rewritten. Subsequent appends are line appends at EOF + `fsync`.
- **Crash recovery — close, don't truncate.** `load` preserves valid events from an interrupted final turn, appends the synthetic tool, step, and turn closers required by the shared [persistence contract](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md), and removes only an incomplete final line.
- **Contiguous-seq.** `load` rejects a mid-log parse error or `seq` gap (unloadable); `append` rejects a batch whose first `seq` does not continue the stored log, and rejects non-JSON-serializable `event.data` naming the offending event type.
- **Format version.** Only the current `SESSION_FORMAT_VERSION` (v0) is supported; `load` rejects any other version. While the harness is unreleased the on-disk format is pre-release/unstable: a breaking format change is absorbed at v0 (no bump until the first tagged release) and non-current logs are rejected — there is no migration (no persisted user data to preserve).

## Write path

The plugin buffers frozen session events and drains them on flush or disposal. A per-session cursor prevents resumed sessions from re-appending stored events, and live sessions are seeded when the plugin loads. Operations for one session are serialized; disposal waits for initialization and the final drain so no write lands after teardown.
