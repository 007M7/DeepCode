# session-registry/ — live-session registry family

English | [中文](README.zh.md)

Which sessions are running right now, readable from a different process. `dsh list-sessions` is the consumer.

| Package | Role | ctx key |
|---|---|---|
| [`session-registry/`](session-registry/README.md) | The seam: abstract registry service contract and record vocabulary | `ctx.sessionRegistry` |
| [`session-registry-file/`](session-registry-file/README.md) | Backend: one lock-guarded JSON file, pid-derived liveness | — |
| [`session-registry-live/`](session-registry-live/README.md) | Publisher: follows session lifecycle and title events, keeping the registry in step | — |

The split follows the three-package capability-seam convention: the seam answers "what is live" for a short-lived reader that mounts nothing else, the file backend owns today's medium and can be replaced by a database without touching consumers, and the publisher needs the session store and runs inside a full agent composition. Liveness is derived from the recorded pid at read time rather than stored, so a killed process leaves nothing to clean up. Records carry their own title because log location, format, and compression are per-deployment backend choices an independent reader cannot portably parse.

This family is independent of session persistence: it records which processes hold which sessions, never conversation content, and a session that is never persisted still lists.
