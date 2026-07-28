/**
 * Model-facing whole-list replacement. Each call appends a `todo/write` snapshot to the calling
 * agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
 * caller has no owning list and is rejected. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from 'cordis'
import { z } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

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
 * Validate the value constraints the ParameterSchemaSpec can't express and build the canonical {@link
 * TodoItem}[]: trimmed non-empty unique content and at most one in-progress item. The registry
 * has already enforced the status enum and rejected unknown item keys (`additionalProperties:
 * false` — the logged snapshot must equal what the model believes it wrote, so a nested/extended
 * item shape fails loud at the schema boundary instead of silently flattening); the cast below
 * records that guarantee.
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

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = z.union([
  z.array(z.object({
    content: z.string(),
    status: z.union([z.literal('pending'), z.literal('in_progress'), z.literal('completed')]),
  })),
  z.null(),
])

/** Register the `todo_write` tool on `ctx.tools` and, when the session-projection seam is composed, the `todos` unit. */
export function apply(ctx: Context): void {
  // The unit child activates only when a projection registry is composed
  // (headless assemblies without the seam stay unaffected). Standing-plan fold:
  // latest whole todo/write list, cleared by the next turn/start (turn/end keeps
  // the finished checklist visible); null before the first write or after a
  // later turn begins; every other event returns the same state reference.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'todos', TodoItem[] | null>({
      key: 'todos',
      schema: todosProjectionSchema,
      init: () => null,
      apply: (state, event) => {
        if (event.type === 'todo/write') return event.data.todos
        if (event.type === 'turn/start') return null
        return state
      },
      view: state => state,
      // Fold semantics changed: turn/start clears the standing plan (was last-write-wins only).
      stateVersion: 2,
    })
  })
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
          additionalProperties: false,
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
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos)
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return Promise.resolve({
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}
