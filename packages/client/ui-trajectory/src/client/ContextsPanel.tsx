/** Context-generation selector for a trajectory session. */

import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConversationContext, ConversationContextOriginKind,
} from '@deepseek-ai/dsh-client-runtime/client'
import css from './ContextsPanel.module.css'

export interface ContextsPanelProps {
  contexts: readonly ConversationContext[]
  selectedId: number
  currentId: number
  onSelect(id: number): void
}

function formatTime(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function originLabel(origin: ConversationContextOriginKind | undefined): string {
  if (origin === 'compaction') return 'Compaction'
  if (origin === 'rewind') return 'Rewind'
  if (origin === 'rewrite') return 'Context rewrite'
  return 'Initial context'
}

/** Human-facing context title without exposing internal generation ids. */
export function contextLabel(context: ConversationContext): string {
  const label = originLabel(context.origin)
  const time = formatTime(context.createdAt)
  return time === undefined ? label : `${label} · ${time}`
}

/**
 * Render every append-only context generation in creation order.
 * @param props - Contexts and the selected/current identities.
 * @returns The context navigation panel.
 */
export function ContextsPanel({
  contexts,
  selectedId,
  currentId,
  onSelect,
}: ContextsPanelProps) {
  return (
    <aside className={css.root} aria-label="Contexts">
      <div className={css.header}>Contexts</div>
      <div className={css.list}>
        {contexts.map((context) => {
          const selected = context.id === selectedId
          const current = context.id === currentId
          const parent = context.parentId === undefined
            ? undefined
            : contexts.find(candidate => candidate.id === context.parentId)
          return (
            <button
              key={context.id}
              type="button"
              className={selected ? `${css.item} ${css.itemSelected}` : css.item}
              aria-current={selected ? 'true' : undefined}
              onClick={() => { onSelect(context.id) }}
            >
              <IconBranchOutline16 className={css.icon} size={14} />
              <span className={css.itemBody}>
                <span className={css.itemTitle}>{contextLabel(context)}</span>
                <span className={css.itemMeta}>
                  {context.origin === undefined
                    ? 'Session origin'
                    : `from ${parent === undefined ? 'previous context' : originLabel(parent.origin)}`}
                </span>
              </span>
              <span className={current ? css.current : css.frozen}>
                {current ? 'Current' : 'Frozen'}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
