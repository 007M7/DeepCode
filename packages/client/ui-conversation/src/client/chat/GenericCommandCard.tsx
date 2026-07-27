// GenericCommandCard: the default command row — a stripped-down
// GenericToolCard rendering the dispatched command line and the settlement
// text. Supplied by the chat view as the keyed commandview slot's render-site
// fallback (an unregistered command name lands here); registrants may compose
// it as a base, feeding the same owner payload through.

import { ToolRow } from './ToolRow.tsx'
import type { ToolRowState } from '../contract/tool-call-model.ts'
import type { CommandRowOwnerProps } from '../contract/slots.ts'
import { IconApiOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

/** Node state → row state semantic (running while unsettled; outcome kind after). */
function stateOf(outcome: CommandRowOwnerProps['node']['outcome']): ToolRowState {
  if (outcome === null) return 'running'
  return outcome.kind === 'error' ? 'error' : 'ok'
}

export function GenericCommandCard({ node }: CommandRowOwnerProps) {
  const text = node.outcome?.text
  const summary = node.outcome === null
    ? '执行中…'
    : text ?? (node.outcome.kind === 'error' ? '命令失败' : '已完成')
  // Display line rebuilt from the structured payload (args carries its own
  // separator whitespace verbatim); a cross-window node whose run page fell
  // out of the window has neither.
  const title = node.name === null ? '命令' : `/${node.name}${node.args ?? ''}`
  return (
    <ToolRow
      variant="others"
      icon={<IconApiOutline14 size={16} />}
      title={title}
      summary={summary}
      // Expandable only when the outcome text overflows a one-line summary.
      body={text !== undefined && text.includes('\n') ? text : null}
      state={stateOf(node.outcome)}
    />
  )
}
