# session-projection/

English | [中文](README.zh.md)

Session-projection capability family: the seam through which domain host plugins serve whole current values of log-derived per-session state to client carriers.

| Package | ctx key | Role |
|---|---|---|
| [`session-projection`](session-projection/README.md) | `sessionProjections` | The interface package: the merge-extensible `SessionProjectionMap` type table, the `ProjectionDefinition` unit contract, and the eagerly driven registry carriers read synchronously |
| [`session-projection-cache`](session-projection-cache/README.md) | `sessionProjectionCache` | Persisted projection cache: durable per-session unit checkpoints over the domain data form, throttled write-behind with mandatory turn/end + detach points, and the cold-read ladder (cache row + persistence tail replay) |
