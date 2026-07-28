# Agent Note: The subprocess service is its own seam under the bash executors (`dsh-subprocess` / `dsh-subprocess-local`)

Status: implemented

English | [中文](2026-07-26-subprocess-seam.zh.md)

## Problem

`dsh-bash-local` bundled two capabilities that change for different reasons: *running a bash command* (command defaulting, timeout classification, model-friendly terminal environment, the stdout/stderr merge the bash tool renders) and *running and managing a child process* (detached process groups, bounded tail-keep output with spill files, the credential scrub and `DSH_*` merge order, SIGTERM→grace→SIGKILL escalation, kill-and-join disposal). The process half — `run.ts`, roughly half the package — had no seam of its own: a future non-shell runner (a direct-argv executor, a worker supervisor) would have to re-implement or reach into bash internals, and the shared `DSH_*`/`CollectedOutput` vocabulary lived in a package whose name promises shell semantics. The bundling also tied background-process lifetime to the executor's fiber: reloading the bash executor killed every live background process, unlike the sibling [task registry](2026-07-26-task-registry-seam.md), whose registrations deliberately outlive producer fibers.

## Decision

A new `subprocess/` capability family owns "run and manage a process"; the bash family keeps "run a bash command" and consumes it:

- **`@deepseek-ai/dsh-subprocess` (interface)** — the abstract `SubprocessService` owning `ctx.subprocess`: execution-world cwd and runtime storage, executable lookup, fully explicit ordinary spawns, and the terminal primitive added by the [portable execution-world decision](2026-07-28-portable-execution-world-consumers.md). Its vocabulary includes per-stream stdio dispositions, process and terminal handles, exit facts with deliberately no timeout/cancel classification, and the shared scrub plus `DSH_ENV_PREFIX`/`DshEnvironment`/`CollectedOutput` types. `argv` is never shell-interpreted.
- **`@deepseek-ai/dsh-subprocess-local` (implementation)** — `LocalSubprocessService` over the former `run.ts` plumbing (`spawn.ts`) plus `node-pty`: detached groups, bounded collection and private spill files, executable lookup, private runtime storage, foreground/session inspection, credential scrub with explicit env merged after it, tree cleanup, and disposal that terminates and joins every managed process. It has no config; every limit arrives on the spec. Bash and PTY presentation environment overrides stay in their consumers.
- **`dsh-bash-local` (consumer)** — `inject: ['subprocess']`; maps each resolved `BashExecSpec` onto a `SubprocessSpawnSpec` (`['bash', '-c', command]`), keeps its config, `resolve()` defaulting, fused-deadline `timedOut`/`aborted` classification, the `[stderr]`-marked background read merge with its consuming cursor, and the `onProcessDone` subclass hook. `dsh-bash-sandbox` is unchanged apart from redeclaring the inherited inject; it still wraps at the command-string level and re-enters the inherited spawn path.
- **`dsh-bash` (seam)** — re-exports the moved vocabulary from `dsh-subprocess`, so no bash consumer changes an import; `BashExecRequest`/`BashExecSpec`/`BashProcess` and the sandbox facts remain bash-owned.

Every composition that loads a bash executor now also loads `@deepseek-ai/dsh-subprocess-local` (CLI, examples, python bundled runtime, create-sdk's bash feature resources, inline test configs).

Background-process lifetime moved from the executor to the subprocess service: the executor no longer retains a live-process set, so an executor reload leaves background work running and readable, and composition teardown (the service's disposal) remains the kill-and-join boundary. One behavioral seam shifted with it: a background spawn failure can no longer be buffered as fake stderr inside the plumbing (the service rejects `done` and buffers nothing for a process that never ran), so the executor injects the `spawn failed: …` note into exactly one `readOutput()` delta.

## Alternatives considered

**Leave the process plumbing inside `dsh-bash-local` (status quo).** Rejected for the same reason the [task registry split](2026-07-26-task-registry-seam.md) landed: the boundary is stable and already documented in-code (`run.ts`'s module doc said "this layer reacts to an abort signal; the executor owns deadlines and classifies causes"), and keeping it private makes every future non-shell runner either fork the mechanics or depend on a bash-named package for non-bash work. The user-visible driver for this stack was exactly this split.

**Migrate the repo's other spawn sites in the introducing change.** Rejected as scope creep with real design risk at that scale. The later [consumer-migration](2026-07-26-subprocess-consumer-migration.md) and [portable execution-world](2026-07-28-portable-execution-world-consumers.md) decisions reshape the interface around the observed LSP, subagent, PTY, and Code Runtime consumers; SDK and test-support launchers remain outside by ownership.

**Put `run_in_background`/task semantics into the process seam instead.** Rejected: that boundary already exists — `ctx.tasks` owns ids, ownership, and notices, and the bash tool adapts a `BashProcess` into task hooks. The process seam sits *below* the bash executor, not beside the task registry.

**Move `ENV_OVERRIDES` (TERM=dumb, PAGER=cat …) into the subprocess service.** Rejected: a generic subprocess service must not impose terminal presentation policy on non-terminal consumers; the ambient scrub (credential-shaped and `DSH_*` names) is a security/identity invariant and stays, but terminal friendliness is the bash tool's choice, expressed through the spec's explicit env where a caller's own entry still wins.

## Consequences

Bought: "run and manage a process" is a swappable capability used by Bash, LSP, PTY, Code Runtime, and ACP consumers; a containerized or remote process backend slots in without changing their domain semantics; the shared `DSH_*`/output vocabulary has a non-shell home; and background processes survive executor reloads, matching the task registry's lifetime model. Process and terminal plumbing is tested through `dsh-subprocess-local`; consumer suites pin only their owned behavior against the real service.

Cost: one more package pair and one more composition row everywhere a bash executor loads — a boot that loads an executor without the subprocess service leaves `ctx.bash` pending on `ctx.subprocess` (standard missing-service behavior). The moved-vocabulary re-exports keep `dsh-bash` imports working but mean two packages now name the same types; the subprocess seam is the owner and the bash seam documents the re-export. The spawn-failure note became single-delivery through the read path where the old plumbing retained it in the stderr buffer for repeated `readFrom(0)` reads — acceptable because the bash background read path was already a consuming cursor, and the note reaches the one reader that exists.
