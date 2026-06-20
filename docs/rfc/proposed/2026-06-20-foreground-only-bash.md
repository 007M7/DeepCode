# RFC: Make the bash tool foreground-only

Status: proposed

## Problem

The bash capability seam supports both foreground commands and long-running background tasks. Background support is large: the abstract executor exposes `start`, `get`, `ownerOf`, `list`, `readOutput`, `kill`, and `onTaskDone`; the local executor tracks tasks, incremental reads, owner tokens, process cleanup, and completion listeners; the model sees three tools (`bash`, `bash_output`, `bash_kill`); the tool plugin injects completion notices back into the owning agent's session. The local executor fences task access behind owner tokens because predictable global task ids are a cross-session read/kill hazard.

The [tool cookbook](../../cookbook/adding-a-tool.md) already points at the real design smell: background bash is really generic long-running-tool infrastructure living inside one tool. If future tools need background execution, polling, kill, ownership, and completion notices, those semantics should not be hidden in `dsh-bash`.

## Proposal

Temporarily collapse `bash` to foreground-only execution. Remove the model-facing `run_in_background` schema field, the `bash_output` and `bash_kill` tools, background task ownership, incremental task reads, completion injection, and task-listener APIs from the bash executor seam. The `BashExecRequest` request type is already foreground-shaped; the removal surface is the tool schema plus the executor's background-task methods. Long commands can still run with an explicit timeout; a command that needs to outlive a model step is not supported until a generic task service exists.

If long-running tasks return later, implement them once as a capability-agnostic task layer that owns ids, authorization, polling, cancellation, completion notifications, and any UI affordances. Bash can then opt into that layer like any other tool.

## Acceptance criteria

- `@deepseek-ai/dsh-tool-bash` registers only the `bash` tool.
- `BashExecutor` exposes `resolve()` and foreground `run()` only.
- `@deepseek-ai/dsh-bash-local` no longer tracks background task maps, owner tokens, task listeners, or incremental output cursors.
- ACP and snapshot fixtures no longer mention `bash_output` or `bash_kill`.
- The [tool cookbook](../../cookbook/adding-a-tool.md) either removes the background example or redirects long-running work to a future generic task proposal.

## What we give up

The model loses the ability to start a server or long-running command, continue other work, and poll later. That is a real capability regression, but the current design makes one tool carry infrastructure that belongs above all tools. Foreground-only bash is smaller, safer, and easier to sandbox while the generic long-running-tool design is still absent.
