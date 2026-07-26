# subprocess/ — subprocess capability family

English | [中文](README.zh.md)

The shared home for spawning managed child-process groups: fully-specified spawn specs, bounded tail-keep output with spill files, credential-scrubbed environments, offset-based incremental reads, and SIGTERM→grace→SIGKILL group kills. Command defaulting, shell semantics, deadlines, and presentation stay with consumers — the [bash executor family](../bash/README.md) is the first and owning consumer. See the [subprocess seam Agent Note](../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md).

| Package | ctx key | Role |
|---|---|---|
| [`subprocess`](subprocess/README.md) (`@deepseek-ai/dsh-subprocess`) | `ctx.subprocess` | The seam: abstract `SubprocessService.spawn(spec)`, the fully-explicit `SubprocessSpawnSpec`, `SubprocessHandle` with offset-based readers, and the shared `DSH_*` managed-environment and `CollectedOutput` vocabulary |
| [`subprocess-local`](subprocess-local/README.md) (`@deepseek-ai/dsh-subprocess-local`) | — | The local implementation: detached process groups, tail-keep truncation with bounded private spill files, the credential scrub and `DSH_*` merge order, kill escalation, and kill-and-join disposal |

The service owns process lifetime across consumer reloads; consumers own what a process means (a bash command, a future non-shell runner) and every default that shapes one.
