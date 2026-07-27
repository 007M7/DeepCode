// TodoPanel: persistent plan strip above the composer (the web counterpart
// of the TUI plan panel). Renders the latest todo/write whole-list snapshot —
// no data of its own, hidden while the list is empty. Mounted through the
// 'conversation.input.dock' slot (QueueDock posture): the dock adapter does
// the selecting, so the panel takes the plain list and stays framework-free.

import { useState } from 'react'
import type { Context } from 'cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TodoItem } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TodoPanel.module.css'

export interface TodoPanelProps {
  /** The session's current plan (empty renders nothing) — selected by the dock adapter. */
  todos: readonly TodoItem[]
}

/** Status glyphs mirror the TUI plan panel (✓ done / ● active / ○ pending). */
const STATUS_GLYPHS: Record<TodoItem['status'], string> = {
  completed: '✓', in_progress: '●', pending: '○',
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  if (todos.length === 0) return null

  const done = todos.filter(t => t.status === 'completed').length
  const active = todos.find(t => t.status === 'in_progress')

  return (
    <section className={css.root} data-testid="todo-panel" aria-label="任务清单">
      <button
        type="button"
        className={css.header}
        aria-expanded={!collapsed}
        onClick={() => { setCollapsed(v => !v) }}
      >
        <span className={css.title}>Plan</span>
        <span className={css.progress}>{done}/{todos.length}</span>
        {collapsed && active !== undefined && (
          <span className={css.activeHint}>{active.content}</span>
        )}
        <span className={css.chevron} aria-hidden>
          {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </button>
      {!collapsed && (
        <ul className={css.list}>
          {todos.map(item => (
            <li key={item.content} className={css.item} data-status={item.status}>
              <span className={css.glyph} aria-hidden>{STATUS_GLYPHS[item.status]}</span>
              <span className={css.content}>{item.content}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat. */
export type TodoDockProps = PropsRuntime<'conversation.input.dock'>

/** Dock adapter: selects the plan off the session snapshot and hands the strip a plain list. */
export function TodoDock({ useSession }: TodoDockProps) {
  const todos = useSession(s => s.todos)
  return <TodoPanel todos={todos} />
}

/**
 * The plan strip as a plain registrant plugin (QueueDock posture).
 * `inject: ['conversation']` is the ordering seam: the conversation service
 * mounts after ui-conversation's slot registrations, so the
 * 'conversation.input.dock' declaration is on the ledger by then.
 */
export const todoDockEntry = {
  name: 'conversation-todo-dock',
  inject: ['slots', 'conversation'],
  /**
   * Register the plan strip into the input dock (list entry, above the queue rows).
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.input.dock', id: 'todo', order: -1 }, TodoDock)
  },
}
