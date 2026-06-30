# @deepseek-ai/dsh-session-fork

Session fork service (`ctx.sessionFork`) for creating seeded child sessions from a live source session at a turn boundary.

## Service: `SessionForkService`

`SessionForkService` is an optional plugin over `dsh-session`; it does not add session events or persistence methods. It owns fork policy, while `ctx.sessions.create(id, { seed, meta })` remains the low-level replay/fork primitive.

| Method | Purpose |
|---|---|
| `snapshot(source)` | Resolve a live `Session | SessionId`, reject non-boundary logs, and return a deep-cloned seed plus `parentSession` / `seedLength` metadata. |
| `fork({ source, sessionId? })` | Create a live child session from `snapshot(source)`, using the caller-supplied child id or the session store's generated id. |

## Boundary Rule

A source is forkable only when its log is empty or its last event is `turn/end`. The service accepts any turn-end reason, including `aborted`, `error`, `disposed`, `max-tokens`, and crash-repaired `interrupted`; the boundary is structural, not a statement that the prior turn was successful.

Forking inside a turn is rejected with `SessionForkError` code `OPEN_TURN`. The service intentionally does not clip to an older completed prefix; that behavior is specific to `dsh-subagent-fork`, where tool-time delegation normally happens while the parent turn is open.

## Errors

| Code | Meaning |
|---|---|
| `SESSION_NOT_FOUND` | A source id is not live in `ctx.sessions`, or a passed `Session` object's id is not live in the store. |
| `SESSION_NOT_LIVE` | A passed `Session` object has a live id in the store, but it is not that live store instance. |
| `SESSION_ALREADY_EXISTS` | The requested child `sessionId` is already live in `ctx.sessions`. |
| `OPEN_TURN` | The source log is non-empty and does not end at `turn/end`. |

## Persistence

Forked sessions use existing session metadata: `parentSession` points to the source session id, `seedLength` is the number of inherited events, and `cwd` is inherited when present. Persistence backends observe the forked child through their existing `session/created` and `session/flush` write path, so no backend-specific fork API is needed.
