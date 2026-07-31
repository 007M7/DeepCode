// Shared toolview-row helpers for the keyed rows whose card is resident below a
// summary (SearchRow, FileMutationRow): the visually hidden run-state label and
// the flattened settled-result text for the fallback arm a card cannot render.
// Both are pure functions of a frozen call slice — no chat-domain imports — so a
// row stays a thin ToolRowProps consumer.

import type { ToolRowProps } from './slots.ts'
import type { ToolRowState } from './tool-call-model.ts'

/**
 * Visually hidden run-state label for a row's leading `StateDot` (which is
 * `aria-hidden`), so assistive technology still announces the state. Returns
 * null for the settled-ok state, which needs no spoken label.
 * @param state - the row's run state.
 * @returns the label, or null when none is needed.
 */
export function rowStateStatus(state: ToolRowState): string | null {
  switch (state) {
    case 'running': return '运行中'
    case 'error': return '失败'
    case 'stopped': return '已停止'
    default: return null
  }
}

/**
 * A settled result's text, flattened from its content blocks, for the fallback
 * arm a keyed row shows when its card cannot render the result — an errored call
 * (the tool emits no result view on error) or a settled call with no card view
 * (a nested `run_code` sub-dispatch, a legacy generic result). The keyed row owns
 * the render slot, so without this the model-facing text would have nowhere to
 * go. Falls back to the error name/code when the result carries no text block.
 * @param block - the frozen call slice.
 * @returns the result text, or null for a running call or an empty result.
 */
export function rowResultText(block: ToolRowProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    if (item.type === 'text') parts.push(item.text)
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  const text = parts.join('\n')
  return text === '' ? null : text
}
