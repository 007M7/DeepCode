// Bash toolview registrant: third-party posture over the keyed toolview hole
// (ctx.slots.register + ToolRowProps only — never imports the chat domain).
// Product chrome matches ToolRow / Think (figma: Bash · {description}).
// Child sessions keep a scoped badge so session-dimension differentiation stays
// observable inside the component (no parallel registry).

import type { Context } from 'cordis'
import { IconApiOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowProps } from '../contract/slots.ts'
import { toolRowModel, type ToolRowState } from '../contract/tool-call-model.ts'
import css from './bash-sample.module.css'

function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return <IconApiOutline14 size={14} />
  }
}

/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state: ToolRowState): string | null {
  switch (state) {
    case 'running': return '运行中'
    case 'error': return '失败'
    case 'stopped': return '已停止'
    default: return null
  }
}

/** Bash row: icon + Bash · {description}, matching the shared ToolRow chrome. */
export function BashRow({ toolName, block, openDetails, sessionId, useSessions }: ToolRowProps) {
  const model = toolRowModel(toolName, block)
  const isChild = useSessions(list => list.byId[sessionId]?.parentId !== undefined)
  const status = stateStatus(model.state)
  return (
    <div
      className={css.root}
      data-sample={isChild ? 'bash-scoped' : 'bash-global'}
      data-variant="bash"
      data-state={model.state}
      data-clickable
      onClick={openDetails}
    >
      <span className={css.leading}>{leadingFor(model.state)}</span>
      {status !== null && <span className={css.visuallyHidden}>{status}</span>}
      {isChild && <span className={css.scopeBadge}>scoped</span>}
      <span className={css.title}>{model.title}</span>
      <span className={css.sep} aria-hidden />
      <span className={css.summary}>{model.summary}</span>
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
