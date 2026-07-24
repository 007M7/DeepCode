# @deepseek-ai/dsh-storage-json

JSON backend for the [storage hub](../storage/README.md): one human-readable `<unit>.json` file per unit under a configured root, registered as backend `json`. Design: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Model

- The in-memory unit state is authoritative; every write primitive republishes the whole file via temp-write + fsync + atomic `rename()` replace. A unit file is always the complete current net state — legibility is this backend's reason to exist; scale is the SQLite backend's job.
- A missing file opens as an empty unit and materializes on the first write. A foreign or unparsable file rejects with `malformed-medium`; a stored version differing from the descriptor rejects with `version-mismatch` (no migration, pre-release stance).
- Write ordering across calls belongs to the caller (the domain layer's write chain); each single call is atomic and durable once resolved.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files; created `0o700` on demand |

## Model Experience

No model-visible surface: this package serves host-side persistence only; nothing it does reaches prompts, tool schemas, or token budgets.

## Known Limitations and Deferred Work

- Windows durability relies on libuv's `rename()` (`MoveFileExW` with replacement) without an explicit write-through flag; the session-log backend's stricter Win32 write-through publish helper is planned to move down here when the append-log facet lands (see the Agent Note's migration section).
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins). Single-host-process deployments are the current consumer; the multi-process story is deferred per the Agent Note's out-of-scope table.
