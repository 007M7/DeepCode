# subprocess/ — subprocess capability family

English | [中文](README.zh.md)

The shared home for spawning managed child-process trees: fully-specified spawn specs with Node-shaped per-stream stdio dispositions (raw pipes, inherit, bounded tail-keep collection with spill files), the one credential scrub every harness spawner uses, offset-based incremental reads, tree-scoped signalling with SIGTERM→grace→SIGKILL escalation, and the cooperative dispose ladder. Command defaulting, shell semantics, deadlines, protocol framing, and presentation stay with consumers — the [bash executors](../bash/README.md), the [LSP host](../lsp/README.md), and the [ACP subagent backend](../subagent/README.md). See the [subprocess seam Agent Note](../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md).

| Package | ctx key | Role |
|---|---|---|
| [`subprocess`](subprocess/README.md) (`@deepseek-ai/dsh-subprocess`) | `ctx.subprocess` | The seam: abstract `SubprocessService.spawn(spec)`, the fully-explicit `SubprocessSpawnSpec` with per-stream stdio dispositions, `SubprocessHandle` (streams, offset-based readers, terminate/waitForExit/dispose), and the shared scrub + `DSH_*`/`CollectedOutput` vocabulary |
| [`subprocess-local`](subprocess-local/README.md) (`@deepseek-ai/dsh-subprocess-local`) | — | The local implementation: detached process trees, per-disposition stream wiring, tail-keep truncation with bounded private spill files, the `DSH_*` merge order, tree signalling with escalation, the dispose ladder, and terminate-and-join disposal |
| [`subprocess-e2b`](subprocess-e2b/README.md) (`@deepseek-ai/dsh-subprocess-e2b`) | — | Experimental E2B implementation: remote Linux process groups and spill state in the shared `ctx.e2b` sandbox, with asynchronous PID acquisition and SDK buffering limitations |

The service owns process lifetime across consumer reloads; consumers own what a process means (a bash command, a future non-shell runner) and every default that shapes one.
