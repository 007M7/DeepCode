# RFC: Extract a generic long-running tool runtime

Status: proposed

## Problem

The bash capability seam supports both foreground commands and long-running background tasks. Background support is large: the abstract executor exposes `start`, `get`, `ownerOf`, `list`, `readOutput`, `kill`, and `onTaskDone`; the local executor tracks tasks, incremental reads, owner tokens, process cleanup, and completion listeners; the model sees three tools (`bash`, `bash_output`, `bash_kill`); the tool plugin injects completion notices back into the owning agent's session. The local executor fences task access behind owner tokens because predictable global task ids are a cross-session read/kill hazard.

The [tool cookbook](../../../cookbook/adding-a-tool.md) already points at the real design smell: background bash is really generic long-running-tool infrastructure living inside one tool. If future tools need background execution, polling, kill, ownership, and completion notices, those semantics should not be hidden in `dsh-bash`.

## Proposal

Move long-running task semantics above bash into a tool-agnostic runtime. Bash remains able to run background commands, but it stops owning the general concepts of task ids, ownership tokens, polling, cancellation, completion notifications, and model-facing "read/kill this task" commands.

The runtime should own:

- Stable task ids and owner tokens keyed to the calling session/agent.
- Registration of a long-running task with a producer for incremental output and a completion promise.
- Generic read/cancel/list operations with the same cross-session authorization rule for every tool.
- Completion notification injection into the owning session.
- Presentation hooks for pending/running/completed task state, with bash supplying only command-specific labels and output formatting.

`dsh-bash` then keeps the bash-specific execution contract: resolve a request into a command spec, run a foreground command, or start a process and hand its streams/process handle to the generic runtime. `dsh-tool-bash` keeps the model-facing command tool, but the follow-up operations become generic long-running-tool operations or a shared utility that bash registers with, rather than bespoke `bash_output`/`bash_kill` plumbing.

## Current seam consumption

A consumer census of the surface the runtime would carve up. Production has two seam consumers: `packages/bash/tool-bash/src/index.ts` consumes `resolve`, `run`, `start`, `ownerOf`, `readOutput`, `kill`, and `onTaskDone`; and the hook bridges — via `dsh-hook-protocol`'s `runHook` (`packages/hooks/hook-protocol/src/runner.ts`) — consume `resolve` + `run` only, a foreground-only trusted-plugin caller that sets the seam's `stdin`/`env` fields, so the background machinery stays single-consumer (which sharpens the extraction premise). `get()`/`list()` have test-harness consumers only — they were removed once and reverted on the merits (the implementation note in [prune dead methods from the persistence seam](../../implemented/simplification/2026-06-20-prune-dead-seam-methods.md) records the test-migration cost dwarfing the surface removed). The per-task `BashTask.done` promise has no consumer through the public seam either (`dsh-tool-bash` completes via `onTaskDone`), but it is production-load-bearing INSIDE the implementation: `dsh-bash-local`'s disposal awaits it to reach quiescence. The seam therefore exposes two public completion representations — the per-task promise and the global `onTaskDone` listener registry — and the shipped consumers use only the latter: the runtime should pick exactly one public completion surface and record which. Two shape facts for the split to dissolve or preserve deliberately: `BashExecSpec.timeoutMs` is required but ignored by `start()` (documented in the seam JSDoc itself), and `stdin`/`env` ride the shared spec for the foreground trusted-plugin path — the carve-up must keep a plain in-process foreground `resolve`+`run` path carrying them, so hook execution is never forced through the long-running runtime. Adjacent blast radius: the credential scrub is duplicated between the two production spawn sites (`packages/bash/bash-local/src/run.ts` and `packages/subagent/subagent-acp/src/run.ts`); if the runtime absorbs spawn-env policy, collapsing that duplication is its work too.

## Acceptance criteria

- The bash-specific packages no longer define the generic task registry, owner-token authorization, polling, cancellation, or completion-notification machinery.
- A shared long-running-task service or tool layer owns those semantics and is documented as the path for any future background-capable tool.
- Bash background behavior remains available through the shared layer, with tests proving cross-session isolation still holds.
- ACP and snapshot fixtures render background bash through the shared task vocabulary, not through bash-only lifecycle semantics.
- The [tool cookbook](../../../cookbook/adding-a-tool.md) points long-running tools at the shared runtime instead of telling each tool to invent its own task protocol.

## Risks

The bash package loses local ownership of an already-working background-task implementation, and the implementing PR may temporarily churn model-facing tool names or transcript presentation. That churn is worthwhile if it leaves one background-task contract instead of making every future long-running tool clone bash's private protocol.

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
