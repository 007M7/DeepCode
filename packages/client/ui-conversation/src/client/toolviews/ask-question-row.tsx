// ask_user_question toolview: question-flavored summary row replacing the
// generic "Tool call" card, registered into the keyed
// 'conversation.chat.toolview' hole like todo-row. The row composes ToolRow
// (chrome, running sweep, leading expansion) and swaps in the interaction
// outcome — `waiting` while pending, answered-count once settled, `cancelled`
// when the user dismissed the whole set — because the questions themselves
// render in the composer takeover.

import { IconQuestionOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from 'cordis'
import type { ToolRowProps } from '../contract/slots.ts'
import { toolRowModel } from '../contract/tool-call-model.ts'
import { ToolRow } from '../chat/ToolRow.tsx'

/** One parsed answer entry, shape-checked (result JSON crosses the wire). */
interface AnswerEntry { selected?: unknown; custom?: unknown }

function isAnswer(value: unknown): value is AnswerEntry {
  return typeof value === 'object' && value !== null
}

/** `${answered}/${total} answered` off the result JSON (a skipped question has
 *  empty `selected` and no `custom`); null on unexpected shape (generic fallback). */
function answeredSummary(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const answers = (parsed as { answers?: unknown }).answers
  if (!Array.isArray(answers) || !answers.every(isAnswer)) return null
  const answered = answers.filter(a =>
    (Array.isArray(a.selected) && a.selected.length > 0)
    || (typeof a.custom === 'string' && a.custom !== '')).length
  return `${answered}/${answers.length} answered`
}

/** One-line question-interaction row (leading toggle expands the raw args). */
export function AskQuestionRow({ toolName, block }: ToolRowProps) {
  const model = toolRowModel(toolName, block)
  // Composer verdicts settle the call as specific UserInteractionErrors
  // (apiproxy ask_user_question handler): 'ASK_CANCELLED' is the user's own
  // dismissal of the set, 'ASK_ABORTED' is a turn interrupt landing while the
  // question was pending. Both name their verdict instead of the generic
  // failed shape, and the abort keeps the shared stopped (amber) semantics of
  // any other interrupted tool call.
  const code = 'kind' in block ? block.error?.code : undefined
  let summary = model.summary
  let state = model.state
  if (code === 'ASK_CANCELLED') {
    summary = 'cancelled'
  } else if (code === 'ASK_ABORTED') {
    summary = 'interrupted'
    state = 'stopped'
  } else if (model.state === 'running') {
    summary = 'waiting'
  } else if ('kind' in block && model.state === 'ok') {
    const text = block.content.filter(b => b.type === 'text').map(b => b.text).join('')
    summary = answeredSummary(text) ?? model.summary
  }
  return (
    <ToolRow
      variant={model.variant}
      toolName={toolName}
      icon={<IconQuestionOutline14 />}
      title="Ask question"
      summary={summary}
      body={model.body}
      state={state}
    />
  )
}

/**
 * The ask-question row as a plain registrant plugin, riding the same
 * load-order seam as todo-toolview: `inject: ['conversation']` guarantees the
 * chat entry (and with it the 'conversation.chat.toolview' declaration) is on
 * the ledger.
 */
export const askQuestionToolview = {
  name: 'ask-question-toolview',
  inject: ['slots', 'conversation'],
  /**
   * Register the ask-question row into the chat view's keyed toolview hole.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'ask_user_question' }, AskQuestionRow)
  },
}
