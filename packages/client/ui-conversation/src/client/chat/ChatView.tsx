// ChatView: the default conversation view — message flow with user bubbles,
// assistant narration, tool summary rows grouped into step runs, pending
// cards, paging and bottom-follow. Created via factory so plugin deps
// (toolviews registry, i18n) arrive by closure, never by import.
//
// Render economics (architecture RFC performance model): the list parent
// subscribes to snapshot segments that do NOT change per streaming chunk
// (nodes/runningCalls/pending keep their references across chunk batches), so
// during a token storm only StreamingTail re-renders; history rows hold via
// memo on cache-stable node slices. Selection changes re-render the parent
// map but only rows whose own selected bit flipped.

import {
  memo, useLayoutEffect, useMemo, useRef, useState, type FC, type ReactNode,
} from 'react'
import type {
  ConversationNode, ConversationSnapshot, RunningToolCall, SessionId, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConvViewProps, SelectionTarget, Translate } from '../contract/views.ts'
import type { ToolViewProps } from '../contract/toolview.ts'
import type { ToolViewResolver } from '../contract/toolview.ts'
import { deriveChatFlow, type ChatFlowItem } from './chat-flow.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import { MessageItem } from './MessageItem.tsx'
import { PendingCard } from './PendingCard.tsx'
import { ToolViewOutlet } from './ToolViewOutlet.tsx'
import css from './ChatView.module.css'

/** Plugin-supplied closure deps (assembled in registerChat, apply world). */
export interface ChatViewDeps {
  toolviews: ToolViewResolver
  t: Translate
}

const FOLLOW_THRESHOLD = 24

type OpenDetails = (target: SelectionTarget) => void

/** web-react's UseSession is deliberately wide (dependency direction); the
 *  chat view narrows once to the runtime snapshot the binding actually feeds. */
type UseConversation = SnapshotSelectorHook<ConversationSnapshot>

/** One tool call row (result or running): builds the bound ToolViewProps. */
const CallRow = memo(function CallRow({ registry, sessionId, useSession, t, callId, toolName, block, seq, onOpenDetails, selected }: {
  registry: ToolViewResolver
  sessionId: SessionId
  useSession: ConvViewProps['useSession']
  t: Translate
  callId: string
  toolName: string
  block: ToolResultNode | RunningToolCall
  /** Surface seq for finalized results; the call's turn for running calls. */
  seq: number
  onOpenDetails: OpenDetails
  selected: boolean
}) {
  const viewProps = useMemo<ToolViewProps>(() => ({
    callId, toolName, block, useSession,
    actions: { openDetails: () => onOpenDetails({ turnSeq: seq, callId, toolName }) },
    t,
  }), [callId, toolName, block, useSession, seq, onOpenDetails, t])
  return (
    <div className={css.callRow} data-selected={selected || undefined}>
      <ToolViewOutlet registry={registry} sessionId={sessionId} toolName={toolName} viewProps={viewProps} />
    </div>
  )
})

/** Consecutive tool results as one step-run group (figma VERTICAL gap10). */
const ToolGroup = memo(function ToolGroup({ registry, sessionId, useSession, t, results, onOpenDetails, selectedCallId }: {
  registry: ToolViewResolver
  sessionId: SessionId
  useSession: ConvViewProps['useSession']
  t: Translate
  results: readonly ToolResultNode[]
  onOpenDetails: OpenDetails
  /** Only set when the selected call lives in THIS group (memo economy). */
  selectedCallId: string | undefined
}) {
  return (
    <div className={css.toolGroup}>
      {results.map((node) => (
        <CallRow
          key={node.callId}
          registry={registry}
          sessionId={sessionId}
          useSession={useSession}
          t={t}
          callId={node.callId}
          toolName={node.call?.name ?? ''}
          block={node}
          seq={node.seq}
          onOpenDetails={onOpenDetails}
          selected={node.callId === selectedCallId}
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
  const partial = useSession((s) => s.partial)
  useLayoutEffect(() => {
    onGrow()
  })
  if (partial === null) return null
  return <AssistantMarkdown blocks={partial.blocks} streaming />
}

/**
 * Build the chat view component over plugin deps.
 * @param deps - toolview registry and bound translator.
 * @returns the ConvViewProps component registered as the chat view.
 */
export function createChatView(deps: ChatViewDeps): FC<ConvViewProps> {
  const { toolviews, t } = deps

  return function ChatView({ sessionId, useSession: useSessionWide, useSelection, actions }: ConvViewProps) {
    const useSession = useSessionWide as UseConversation
    const nodes = useSession((s) => s.nodes)
    const runningCalls = useSession((s) => s.runningCalls)
    const pending = useSession((s) => s.pending)
    const openState = useSession((s) => s.openState)
    const openErrorMessage = useSession((s) => s.openError === null ? null : `${s.openError.message}（${s.openError.code}）`)
    const hasMore = useSession((s) => s.hasMore)
    const loadingOlder = useSession((s) => s.loadingOlder)
    const selectedCallId = useSelection((sel) => sel?.callId)

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

    const loadOlder = (): void => {
      const el = listRef.current
      /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
      if (el !== null) anchorRef.current = { h: el.scrollHeight, t: el.scrollTop }
      actions.loadOlder()
    }

    const renderItem = (item: ChatFlowItem): ReactNode => {
      if (item.kind === 'tool-group') {
        const inGroup = selectedCallId !== undefined
          && item.results.some((r) => r.callId === selectedCallId)
        return (
          <ToolGroup
            key={item.key}
            registry={toolviews}
            sessionId={sessionId}
            useSession={useSession}
            t={t}
            results={item.results}
            onOpenDetails={actions.openDetails}
            selectedCallId={inGroup ? selectedCallId : undefined}
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
              <button type="button" disabled={loadingOlder} onClick={loadOlder}>
                {loadingOlder ? '加载中…' : '加载更早'}
              </button>
            </div>
          )}
          {items.map(renderItem)}
          <StreamingTail useSession={useSession} onGrow={onGrow} />
          {runningCalls.length > 0 && (
            <div className={css.toolGroup}>
              {runningCalls.map((call) => (
                <CallRow
                  key={call.callId}
                  registry={toolviews}
                  sessionId={sessionId}
                  useSession={useSession}
                  t={t}
                  callId={call.callId}
                  toolName={call.name}
                  block={call}
                  seq={call.turn}
                  onOpenDetails={actions.openDetails}
                  selected={call.callId === selectedCallId}
                />
              ))}
            </div>
          )}
          {pending.map((item) => <PendingCard key={item.rpcId} item={item} />)}
          </div>
        </div>
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
}
