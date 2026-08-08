/** Register the Schedule durable-reminder renderer into the conversation event slot. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ReminderRow } from './ReminderRow.tsx'
import { en, NS, zh, type ScheduleKey } from './locales.ts'

export type { ReminderRowProps } from './ReminderRow.tsx'
export type { ScheduleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for durable Schedule reminder receipts. */
    schedule: ScheduleKey
  }
}

export const inject = ['slots', 'locale']

/**
 * Register bilingual copy and the Schedule reminder keyed row.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-schedule: dictionaries')
  ctx.slots.inject(
    'conversation.chat.eventview',
    () => ctx.slots.register({
      name: 'conversation.chat.eventview',
      key: 'schedule/change',
      locale: NS,
    }, ReminderRow),
  )
}
