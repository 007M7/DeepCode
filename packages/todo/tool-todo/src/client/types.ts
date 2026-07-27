/**
 * Pure-type client outlet of the todo domain: the ONE home of the `todos`
 * projection-key declaration, importable from client aggregates without
 * dragging this package's host-side value imports (dsh-tools, zod). The host
 * entry (`index.ts`) imports this module type-only to reuse the same merge —
 * one declaration serves both program sides.
 *
 * @module @deepseek-ai/dsh-tool-todo/client/types
 */

import type { TodoItem } from '@deepseek-ai/dsh-session/types'

export type { TodoItem } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The agent's current whole todo list (the latest `todo/write` snapshot),
     * or `null` before the first write. Whole-value rule: every `todo/write`
     * carries the complete replacement list, so the fold is last-wins.
     */
    todos: TodoItem[] | null
  }
}
