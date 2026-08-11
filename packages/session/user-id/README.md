# @deepseek-ai/dsh-user-id

English | [中文](README.zh.md)

Shared anonymous identity for session telemetry and direct feedback acknowledgement. `getOrCreateAnonymousUserId()` returns a random UUID v4 scoped to one harness home, persisted as the bare line `$DSH_HOME/.userid` (`~/.dsh/.userid` when `DSH_HOME` is unset). The OpenTelemetry backend reports it as Resource `user.id`; `/feedback` includes the same value in its acknowledgement so an operator can correlate a submitted session and user with exported telemetry.

The identity is never derived from the hostname, network address, git remote, or another identifying source. Deleting `.userid` resets the identity on the next process launch. Separate harness homes have separate identities.

## Storage contract

Reads and writes are synchronous because both boot-time telemetry construction and direct command execution need one API. The result is memoized per resolved file path for the process lifetime. A first writer uses exclusive creation and a concurrent loser adopts the persisted winner; a corrupt file is replaced. Persistence is best-effort, so an unwritable home still receives a process-local UUID rather than blocking telemetry or feedback.

## Composition

This package is a shared library, not a Cordis plugin. Consumers import `getOrCreateAnonymousUserId()` directly. Its invariant companion is intentionally empty because the package owns no event stream or public mutable relation that can be checked without creating the identity as a side effect.

## Model Experience

None, as the identifier is used only in telemetry metadata and a direct human command response; it never enters a model request.

#### KV Cache effect

None; this package never contributes to a model request.

## Known Limitations and Deferred Work

- **No recovery after deletion** — loss mints a new anonymous identity by design; recovery would require stable derivation material that weakens anonymity.
- **Best-effort concurrency** — a reader landing in the narrow interval between a concurrent process's exclusive create and completed write can use a different in-memory UUID for that run; later launches converge on the persisted value.
- **No cross-home identity** — different `$DSH_HOME` values cannot be correlated.
