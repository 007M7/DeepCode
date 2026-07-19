# @deepseek-ai/dsh-tool-todo

The model-facing `todo_write` tool: the agent's whole task list, replaced wholesale on each call.

## What it does

Registers one tool, `todo_write(todos: [{ content, status }])`, on `ctx.tools`. The model sends the ENTIRE list every call — there are no partial updates or per-item edits. Each call appends a `todo/write` event (the full list snapshot) to the calling agent's session log via `agent.session.append('todo/write', { todos })`; the current list is the most recent such event (last-write-wins on replay).

`status` is one of `pending`, `in_progress`, `completed` — exactly the ACP `PlanEntryStatus` triple.

## Single owner

The list belongs to the ONE agent session that called the tool. There is no subagent/shared/swarm scope: a non-agent caller (no `exec.agent`) has nowhere to write the list and is rejected. This is a deliberate scope limit — see the RFC.

## Validation

Beyond the schema's type/required/enum checks, `execute` rejects an empty or duplicate `content` and more than one `in_progress` task (a coherent plan has at most one task active). Ordering and the discipline of keeping the list current are left to the model via the tool description.

## Rendering

The tool writes only the session event; it does not render. UIs subscribe to `session/event` and render the `todo/write` data themselves: the [terminal app](../../examples/stdio-demo) shows a persistent TUI plan or readline checklist, and the [ACP bridge](../../ui/acp) maps the list to a `plan` sessionUpdate (synthesizing the `priority` ACP requires).

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

**What the model sees**: The model sees the generated [`todo_write` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo).

**Token effect**: Fixed schema cost on every request where the tool is visible.

### Tool-call history and result

**What the model sees**: Each assistant tool call retains the entire replacement list in its arguments. Success returns exactly `Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.` Stable failures are ``Error: invalid todo: `content` must be a non-empty string``, `Error: invalid todos: duplicate content "<content>"`, `Error: invalid todos: at most one task may be in_progress, got <count>`, and `Error: todo_write requires an owning agent session`. The full `todo/write` session event is UI and replay state, not a second model message.

**Token effect**: Token growth scales with every full list the model submits, and those call arguments remain until compaction. The result itself is small and fixed-shape.

## Known Limitations and Deferred Work

- **Single-owner scope only** — the list belongs to the one calling agent session; subagent/shared/swarm scopes are a deliberate cut (see § Single owner), and a non-agent caller is rejected.
- **The item shape is deliberately minimal** — `content` plus three-state `status`; no id, priority, or active-form fields, and the ACP bridge synthesizes the `priority` ACP requires.
- **Whole-list replacement is the only operation** — no partial updates, no read-back tool; the model must resend the entire list each call.
