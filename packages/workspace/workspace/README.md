# @deepseek-ai/dsh-workspace

Workspace entity registry (`ctx.workspace`) for the DeepSeek Harness: durable workspace records — a stable `WorkspaceId`, a canonical directory path, a display title, and the ordered account of owned sessions — stored through the domain data form (`workspaceDomainSpec`, table `workspaces`). Consumers see the `Workspace` interface only; the entity implementation stays package-private.

Design rationale, the path/uniqueness canon, and the consistency rules live in the [Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Shape

- `ctx.workspace.create(path, title?)` — canonicalizes `path` via `fs.realpath` (trailing slashes, `..`, symlinks), rejects a nonexistent path (the original `ENOENT`), a path resolving to anything but a directory, and a canonical path another workspace already owns. Title defaults to `basename(path)`.
- `ctx.workspace.get(id)` / `list()` / `resolveByPath(path)` — cache-served lookups; `resolveByPath` is async because it runs the same `realpath` canon first.
- `Workspace.attachSession(id)` — idempotent; validates that the session's stored header `cwd`, canonicalized the same way, equals the workspace path. A missing persistence service, unknown session, absent or unresolvable `cwd`, or mismatch rejects without writing (what cannot be validated is not recorded). `detachSession` removes from the account only, never touching the session's own log.
- `Workspace.sessionIds` — the ordered ownership account (array order is display order). Accounted ids whose session no longer exists are filtered from the projection and pruned durably on the next mutation. A medium accounting one session under two workspaces, or claiming one canonical path from two records, rejects at startup (external edit — the write side makes both unreachable). Attach/detach idempotence is decided on the domain write chain, so unawaited concurrent calls settle in call order.
- `Workspace.status()` — uncached directory check, `'ok' | 'missing-dir'`; a missing directory never mutates the record.

Session persistence is an optional peer resolved with `ctx.get`: absent, attach rejects and projections serve the account unfiltered.

## Model Experience

### Workspace records and session accounts

#### What the model sees

Nothing. `ctx.workspace` serves workspace records to host-side consumers only: the package registers no tools, injects no prompts, and writes no session events, so no request field ever carries this package's data.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- No delete entry point in this phase — workspace deletion ships as one complete semantic together with the session-delete primitive and cascade orchestration (future-work section of the Agent Note); a half "drop the record, keep the sessions" operation is deliberately not exposed.
- No RPC surface or GUI wiring yet; the record schema is the direct source of the next phase's wire projection.
- The known-session view refreshes at startup and on attach validation; a session deleted by an external process during this one is filtered only after the next refresh.
