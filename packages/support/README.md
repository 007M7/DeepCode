# support/ — dev/test/example infrastructure

English | [中文](README.zh.md)

Packages that exist to serve development, testing, and the examples rather than to ship as product API. They are real workspace packages (typed, tested, under the coverage gate), but they carry **lower compatibility expectations**: they may change or be removed when the development need behind them does, without the deprecation care a product package would warrant.

| Package | Role | ctx key |
|---|---|---|
| `acp-snapshot/` | ACP test kit: shared subprocess/client launcher + snapshot harness, normalizers, and suite factory | (library — imported by ACP e2e and `*.snapshot.ts` suites) |
| `agent-loop-testkit/` | Shared prerequisite mounting for tests that exercise the concrete agent loop | (library — imported by AgentLoop integration tests) |
| `invariants/` | Runtime event-contract assertions for development diagnostics | (listens on `session/*`, `agent/*`) |
| `loader-smoke/` | Shared real-Loader subprocess harness for keyless example smokes | (library — imported by example e2e suites) |
| `llm-mock-server/` | Scriptable OpenAI-compatible HTTP/SSE fault server + CLI for LLM recovery tests | (standalone server and test library) |
| `llm-replay/` | Record/replay adapter: short-circuits `llm/stream` from a recorded session JSONL (keyless snapshot tests) | (listens on `llm/stream`) |

`invariants` is development support but has no environment guard: it runs wherever registered, and the default `dsh-agent-spine-demo` bundle mounts it unconditionally. `agent-loop-testkit` centralizes the mandatory service spine for hand-built AgentLoop tests without owning their loop or scenario. `llm-replay` backs the demos and the snapshot test tier under the per-file coverage gate, while `llm-mock-server` drives real provider adapters through deterministic HTTP/SSE faults. `acp-snapshot` carries the ACP subprocess/client boundary plus the snapshot harness, normalizers, and suite machinery, while `loader-smoke` owns the parallel real-Loader launch boundary used by keyless example e2e suites. A package graduates OUT of `support/` into a product group only when it gains documented product consumers.
