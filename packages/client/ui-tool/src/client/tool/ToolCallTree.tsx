/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useMemo, type ReactNode } from 'react'
import type { CodeSubCall, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallOwnerProps, ToolTreeProps } from '../contract/slots.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

/** Resolve a Code Dispatch child's wire Tool name from either lifecycle form. */
function subCallName(node: CodeSubCall): string {
  return 'kind' in node ? node.call?.name ?? '' : node.name
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, block, openFile, selected, cwd, inspectCall, t, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'cwd' | 'inspectCall' | 't'> & {
  callId: string
  toolName: string
  block: ToolCallBlock
  selected: boolean
  children?: ReactNode
}) {
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    block,
    openFile,
    cwd,
    inspect: () => { inspectCall(callId) },
  }), [callId, toolName, block, openFile, cwd, inspectCall])
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
      data-selected={selected || undefined}
    >
      {renderSlot('tool.call.toolview', owner, {
        entryKey: toolName,
        fallback: <GenericToolCard {...owner} t={t} />,
      })}
      {children}
    </div>
  )
})

/**
 * Render one root Tool call and its currently supported one-level Code
 * Dispatch children. Root and children use the same atomic keyed dispatch.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
export function ToolCallTree({
  useSession, renderSlot, callId, toolName, block, selectedCallId, cwd, openFile, inspectCall, t,
}: ToolTreeProps) {
  const subCalls = useSession(snapshot => snapshot.codeDispatches.get(callId))
  return (
    <ToolCall
      renderSlot={renderSlot}
      callId={callId}
      toolName={toolName}
      block={block}
      openFile={openFile}
      selected={callId === selectedCallId}
      cwd={cwd}
      inspectCall={inspectCall}
      t={t}
    >
      {subCalls !== undefined && subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {subCalls.map(node => (
            <ToolCall
              key={node.callId}
              renderSlot={renderSlot}
              callId={node.callId}
              toolName={subCallName(node)}
              block={node}
              openFile={openFile}
              selected={node.callId === selectedCallId}
              cwd={cwd}
              inspectCall={inspectCall}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
  )
}
