// Read-only queue dock entry (design v4 queue cut 1): renders the session's
// inbox mirror (session/queued frames + connect baseline) as one stacked
// strip above the input. No per-row actions — the host inbox has no
// addressable entries yet (queue cut 2 ledger).
//
// The 'conversation.input.dock' SlotMap declaration lives in
// ../contract/slots.ts beside the other input-region slots.
import type { Context } from 'cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import css from './QueueDock.module.css'

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat. */
export type QueueDockProps = PropsRuntime<'conversation.input.dock'>

/** Queue strip: one preview line per queued message; renders null when the queue is empty. */
export function QueueDock({ useSession }: QueueDockProps) {
  const queue = useSession(s => s.queue)
  if (queue.length === 0) return null
  return (
    <div className={css.dock}>
      <div className={css.title}>已排队 {queue.length} 条</div>
      <ul className={css.list}>
        {queue.map(row => (
          <li key={row.key} className={css.row}>{row.preview}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The dock entry as a plain registrant plugin (bash posture).
 * `inject: ['conversation']` is the ordering seam: the conversation service
 * mounts after ui-conversation's slot registrations, so the
 * 'conversation.input.dock' declaration is on the ledger by then.
 */
export const queueDockEntry = {
  name: 'conversation-queue-dock',
  inject: ['slots', 'conversation'],
  /**
   * Register the queue strip into the input dock (list entry, order 0).
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.input.dock', id: 'queue', order: 0 }, QueueDock)
  },
}
