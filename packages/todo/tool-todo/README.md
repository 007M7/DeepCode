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

The tool writes only the session event; it does not render. UIs subscribe to `session/event` and render the `todo/write` data themselves: the [stdio app's readline UI](../../ui/stdio-agent) prints a glyphed checklist, and the [ACP bridge](../../ui/acp) maps the list to a `plan` sessionUpdate (synthesizing the `priority` ACP requires).

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).
