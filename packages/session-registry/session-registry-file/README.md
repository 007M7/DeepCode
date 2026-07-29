# @deepseek-ai/dsh-session-registry-file

English | [中文](README.zh.md)

File-backed implementation of the [live-session registry seam](../session-registry/README.md): one lock-guarded JSON file under the Harness home is the whole medium. Mounting it publishes `ctx.sessionRegistry`; `file` exposes the absolute registry path (`<root>/sessions.json`).

## Liveness and crash safety

Liveness is derived at read time from the recorded pid via `kill(pid, 0)`: `ESRCH` is dead, `EPERM` is alive under another user, and any other errno propagates rather than being read as an answer. A process killed without running its disposer therefore leaves a record that the next `list()` prunes and rewrites — no daemon, no heartbeat, and no permanent phantom. `bootId` distinguishes a recycled pid, so deregistration cannot delete a namesake record belonging to a different incarnation.

## Concurrency

Both layers are required and neither substitutes for the other.

- **Across processes**, each read-modify-write cycle holds a [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) advisory lock. Unlocked whole-file republication loses records under concurrent launchers, which is why the storage-hub JSON backend — documented last-write-wins, single-host-process — cannot serve this medium.
- **Within one process**, calls queue on an internal chain. The advisory lock is tracked per process, so overlapping same-process callers contend for its bounded retry budget instead of queueing; past roughly a dozen concurrent calls that budget runs out and a registration rejects. Callers publish fire-and-forget, so such a rejection would silently drop a live session from the listing.

Writes are temp-file plus atomic `rename` (no fsync: a listing lost to a crash is rebuilt by the next process's read, so crash durability buys nothing here), under a `0o700` root with a `0o600` file.

## Durable format

`sessions.json` carries a `version` stamp pinned at `0` under the pre-release stance: a differing version is rejected rather than migrated. Reads validate every field because the medium is shared and user-visible. An individually unusable row is dropped while its siblings survive, and unparsable text or a foreign version reads as empty — one malformed record written by another harness version must not hide every other live session. Any of these marks the medium damaged, so the next write republishes and heals it.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter registries) | Directory holding `sessions.json`; created `0o700` on demand |
| `lockStaleMs` | natural | `10000` | Milliseconds after which a held lock is treated as abandoned and reclaimed |
| `lockRetries` | natural | `10` | Retries before a contended acquisition fails loud |

## Model Experience

None, as this package registers no tools, injects no prompts, and appends no session events; it stores host-side process records for the CLI listing surface only.

#### KV Cache effect

Independent of live requests: the registry never touches a request prefix, so nothing here can invalidate provider cache reuse.

## Known Limitations and Deferred Work

- **A reused pid within the stale window is trusted** — `bootId` distinguishes incarnations of records this process wrote, but a foreign record whose pid the operating system has since reassigned to an unrelated live process is reported alive until its owner removes it.
