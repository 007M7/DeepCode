# timeout/ — tool-call timeout policy

English | [中文](README.zh.md)

The tool-call timeout policy plugin. A single **product** package: it is a deployment-policy consumer of the `tools/execute` around-dispatch seam (owned by [`dsh-tools`](../core/tools)) and the pure [`dsh-timeout`](../util/timeout) library — not a swappable capability with an interface/implementation split, so it needs no seam trio.

| Package | Role | ctx key |
|---|---|---|
| `timeout-policy/` | A `tools/execute` wrapper: for each configured tool it arms a per-call deadline on `exec.signal` and returns a structured `TOOL_TIMEOUT` result when that deadline wins | (registers a `tools/execute` listener; injects nothing) |

Timeout is split across three layers: [`dsh-timeout`](../util/timeout) owns the pure timing/classification primitive (`deadline`/`timeoutOf`), each capability owns termination (bash kills its process group, the fetch provider tears down its socket), and this package owns the *model-facing tool-call budget as deployment policy* — no model-facing timeout argument, no global default. It is the middleware the [timeout-library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) foresaw. `bash` and hook command execution keep their own `BASH_TIMEOUT` backend timeout and do not route through this policy.
