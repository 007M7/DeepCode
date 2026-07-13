/**
 * Model-facing whole-list replacement. Each call appends a `todo/write` snapshot to the calling
 * agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
 * caller has no owning list and is rejected. Named exports preserve loader injection metadata.
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
 * Validate the value constraints the SchemaSpec can't express and build the canonical {@link
 * TodoItem}[]: trimmed non-empty unique content and at most one in-progress item. The registry
 * has already enforced the status enum; the cast below records that guarantee.
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
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}
