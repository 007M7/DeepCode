# support/ — dev/test/example infrastructure

Packages that exist to serve development, testing, and the examples rather than to ship as product API. They are real workspace packages (typed, tested, under the coverage gate), but they carry **lower compatibility expectations**: they may change or be removed when the development need behind them does, without the deprecation care a product package would warrant.

| Package | Role | ctx key |
|---|---|---|
| `acp-snapshot/` | ACP snapshot suite kit: subprocess scenario harness + golden normalizers + the `defineAcpSnapshotSuite` factory | (library — imported by example `*.snapshot.ts` suites) |
| `invariants/` | Dev-mode event-contract invariants + session-log freeze | (listens on `session/*`, `agent/*`) |
| `llm-replay/` | Record/replay adapter: short-circuits `llm/stream` from a recorded session JSONL (keyless snapshot tests) | (listens on `llm/stream`) |
| `subagent-mock/` | Scripted `SubagentProvider` for deterministic seam/tool tests | (registers on `ctx.subagents`) |

`invariants` runs only in dev mode (contract checks, not runtime behavior). `llm-replay` backs the demos and the snapshot test tier under the per-file coverage gate. `acp-snapshot` carries the snapshot tier's harness/normalizer/suite machinery so every example's suite is a scenario table over one shared, gate-covered implementation. `subagent-mock` exercises the real `ctx.subagents` load path without a model or child agent. A package graduates OUT of `support/` into a product group only when it gains documented product consumers.
