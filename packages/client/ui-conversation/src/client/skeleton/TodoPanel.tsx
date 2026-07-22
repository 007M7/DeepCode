// TodoPanel: persistent plan strip pinned above the composer (the web
// counterpart of the TUI plan panel; ACP maps the same event to its native
// plan). Renders the latest todo/write whole-list snapshot off the session
// snapshot — no data of its own, hidden while the list is empty. Zero
// framework imports: useSession arrives via props from ConversationRoot.

import { useState } from 'react'
import type { TodoItem } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TodoPanel.module.css'

export interface TodoPanelProps {
  useSession: UseSession
}

/** Status glyphs mirror the TUI plan panel (✓ done / ● active / ○ pending). */
const STATUS_GLYPHS: Record<TodoItem['status'], string> = {
  completed: '✓', in_progress: '●', pending: '○',
}

export function TodoPanel({ useSession }: TodoPanelProps) {
  const todos = useSession(s => (s as { todos: readonly TodoItem[] }).todos)
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
