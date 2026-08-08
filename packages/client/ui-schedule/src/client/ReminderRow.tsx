import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EventRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ReminderRow.module.css'

interface ReminderPresentation {
  scheduleId: string
  prompt: string
  occurrenceAt: string
}

/** Full Schedule row props: event owner/runtime share plus the locale seat. */
export type ReminderRowProps = EventRowProps & PropsLocale<'schedule'>

/** Narrow the domain-owned JSON sidecar without trusting its unknown carrier type. */
function reminderPresentation(value: unknown): ReminderPresentation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record['scheduleId'] !== 'string' || record['scheduleId'].length === 0) return null
  if (typeof record['prompt'] !== 'string') return null
  if (typeof record['occurrenceAt'] !== 'string' || record['occurrenceAt'].length === 0) return null
  return {
    scheduleId: record['scheduleId'],
    prompt: record['prompt'],
    occurrenceAt: record['occurrenceAt'],
  }
}

/**
 * Render one durable reminder dispatch carried by the generic event sidecar.
 * @param props - Keyed event owner payload and the Schedule translator.
 * @returns A visible reminder receipt, or a contained invalid-payload row.
 */
export function ReminderRow({ node, t }: ReminderRowProps) {
  const reminder = reminderPresentation(node.view)
  return (
    <section className={css.root} role="note" data-schedule-reminder>
      <header className={css.header}>
        <span className={css.icon} aria-hidden><IconSparkle16 size={14} /></span>
        <span className={css.title}>{t('reminder.title')}</span>
        {reminder !== null && <span className={css.delivery}>{t('reminder.delivery')}</span>}
      </header>
      {reminder === null
        ? <p className={css.invalid}>{t('reminder.invalid')} · {node.eventType}</p>
        : (
          <>
            <p className={css.prompt}>{reminder.prompt}</p>
            <footer className={css.meta}>
              <span className={css.id}>{t('reminder.id', { id: reminder.scheduleId })}</span>
              <time dateTime={reminder.occurrenceAt}>
                {t('reminder.occurrence', { time: reminder.occurrenceAt })}
              </time>
            </footer>
          </>
        )}
    </section>
  )
}
