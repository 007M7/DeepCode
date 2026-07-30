// File-mutation toolview registrant: third-party posture over the keyed
// toolview hole (ctx.slots.register + ToolRowProps only — never imports the
// chat domain), registered under both `edit` and `write`. Product chrome
// matches ToolRow (figma: {Edit,Write} · {path}).
//
// A write/edit call declares the diff render intent, so this row renders the
// applied change through DiffBlock resident below its summary line — the same
// posture BashRow gives a terminal card. The row has no expand control and is
// not a details-panel target (tool rows stopped being one), so the diff body
// is resident rather than expand-gated, and the card's own copy and expand
// controls are the row's only interactions. CHAT_DIFF_MAX_LINES caps the body
// against the message flow; the details panel keeps the block's full default.
// The summary stays a path link (the file-tool interaction) that opens through
// the host.

import type { Context } from 'cordis'
import { DiffBlock, IconEditOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowProps } from '../contract/slots.ts'
import { CHAT_DIFF_MAX_LINES, diffCardModel } from '../contract/diff-card-model.ts'
import { toolRowModel, type ToolRowState } from '../contract/tool-call-model.ts'
import css from './file-mutation-row.module.css'

function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return <IconEditOutline16 size={14} />
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

/**
 * A settled result's text, flattened from its content blocks, for the arm that
 * shows a failure the diff card cannot: write/edit return `undefined` from
 * `presentResult` on `result.isError`, so an errored mutation has no diff card,
 * and the keyed row is not a details-panel target. Without this the failure —
 * an `old_string` that did not match, a permission denial — would read as a bare
 * red dot with the model-facing error text nowhere on screen.
 * @param block - the frozen call slice.
 * @returns the result text, or null for a running call or an empty result.
 */
function errorText(block: ToolRowProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    if (item.type === 'text') parts.push(item.text)
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  const text = parts.join('\n')
  return text === '' ? null : text
}

/**
 * File-mutation row: icon + {Edit,Write} · {path} in the shared ToolRow chrome,
 * with the applied diff resident below it. The summary is a path link (a file
 * tool's interaction); the host's `openFile` resolves it against the session
 * cwd, so this passes the tool's own path verbatim. The card's copy and expand
 * controls are the row's only other actions.
 */
export function FileMutationRow({ toolName, block, cwd, openFile }: ToolRowProps) {
  const model = toolRowModel(toolName, block, cwd)
  const diff = diffCardModel(block)
  const status = stateStatus(model.state)
  const filePath = model.filePath
  // An errored mutation has no diff card (presentResult returns undefined on
  // isError); surface its result text so the failure is more than a red dot.
  const failure = diff === null && model.state === 'error' ? errorText(block) : null
  return (
    <div className={css.card}>
      <div className={css.root} data-variant={model.variant} data-state={model.state}>
        <span className={css.leading}>{leadingFor(model.state)}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <span className={css.title}>{model.title}</span>
        <span className={css.sep} aria-hidden />
        {filePath !== undefined ? (
          <button
            type="button"
            className={css.fileLink}
            onClick={() => { openFile(filePath) }}
          >
            {model.summary}
          </button>
        ) : (
          <span className={css.summary}>{model.summary}</span>
        )}
      </div>
      {diff !== null && (
        <DiffBlock {...diff.card} maxLines={CHAT_DIFF_MAX_LINES} className={css.diff} />
      )}
      {failure !== null && <div className={css.failure}>{failure}</div>}
    </div>
  )
}

/**
 * The file-mutation rows as a plain registrant plugin. `inject` carries the
 * load-order seam: requiring the conversation service guarantees the chat entry
 * (and with it the 'conversation.chat.toolview' declaration) is registered —
 * ui-conversation's apply mounts the service after the chat entry.
 */
export const fileMutationToolview = {
  name: 'file-mutation-toolview',
  inject: ['slots', 'conversation'],
  /**
   * Register the file-mutation row into the chat view's keyed toolview hole
   * under both mutation tool names.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'edit' }, FileMutationRow)
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'write' }, FileMutationRow)
  },
}
