# Agent Note: The process manager is its own seam under the bash executors (`dsh-process` / `dsh-process-local`)

Status: implemented

English | [中文](2026-07-26-process-manager-seam.zh.md)

## Problem

`dsh-bash-local` bundled two capabilities that change for different reasons: *running a bash command* (command defaulting, timeout classification, model-friendly terminal environment, the stdout/stderr merge the bash tool renders) and *running and managing a child process* (detached process groups, bounded tail-keep output with spill files, the credential scrub and `DSH_*` merge order, SIGTERM→grace→SIGKILL escalation, kill-and-join disposal). The process half — `run.ts`, roughly half the package — had no seam of its own: a future non-shell runner (a direct-argv executor, a worker supervisor) would have to re-implement or reach into bash internals, and the shared `DSH_*`/`CollectedOutput` vocabulary lived in a package whose name promises shell semantics. The bundling also tied background-process lifetime to the executor's fiber: reloading the bash executor killed every live background process, unlike the sibling [task registry](2026-07-26-task-registry-seam.md), whose registrations deliberately outlive producer fibers.

## Decision

A new `process/` capability family owns "run and manage a process"; the bash family keeps "run a bash command" and consumes it:

- **`@deepseek-ai/dsh-process` (interface)** — the abstract `ProcessManager` owning `ctx.processes` with one method, `spawn(spec): ProcessHandle`, and the shared vocabulary: the fully-explicit `ProcessSpawnSpec` (argv, cwd, per-stream caps, spill cap, grace — no defaults; deployment-varying knobs stay with the calling seam's config, per the `dsh-bash` request/spec template and the no-hidden-defaults rule), `ProcessHandle` with non-consuming offset-based readers, `ProcessOutcome` with deliberately no timeout/cancel classification, and the `DSH_ENV_PREFIX`/`DshEnvironment`/`CollectedOutput` types. `argv` is never shell-interpreted.
- **`@deepseek-ai/dsh-process-local` (implementation)** — `LocalProcessManager` over the former `run.ts` plumbing (`spawn.ts`): detached groups, tail-keep truncation with private bounded spill files, credential scrub with the two-channel `DSH_*` merge, group kill escalation, and disposal that kills and joins every still-running managed process. It has no config; every limit arrives on the spec. The terminal `ENV_OVERRIDES` (`TERM=dumb` etc.) did NOT move — that is bash-tool presentation policy and stays in `dsh-bash-local`, merged through the ordinary env channel.
- **`dsh-bash-local` (consumer)** — `inject: ['processes']`; maps each resolved `BashExecSpec` onto a `ProcessSpawnSpec` (`['bash', '-c', command]`), keeps its config, `resolve()` defaulting, fused-deadline `timedOut`/`aborted` classification, the `[stderr]`-marked background read merge with its consuming cursor, and the `onProcessDone` subclass hook. `dsh-bash-sandbox` is unchanged apart from redeclaring the inherited inject; it still wraps at the command-string level and re-enters the inherited spawn path.
- **`dsh-bash` (seam)** — re-exports the moved vocabulary from `dsh-process`, so no bash consumer changes an import; `BashExecRequest`/`BashExecSpec`/`BashProcess` and the sandbox facts remain bash-owned.

Every composition that loads a bash executor now also loads `@deepseek-ai/dsh-process-local` (CLI, examples, python bundled runtime, create-sdk's bash feature resources, inline test configs).

Background-process lifetime moved from the executor to the manager: the executor no longer retains a live-process set, so an executor reload leaves background work running and readable, and composition teardown (the manager's disposal) remains the kill-and-join boundary. One behavioral seam shifted with it: a background spawn failure can no longer be buffered as fake stderr inside the plumbing (the manager rejects `done` and buffers nothing for a process that never ran), so the executor injects the `spawn failed: …` note into exactly one `readOutput()` delta.

## Alternatives considered

**Leave the process plumbing inside `dsh-bash-local` (status quo).** Rejected for the same reason the [task registry split](2026-07-26-task-registry-seam.md) landed: the boundary is stable and already documented in-code (`run.ts`'s module doc said "this layer reacts to an abort signal; the executor owns deadlines and classifies causes"), and keeping it private makes every future non-shell runner either fork the mechanics or depend on a bash-named package for non-bash work. The user-visible driver for this stack was exactly this split.

**Migrate the repo's other spawn sites (lsp-local, pty-local, subagent-subprocess, sdk package-manager, test-support launchers) onto `ctx.processes` in the same change.** Rejected as scope creep with real design risk: those sites have materially different stream and lifecycle needs — node-pty ownership (pty), LSP framing over long-lived stdio with tree-kill fallbacks (lsp), stdin-EOF-first disposal ladders and no output buffering (subagent transports) — and forcing them under a handle shaped for bounded batch output would either bloat the seam or misfit the consumers. The seam ships proven against its one real consumer family, per the shape-interfaces-around-current-consumers rule; the others are named as deferred work in the seam README.

**Put `run_in_background`/task semantics into the process seam instead.** Rejected: that boundary already exists — `ctx.tasks` owns ids, ownership, and notices, and the bash tool adapts a `BashProcess` into task hooks. The process seam sits *below* the bash executor, not beside the task registry.

**Move `ENV_OVERRIDES` (TERM=dumb, PAGER=cat …) into the manager.** Rejected: a generic process manager must not impose terminal presentation policy on non-terminal consumers; the scrub and `DSH_*` channel rules are security/identity invariants and stay, but terminal friendliness is the bash tool's choice, expressed through the ordinary env channel where an explicit caller entry still wins.

## Consequences

Bought: "run and manage a process" is a swappable capability with the standard three-package shape (consumer count starts at two: `bash-local`, `bash-sandbox`); a containerized or remote process backend slots in without touching bash semantics; the shared `DSH_*`/output vocabulary has a non-shell home; and background processes survive executor reloads, matching the task registry's lifetime model. The spawn plumbing suite moved wholesale to `dsh-process-local` (argv-based, plus argv-validation and manager lifecycle/disposal suites); the executor suite now pins the bash-owned layers (classification, merge, spawn-failure note, manager-owned lifetime) against the real manager.

Cost: one more package pair and one more composition row everywhere a bash executor loads — a boot that loads an executor without the manager leaves `ctx.bash` pending on `ctx.processes` (standard missing-service behavior). The moved-vocabulary re-exports keep `dsh-bash` imports working but mean two packages now name the same types; the process seam is the owner and the bash seam documents the re-export. The spawn-failure note became single-delivery through the read path where the old plumbing retained it in the stderr buffer for repeated `readFrom(0)` reads — acceptable because the bash background read path was already a consuming cursor, and the note reaches the one reader that exists.
