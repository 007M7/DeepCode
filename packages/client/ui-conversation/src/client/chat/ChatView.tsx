// ChatView: the default conversation view — message flow with user bubbles,
// assistant narration, tool summary rows grouped into step runs, pending
// cards, paging, bottom-follow, and the session stats line under the flow
// (chrome dissolved into the view: the footer is part of what a chat view
// IS, not registration metadata). Pure component registered directly; its
// registration declares the keyed 'conversation.chat.toolview' hole, so tool
// rows render through the props renderSlot share (entryKey = tool name,
// GenericToolCard as the render-site fallback).
//
// Render economics (architecture RFC performance model): the list parent
// subscribes to snapshot segments that do NOT change per streaming chunk
// (nodes/runningCalls/pending keep their references across chunk batches), so
// during a token storm only StreamingTail re-renders; history rows hold via
// memo on cache-stable node slices. Selection changes re-render the parent
// map but only rows whose own selected bit flipped. renderSlot is
// entry-identity-stable (framework binding cache), so passing it through
// memoized rows never churns them.

import {
  memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import type {
  CodeSubCall, ConversationNode, ConversationSnapshot, RunningToolCall, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { SelectionTarget } from '../contract/views.ts'
import { deriveChatFlow, type ChatFlowItem } from './chat-flow.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import { GenericToolCard } from './GenericToolCard.tsx'
import { MessageItem } from './MessageItem.tsx'
import { PendingCard } from './PendingCard.tsx'
import { StatsLine } from './StatsLine.tsx'
import css from './ChatView.module.css'

const FOLLOW_THRESHOLD = 24

type OpenDetails = (target: SelectionTarget) => void

/** The declared toolview hole's render share (stable framework binding, passed through memoized rows). */
type RenderToolRow = ChatViewSlotProps['renderSlot']

/** ui-slots' UseSession is deliberately wide (dependency direction); the
 *  chat view narrows once to the runtime snapshot the binding actually feeds. */
type UseConversation = SnapshotSelectorHook<ConversationSnapshot>

/** One `run_code` sub-dispatch row: the identical keyed-slot dispatch as a
 *  top-level call (same registrations, same fallback), nested by the parent.
 *  A started-but-unsettled sub-call arrives as the RunningToolCall shape and
 *  renders the running state exactly as a native in-flight row. */
const SubCallRow = memo(function SubCallRow({ renderSlot, node, onOpenDetails, selected }: {
  renderSlot: RenderToolRow
  node: CodeSubCall
  onOpenDetails: OpenDetails
  selected: boolean
}) {
  const settled = 'kind' in node
  const toolName = settled ? node.call?.name ?? '' : node.name
  const seq = settled ? node.seq : node.time
  const owner = useMemo(() => ({
    callId: node.callId, toolName, block: node,
    openDetails: () => { onOpenDetails({ turnSeq: seq, callId: node.callId, toolName }) },
  }), [node, toolName, seq, onOpenDetails])
  return (
    <div className={css.callRow} data-selected={selected || undefined}>
      {renderSlot('conversation.chat.toolview', owner, {
        entryKey: toolName,
        fallback: <GenericToolCard {...owner} />,
      })}
    </div>
  )
})

/** One tool call row (result or running): dispatches through the keyed
 *  toolview slot with the owner payload; unregistered tools fall back to
 *  GenericToolCard at this render site. A `run_code` call additionally
 *  renders its logged sub-dispatches as always-visible indented rows —
 *  each one the same keyed-slot dispatch as a native top-level call. */
const CallRow = memo(function CallRow({ renderSlot, callId, toolName, block, seq, onOpenDetails, selected, subCalls, selectedCallId }: {
  renderSlot: RenderToolRow
  callId: string
  toolName: string
  block: ToolResultNode | RunningToolCall
  /** Surface seq for finalized results; the call's turn for running calls. */
  seq: number
  onOpenDetails: OpenDetails
  selected: boolean
  /** `run_code` sub-dispatches in dispatch order (reference-stable per
   *  parent; running entries settle in place); undefined for ordinary calls. */
  subCalls?: readonly CodeSubCall[] | undefined
  /** The store's selected callId, matched against sub-rows (undefined when no sub-row here is selected). */
  selectedCallId?: string | undefined
}) {
  const owner = useMemo(() => ({
    callId, toolName, block,
    openDetails: () => { onOpenDetails({ turnSeq: seq, callId, toolName }) },
  }), [callId, toolName, block, seq, onOpenDetails])
  return (
    <div className={css.callRow} data-selected={selected || undefined}>
      {renderSlot('conversation.chat.toolview', owner, {
        entryKey: toolName,
        fallback: <GenericToolCard {...owner} />,
      })}
      {subCalls !== undefined && subCalls.length > 0 && (
        <div className={css.subCalls} data-subcalls>
          {subCalls.map(node => (
            <SubCallRow
              key={node.callId}
              renderSlot={renderSlot}
              node={node}
              onOpenDetails={onOpenDetails}
              selected={node.callId === selectedCallId}
            />
          ))}
        </div>
      )}
    </div>
  )
})

/** Consecutive tool results as one step-run group (figma VERTICAL gap10). */
const ToolGroup = memo(function ToolGroup({ renderSlot, results, onOpenDetails, selectedCallId, codeDispatches }: {
  renderSlot: RenderToolRow
  results: readonly ToolResultNode[]
  onOpenDetails: OpenDetails
  /** Only set when the selected call lives in THIS group, top-level or nested (memo economy). */
  selectedCallId: string | undefined
  /** Sub-dispatch index off the snapshot (map reference is chunk-storm stable). */
  codeDispatches: ReadonlyMap<string, readonly CodeSubCall[]>
}) {
  return (
    <div className={css.toolGroup}>
      {results.map(node => (
        <CallRow
          key={node.callId}
          renderSlot={renderSlot}
          callId={node.callId}
          toolName={node.call?.name ?? ''}
          block={node}
          seq={node.seq}
          onOpenDetails={onOpenDetails}
          selected={node.callId === selectedCallId}
          subCalls={codeDispatches.get(node.callId)}
          selectedCallId={selectedCallId}
        />
      ))}
    </div>
  )
})

/** The streaming partial, isolated so chunk batches re-render only this tail.
 *  onGrow lets the scroll owner follow content the parent never re-renders for. */
function StreamingTail({ useSession, onGrow }: {
  useSession: UseConversation
  onGrow: () => void
}) {
  const partial = useSession(s => s.partial)
  useLayoutEffect(() => {
    onGrow()
  })
  if (partial === null) return null
  return <AssistantMarkdown blocks={partial.blocks} streaming />
}

/**
 * The chat view slot entry: pure component over the composed props (tool rows
 * render through the declared keyed hole's renderSlot share).
 */
export function ChatView({ useSession, useStore, renderSlot, openDetails, loadOlder }: ChatViewSlotProps) {
  const nodes = useSession(s => s.nodes)
  const runningCalls = useSession(s => s.runningCalls)
  const codeDispatches = useSession(s => s.codeDispatches)
  const pending = useSession(s => s.pending)
  const openState = useSession(s => s.openState)
  const openErrorMessage = useSession(s => s.openError === null ? null : `${s.openError.message}（${s.openError.code}）`)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => s.selection?.callId)

  const items = useMemo(() => deriveChatFlow(nodes), [nodes])

  const listRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Paging anchor: height/position at click, compensated after the prepend lands. */
  const anchorRef = useRef<{ h: number; t: number } | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)

  const firstSeq = nodes[0]?.seq ?? null
  const lastItem = items[items.length - 1]

  const toBottom = (el: HTMLDivElement): void => {
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }

  useLayoutEffect(() => {
    const el = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (el === null) return
    // Open completed: jump to the bottom once.
    if (openState === 'open' && !openedRef.current) {
      openedRef.current = true
      toBottom(el)
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastItem?.key ?? null
      return
    }
    // Prepend (head seq decreased): compensate by the height delta.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      el.scrollTop = anchorRef.current.t + (el.scrollHeight - anchorRef.current.h)
      anchorRef.current = null
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastItem?.key ?? null
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const lastKey = lastItem?.key ?? null
    const appendedUser = lastKey !== lastKeyRef.current
      && lastItem !== undefined && lastItem.kind === 'node' && lastItem.node.kind === 'user'
    lastKeyRef.current = lastKey
    if (appendedUser || atBottomRef.current) toBottom(el)
  })

  const onScroll = (): void => {
    const el = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires on the mounted element. */
    if (el === null) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
  }

  // Follow streaming growth the parent never re-renders for (stable ref).
  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const el = listRef.current
    if (el !== null && atBottomRef.current) el.scrollTop = el.scrollHeight
  }
  const onGrow = useRef(() => followRef.current?.()).current

  const loadOlderAnchored = (): void => {
    const el = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (el !== null) anchorRef.current = { h: el.scrollHeight, t: el.scrollTop }
    loadOlder()
  }

  const renderItem = (item: ChatFlowItem): ReactNode => {
    if (item.kind === 'tool-group') {
      const inGroup = selectedCallId !== undefined
        && item.results.some(r => r.callId === selectedCallId
          || codeDispatches.get(r.callId)?.some(sub => sub.callId === selectedCallId) === true)
      return (
        <ToolGroup
          key={item.key}
          renderSlot={renderSlot}
          results={item.results}
          onOpenDetails={openDetails}
          selectedCallId={inGroup ? selectedCallId : undefined}
          codeDispatches={codeDispatches}
        />
      )
    }
    const node: ConversationNode = item.node
    if (node.kind === 'assistant') {
      return <AssistantMarkdown key={item.key} blocks={node.blocks} streaming={false} interrupted={node.interrupted} />
    }
    /* v8 ignore next -- tool-result never reaches here: deriveChatFlow folds them into groups. */
    if (node.kind === 'tool-result') return null
    return <MessageItem key={item.key} node={node} />
  }

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll} onScroll={onScroll}>
        <div className={css.column}>
          {openState === 'loading' && <div className={css.hint}>载入历史…</div>}
          {openState === 'error' && <div className={css.openError}>历史加载失败：{openErrorMessage}</div>}
          {hasMore && (
            <div className={css.older}>
              <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
                {loadingOlder ? '加载中…' : '加载更早'}
              </button>
            </div>
          )}
          {items.map(renderItem)}
          <StreamingTail useSession={useSession} onGrow={onGrow} />
          {runningCalls.length > 0 && (
            <div className={css.toolGroup}>
              {runningCalls.map(call => (
                <CallRow
                  key={call.callId}
                  renderSlot={renderSlot}
                  callId={call.callId}
                  toolName={call.name}
                  block={call}
                  seq={call.turn}
                  onOpenDetails={openDetails}
                  selected={call.callId === selectedCallId}
                  subCalls={codeDispatches.get(call.callId)}
                  selectedCallId={selectedCallId}
                />
              ))}
            </div>
          )}
          {pending.map(item => <PendingCard key={item.key} item={item} />)}
        </div>
      </div>
      <StatsLine useSession={useSession} />
      {!atBottom && (
        <button
          type="button"
          className={css.toBottom}
          aria-label="回到底部"
          onClick={() => {
            const el = listRef.current
            /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
            if (el !== null) toBottom(el)
          }}
        >
          <IconChevronDownOutline14 />
        </button>
      )}
    </div>
  )
}
