/**
 * The model-facing `todo_write` tool: the agent's whole task list, replaced
 * wholesale on each call. Every call appends a `todo/write` event (the full
 * list snapshot) to the calling agent's session log via
 * `exec.agent.session.append('todo/write', { todos })`; the current list is the
 * most recent such event (last-write-wins on replay). UIs render off
 * `session/event`: the stdio UI prints the checklist, the ACP bridge maps it to
 * a `plan` sessionUpdate.
 *
 * Single owner: the list belongs to the ONE agent session that called the tool.
 * There is no subagent/shared/swarm scope — a non-agent caller (no
 * `exec.agent`) has nowhere to write the list and is rejected.
 *
 * Plugin export shape: named exports, NO default. The cordis Loader's
 * `unwrapExports` does `exports.default ?? exports`, so a stray default would
 * collapse the module to the bare `apply` and drop `inject`, crashing at load
 * (see docs/postmortem/0001).
 *
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from '@deepseek-ai/dsh-session'

export const name = 'tool-todo'
export const inject = ['tools']

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

const DESCRIPTION =
  'Record and update a structured task list for the current work. Send the ENTIRE '
  + 'list every call — it REPLACES the previous list (there are no partial updates, '
  + 'no per-item edits). Use it to plan multi-step work and show progress: add one '
  + 'todo per concrete step before you start. Keep AT MOST ONE todo `in_progress` '
  + 'at a time; while work remains, exactly one active task should be '
  + '`in_progress`. Mark a todo `completed` the moment it is done (do not batch '
  + 'completions), and allow no `in_progress` item only once all work is complete. '
  + 'Skip the list for trivial single-step tasks. Statuses: `pending` '
  + '(not started), `in_progress` (being worked on now), `completed` (finished).'

/**
 * Validate the value constraints the SchemaSpec can't express and build the
 * canonical {@link TodoItem}[].
 *
 * `defineTool` already validates type/required/enum before `execute` runs (a
 * bad `status` is rejected by the registry's `validateArgs`, never reaching
 * here), so `status` is guaranteed to be one of the three enum literals. But
 * `InferArgs` maps an `enum` string prop to plain `string`, so the compiler sees
 * `args.todos` as `{ content: string; status: string }[]`; the
 * `status as TodoItem['status']` narrowing records that registry guarantee
 * rather than re-checking it (an unreachable re-check would be dead code — see
 * AGENTS.md "don't validate scenarios that can't happen"). What remains is the
 * value rules the DSL has no vocabulary for: non-empty unique content (stored
 * trimmed, so the persisted value matches the dedupe/length key), and at most
 * one `in_progress` task.
 */
function toTodoList(raw: { content: string; status: string }[]): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let inProgress = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    const status = item.status as TodoItem['status']
    if (status === 'in_progress') inProgress++
    todos.push({ content, status })
  }
  if (inProgress > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress, got ${inProgress}`)
  }
  return todos
}

/** Register the `todo_write` tool on `ctx.tools`. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: DESCRIPTION,
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    execute(args, exec): Promise<ContentBlock[]> {
      const todos = toTodoList(args.todos)
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return Promise.resolve([{
        type: 'text',
        text: `Updated todo list: ${count('pending')} pending, ${count('in_progress')} in progress, ${count('completed')} completed.`,
      }])
    },
    presentCall: args => ({ title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}
