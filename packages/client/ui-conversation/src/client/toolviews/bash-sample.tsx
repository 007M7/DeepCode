// Bash toolview registrant: third-party posture over the keyed toolview hole
// (ctx.slots.register + ToolRowProps only — never imports the chat domain).
// Product chrome matches ToolRow / Think (figma: Bash · {description}).
// Child sessions keep a scoped badge so session-dimension differentiation stays
// observable inside the component (no parallel registry).
//
// A bash call declares the terminal render intent, so this row also renders
// the command's own output through TerminalBlock. This row has no expand
// control and is not a details-panel target either (tool rows stopped being
// one), so its terminal body is resident rather than expand-gated as in
// ToolRow, and the card's own copy and expand controls are the row's only
// interactions. CHAT_TERMINAL_MAX_LINES is passed as `maxLines` — the chat
// flow's tighter cap over the block's own default of 16 — and the block's
// internal expander keeps a long output from taking over the message flow.

import type { Context } from 'cordis'
import { IconApiOutline14, StateDot, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolRowProps } from '../contract/slots.ts'
import { CHAT_TERMINAL_MAX_LINES, terminalBlockLabels, terminalCardModel } from '../contract/terminal-card-model.ts'
import { toolRowModel, type ToolRowState } from '../contract/tool-call-model.ts'
import { NS } from '../locales.ts'
import css from './bash-sample.module.css'

/** Bash row props: the toolview runtime share plus the standard locale seat. */
type BashRowProps = ToolRowProps & PropsLocale<'conversation'>

function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return <IconApiOutline14 size={14} />
  }
}

/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state: ToolRowState, t: BashRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('bash.running')
    case 'error': return t('bash.failed')
    case 'stopped': return t('bash.stopped')
    default: return null
  }
}

/**
 * Bash row: icon + Bash · {description} in the shared ToolRow chrome, with the
 * command's terminal card resident below it. The summary row is not a
 * details-panel control (tool rows stopped being one), so the card's copy and
 * expand controls are the row's only interactions.
 */
export function BashRow({ toolName, block, sessionId, useSessions, t }: BashRowProps) {
  const model = toolRowModel(toolName, block)
  // Session workspace root: the terminal view's cwd resolves against it (an
  // omitted workdir IS the workspace), which the pure presenter cannot do.
  const cwd = useSessions(list => list.byId[sessionId]?.cwd)
  const terminal = terminalCardModel(block, cwd)
  const isChild = useSessions(list => list.byId[sessionId]?.parentId !== undefined)
  const status = stateStatus(model.state, t)
  return (
    <div className={css.card}>
      <div
        className={css.root}
        data-sample={isChild ? 'bash-scoped' : 'bash-global'}
        data-variant="bash"
        data-state={model.state}
      >
        <span className={css.leading}>{leadingFor(model.state)}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        {isChild && <span className={css.scopeBadge}>scoped</span>}
        <span className={css.title}>{model.title}</span>
        <span className={css.sep} aria-hidden />
        {/* The terminal presenter's description is the contractual
            above-card summary; it outranks the args-derived one. */}
        <span className={css.summary}>{terminal?.description ?? model.summary}</span>
      </div>
      {terminal !== null && (
        <TerminalBlock
          {...terminal.card}
          maxLines={CHAT_TERMINAL_MAX_LINES}
          labels={terminalBlockLabels(t)}
          className={css.terminal}
        />
      )}
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
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'bash', locale: NS }, BashRow)
  },
}
