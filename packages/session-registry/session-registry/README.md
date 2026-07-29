# @deepseek-ai/dsh-session-registry

English | [中文](README.zh.md)

Live-session registry seam (`ctx.sessionRegistry`): the contract and record vocabulary for a cross-process registry of the sessions running right now, so a separate short-lived process such as `dsh list-sessions` can answer "what am I running". This package owns no medium — a backend (the lock-guarded JSON file in [`session-registry-file`](../session-registry-file/README.md) today, a database later) implements the abstract service.

## Shape

- `register(registration)` — publish `{ sessionId, cwd, title? }` stamped with this process's pid, a per-incarnation `bootId`, and `startedAt`. Replaces any existing record for the same session id. Returns the `ctx.effect` disposer; awaiting it waits for the removal to reach durability.
- `retitle(sessionId, title)` — replace the recorded title of a session **this** process registered. Titles arrive after registration and can be revised, so it is the one mutable field. A record owned by another pid or incarnation is left alone, and an unknown id is a no-op because a title can resolve after the record is gone.
- `list()` — every live record, newest registration last. Liveness is part of the contract, not the backend's discretion: every returned record's process existed at observation time, so a process killed without running its disposer leaves no permanent phantom.

Backends serialize mutations against concurrent registrars — other processes and overlapping calls in this one — so records are never lost to a torn read-modify-write.

## Record vocabulary

`SessionRegistryRecord` carries `sessionId` (unique across live records), `pid`, `cwd`, `startedAt`, a `bootId` distinguishing a recycled pid from the original incarnation, and an optional `title`. The title travels in the record rather than being read from the session log because log location, format, and compression are per-deployment backend choices an independent reader cannot portably parse.

## Model Experience

None, as this package registers no tools, injects no prompts, and appends no session events; it defines the host-side listing contract only.

#### KV Cache effect

Independent of live requests: the registry never touches a request prefix, so nothing here can invalidate provider cache reuse.

## Known Limitations and Deferred Work

- **Records are process-scoped, not agent-scoped** — only top-level launcher surfaces publish. In-process subagents have no process of their own, and out-of-process subagent backends spawn `dsh-jsonrpc-agent` rather than the CLI, so neither appears in a listing.
- **Liveness is pid existence, not health** — a hung or stopped process still lists as running; the contract deliberately makes no judgement about whether a session is making progress.
