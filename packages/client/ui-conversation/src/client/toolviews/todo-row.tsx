// todo_write toolview: plan-flavored summary row replacing the generic
// "Tool call" card, registered into the keyed 'conversation.chat.toolview'
// hole like the bash sample (a product registration, not a sample). The row
// summarizes the written list (counts + active items) from the call args, with
// the parallel-active count in its own non-shrinking span outside the
// ellipsized text; the durable list itself renders in the TodoPanel above the
// composer, so the row stays one line. Chrome matches ToolRow (figma 780:53675).

import type { Context } from 'cordis'
import { IconChecklistOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowProps } from '../contract/slots.ts'
import { toolRowModel, type ToolRowState } from '../contract/tool-call-model.ts'
import type { PlanItemLike } from './plan-summary.ts'
import { planSummary } from './plan-summary.ts'
import css from './todo-row.module.css'

function isItem(value: unknown): value is PlanItemLike {
  return typeof value === 'object' && value !== null
}

/**
 * The row's summary split at the ellipsis boundary: `text` truncates, `extra`
 * is the parallel-active count that must not, so a narrow row never clips the
 * one part that says several tasks are running.
 */
interface RowSummary {
  text: string
  extra: number
}

function summarize(argsRaw: string): RowSummary | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    // Mid-stream truncation or malformed model JSON: fall back to the generic summary.
    return null
  }
  // Valid JSON with an invalid shape (null root, non-array todos, null items —
  // a rejected tool/call retains such args verbatim): same generic fallback.
  if (typeof parsed !== 'object' || parsed === null) return null
  const todos = (parsed as { todos?: unknown }).todos
  if (!Array.isArray(todos) || !todos.every(isItem)) return null
  const { done, total, activeContent, activeExtra } = planSummary(todos)
  const head = `${done}/${total} 已完成`
  return {
    text: activeContent === null ? head : `${head} · ${activeContent}`,
    extra: activeExtra,
  }
}

/** Leading-slot state substitution matches ToolRow / bash: icon yields to the
 *  state semantic while running or failed; ok keeps the checklist glyph. */
function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'running': return <StateDot state="ongoing" />
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return <IconChecklistOutline16 />
  }
}

/** One-line plan update row. Non-ok execution states keep the generic row's
 *  dot semantics — a cancelled call wrote no todo/write, so it must not read
 *  as a completed update. */
export function TodoRow({ toolName, block }: ToolRowProps) {
  const model = toolRowModel(toolName, block)
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  const summary = summarize(argsRaw) ?? { text: model.summary, extra: 0 }
  return (
    <div
      className={css.row}
      data-sample="todo-row"
      data-state={model.state}
    >
      <span className={css.leading} aria-hidden>{leadingFor(model.state)}</span>
      <span className={css.title}>更新任务清单</span>
      <span className={css.sep} aria-hidden />
      <span className={css.summary}>{summary.text}</span>
      {summary.extra > 0 && <span className={css.extra}>+{summary.extra}</span>}
      {model.state === 'error' && <span className={css.err}>failed</span>}
      {model.state === 'stopped' && <span className={css.err}>已中断</span>}
    </div>
  )
}

/**
 * The todo row as a plain registrant plugin, riding the same load-order seam
 * as the bash sample: `inject: ['conversation']` guarantees the chat entry
 * (and with it the 'conversation.chat.toolview' declaration) is on the ledger.
 */
export const todoToolview = {
  name: 'todo-toolview',
  inject: ['slots', 'conversation'],
  /**
   * Register the todo row into the chat view's keyed toolview hole.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({ name: 'conversation.chat.toolview', key: 'todo_write' }, TodoRow)
  },
}
