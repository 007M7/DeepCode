# @deepseek-ai/dsh-session-persistence-jsonl

The JSONL durable session-persistence backend — a concrete `SessionPersistence` (the `dsh-session-persistence` seam). One append-only `.jsonl` event log per session plus a small atomic `.summary.json` sidecar for mutable metadata.

## On-disk layout

```
<root>/
  cwd-<sha256(cwd)[:12]>/        # per-project bucket (or _no-cwd/ when no cwd)
    <encoded-id>.jsonl           # header line + one SessionEvent per line (verbatim)
    <encoded-id>.summary.json    # mutable SessionSummary (atomic temp-write + rename)
```

- The first `.jsonl` line is the immutable `SessionHeader` tagged `{ type: 'session', version, id, cwd?, createdAt, parentSession? }`; every subsequent line is one `SessionEvent` JSON, **verbatim including `assistant/chunk`** so `seq` stays contiguous (`events[i].seq === i`).
- Session ids are unvalidated branded strings, so they are percent-encoded to a single safe path segment before use (no traversal, no collision).

## Config

| Key | Type | Notes |
|---|---|---|
| `root` | `string` (required) | Root directory for all session files. **No default** — a `process.cwd()` default would scatter files as the process's cwd changes (bash calls, subprocesses). |

## Durability and crash semantics

- **Lazy materialization.** `create(meta)` writes nothing; the `.jsonl` (header + first batch) is written atomically (temp-write + `fsync` + rename) on the first `append`. A created-but-never-appended session leaves nothing on disk and is absent from `has`/`list`.
- **Append-only.** Committed events (at or below a flushed `turn/end`) are never rewritten. Subsequent appends are line appends at EOF + `fsync`.
- **Crash recovery — close, don't truncate.** A crash can leave a log whose final turn never closed (real events after the last `turn/end`). `load` PRESERVES those events (a turn can be huge — they are real work) and closes the orphaned turn by durably appending synthetic boundary events: an error `tool/result` for every `tool-call` the crash left unanswered (the loop logs the assistant message before running the tools, so a mid-tool crash leaves dangling calls — and `deriveMessages()` would replay an assistant tool-call with no result, which providers reject), then a `step/end` if a step was open, then `turn/end {kind:'interrupted'}`, returning a balanced log. Only a never-fully-written **torn tail fragment** (a final line with no newline / unparseable) is `ftruncate`d away before the closers are written. See [session persistence](../../docs/rfc/implemented/2026-06-14-session-persistence.md).
- **Contiguous-seq.** `load` rejects a mid-log parse error or `seq` gap (unloadable); `append` rejects a batch whose first `seq` does not continue the stored log, and rejects non-JSON-serializable `event.data` naming the offending event type.
- **Format version.** Only v1 is supported; `load` rejects an unknown version. A future format change requires a version bump + migration.

## Write path

The plugin generalizes the example `session-jsonl.ts`: it subscribes to `session/created` (capture the header; persist a fork's seed once), `session/event` (snapshot each event when buffering — the live `session.events` object is mutable), and `session/flush`/dispose (drain the write-behind buffer through `append`). A per-session write cursor means a resumed session never re-appends already-stored events. Existing live sessions are seeded on plugin apply (HMR does not replay `session/created`). All backend operations for one session are serialized, and disposal awaits quiescence (every init + final drain) before returning, so no write lands after teardown.
