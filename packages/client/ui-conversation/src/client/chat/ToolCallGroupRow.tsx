/** One collapsed run of consecutive same-name tool calls in the chat flow. */

import { memo, useState } from 'react'
import { DisclosureRow, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import css from './ToolCallGroupRow.module.css'

export interface ToolCallGroupRowProps {
  /** Wire tool name shared by every member call. */
  toolName: string
  /** Member node keys in flow order (at least two, all settled same-name calls). */
  memberKeys: readonly string[]
  useSession: ChatViewSlotProps['useSession']
  renderSlot: ChatViewSlotProps['renderSlot']
  selectedCallId: ChatNodeOwnerProps['selectedCallId']
  cwd: string | undefined
  openFile: ChatViewSlotProps['openFile']
  inspectCall: ChatViewSlotProps['inspectCall']
  forkAt: ChatViewSlotProps['forkAt']
  loadImage: ChatViewSlotProps['loadImage']
  fileMentions: ChatViewSlotProps['fileMentions']
  t: ChatViewSlotProps['t']
}

/**
 * Render one tool-call run as a disclosure: a single summary row naming the
 * tool and member count, expanding to the member call rows. The group starts
 * collapsed so a long run of reads or greps stays scannable; each member still
 * renders through its own ChatNodeSeat, keeping per-call subscriptions and
 * paging anchors intact.
 * @param props - group identity, member keys, and the member row's seat props.
 * @returns the group disclosure row.
 */
export const ToolCallGroupRow = memo(function ToolCallGroupRow({
  toolName,
  memberKeys,
  useSession,
  renderSlot,
  selectedCallId,
  cwd,
  openFile,
  inspectCall,
  forkAt,
  loadImage,
  fileMentions,
  t,
}: ToolCallGroupRowProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={css.root}
      data-chat-anchor-key={memberKeys[0]}
      data-tool-group={toolName}
    >
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconSparkle16 size={14} />}
        title={`${toolName} × ${memberKeys.length}`}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
      >
        <div className={css.members} data-tool-group-members>
          {memberKeys.map(nodeKey => (
            <ChatNodeSeat
              key={nodeKey}
              nodeKey={nodeKey}
              useSession={useSession}
              selectedCallId={selectedCallId}
              cwd={cwd}
              openFile={openFile}
              inspectCall={inspectCall}
              forkAt={forkAt}
              loadImage={loadImage}
              fileMentions={fileMentions}
              renderSlot={renderSlot}
              t={t}
            />
          ))}
        </div>
      </DisclosureRow>
    </div>
  )
})
