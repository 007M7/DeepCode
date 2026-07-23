// Bash toolview sample, written in third-party posture: everything below uses
// only the public slot surface (ctx.slots.register into the keyed
// 'conversation.chat.toolview' hole + ToolRowProps) — the acceptance proof
// that a plain plugin can take over a tool row with zero dedicated machinery.
// Session-dimension differentiation happens INSIDE the component (the
// canonical sub-agent scenario): rows in child sessions render the scoped
// variant, derived from the standard useSessions kit — no registry predicates.

import type { Context } from 'cordis'
import type { ToolRowProps } from '../contract/slots.ts'
import { toolRowModel } from '../contract/tool-call-model.ts'
import css from './bash-sample.module.css'

/** Bash row: command-first monospace summary replacing the generic card.
 *  Sub-session rows (parentId present) swap the prompt for a scoped badge —
 *  the differential stays observable per session from one registration. */
export function BashRow({ toolName, block, openDetails, sessionId, useSessions }: ToolRowProps) {
  const model = toolRowModel(toolName, block)
  const isChild = useSessions(list => list.byId[sessionId]?.parentId !== undefined)
  if (isChild) {
    return (
      <div className={css.row} data-sample="bash-scoped" onClick={openDetails}>
        <span className={css.scopeBadge}>scoped</span>
        <span className={css.command}>{model.summary}</span>
      </div>
    )
  }
  return (
    <div className={css.row} data-sample="bash-global" onClick={openDetails}>
      <span className={css.prompt} aria-hidden>$</span>
      <span className={css.command}>{model.summary}</span>
      {model.state === 'error' && <span className={css.err}>failed</span>}
    </div>
  )
}

/**
 * The sample as a plain registrant plugin. `inject` carries the load-order
 * seam: requiring the conversation service guarantees the chat entry (and
 * with it the 'conversation.chat.toolview' declaration) is registered —
 * ui-conversation's apply mounts the service after the chat entry.
 */
export const bashToolviewSample = {
  name: 'bash-toolview-sample',
  inject: ['slots', 'conversation'],
  /**
   * Register the bash row into the chat view's keyed toolview hole.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'bash' }, BashRow)
  },
}
