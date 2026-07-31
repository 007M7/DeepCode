// ChatView: the default conversation view — message flow with user bubbles,
// assistant narration, tool summary rows grouped into step runs, pending
// cards, paging, and bottom-follow. Session stats live on
// 'conversation.composer.dock' (sticky with the composer). Pure component
// registered directly; its registration declares the keyed
// 'conversation.chat.toolview' hole, so tool rows render through the props
// renderSlot share (entryKey = tool name, GenericToolCard as the render-site
// fallback).
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
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
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import type {
  CodeSubCall, CommandNode, ConversationNode, ConversationSnapshot, RunningToolCall, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { assistantActionsSeqs, deriveChatFlow, type ChatFlowItem } from './chat-flow.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import { GenericToolCard } from './GenericToolCard.tsx'
import { MessageItem } from './MessageItem.tsx'
import css from './ChatView.module.css'

const FOLLOW_THRESHOLD = 24

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

type OpenFile = (path: string) => void

type InspectCall = (callId: string) => void

/** The declared toolview hole's render share (stable framework binding, passed through memoized rows). */
type RenderToolRow = ChatViewSlotProps['renderSlot']

/** ui-slots' UseSession is deliberately wide (dependency direction); the
 *  chat view narrows once to the runtime snapshot the binding actually feeds. */
type UseConversation = SnapshotSelectorHook<ConversationSnapshot>

function activeRetrySeq(nodes: readonly ConversationNode[], running: boolean): number | null {
  if (!running) return null
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node === undefined) continue
    if (node.kind === 'model-retry') return node.retryState === 'cancelled' ? null : node.seq
    if (node.kind === 'assistant' || node.kind === 'user') return null
  }
  return null
}

/** One `run_code` sub-dispatch row: the identical keyed-slot dispatch as a
 *  top-level call (same registrations, same fallback), nested by the parent.
 *  A started-but-unsettled sub-call arrives as the RunningToolCall shape and
 *  renders the running state exactly as a native in-flight row. */
const SubCallRow = memo(function SubCallRow({ renderSlot, node, openFile, selected, cwd, inspectCall, t }: {
  renderSlot: RenderToolRow
  node: CodeSubCall
  openFile: OpenFile
  selected: boolean
  cwd: string | undefined
  inspectCall: InspectCall
  t: ChatViewSlotProps['t']
}) {
  const settled = 'kind' in node
  const toolName = settled ? node.call?.name ?? '' : node.name
  const owner = useMemo(() => ({
    callId: node.callId, toolName, block: node, openFile, cwd,
    inspect: () => { inspectCall(node.callId) },
  }), [node, toolName, openFile, cwd, inspectCall])
  return (
    <div className={css.callRow} data-selected={selected || undefined}>
      {renderSlot('conversation.chat.toolview', owner, {
        entryKey: toolName,
        fallback: <GenericToolCard {...owner} t={t} />,
      })}
    </div>
  )
})

/** One tool call row (result or running): dispatches through the keyed
 *  toolview slot with the owner payload; unregistered tools fall back to
 *  GenericToolCard at this render site. A `run_code` call additionally
 *  renders its logged sub-dispatches as always-visible indented rows —
 *  each one the same keyed-slot dispatch as a native top-level call. */
const CallRow = memo(function CallRow({
  renderSlot, callId, toolName, block, openFile, selected, subCalls, selectedCallId, cwd, inspectCall, t,
}: {
  renderSlot: RenderToolRow
  callId: string
  toolName: string
  block: ToolResultNode | RunningToolCall
  openFile: OpenFile
  selected: boolean
  /** `run_code` sub-dispatches in dispatch order (reference-stable per
   *  parent; running entries settle in place); undefined for ordinary calls. */
  subCalls?: readonly CodeSubCall[] | undefined
  /** The store's selected callId, matched against sub-rows (undefined when no sub-row here is selected). */
  selectedCallId?: string | undefined
  /** Session workspace root for path-relative summaries. */
  cwd: string | undefined
  inspectCall: InspectCall
  t: ChatViewSlotProps['t']
}) {
  const owner = useMemo(() => ({
    callId, toolName, block, openFile, cwd,
    inspect: () => { inspectCall(callId) },
  }), [callId, toolName, block, openFile, cwd, inspectCall])
  return (
    <div className={css.callRow} data-selected={selected || undefined}>
      {renderSlot('conversation.chat.toolview', owner, {
        entryKey: toolName,
        fallback: <GenericToolCard {...owner} t={t} />,
      })}
      {subCalls !== undefined && subCalls.length > 0 && (
        <div className={css.subCalls} data-subcalls>
          {subCalls.map(node => (
            <SubCallRow
              key={node.callId}
              renderSlot={renderSlot}
              node={node}
              openFile={openFile}
              selected={node.callId === selectedCallId}
              cwd={cwd}
              inspectCall={inspectCall}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
})

/** Consecutive tool results as one step-run group (uniform 16px rhythm). */
const ToolGroup = memo(function ToolGroup({ renderSlot, results, openFile, selectedCallId, codeDispatches, cwd, inspectCall, t }: {
  renderSlot: RenderToolRow
  results: readonly ToolResultNode[]
  openFile: OpenFile
  /** Only set when the selected call lives in THIS group, top-level or nested (memo economy). */
  selectedCallId: string | undefined
  /** Sub-dispatch index off the snapshot (map reference is chunk-storm stable). */
  codeDispatches: ReadonlyMap<string, readonly CodeSubCall[]>
  /** Session workspace root for path-relative summaries. */
  cwd: string | undefined
  inspectCall: InspectCall
  t: ChatViewSlotProps['t']
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
          openFile={openFile}
          selected={node.callId === selectedCallId}
          subCalls={codeDispatches.get(node.callId)}
          selectedCallId={selectedCallId}
          cwd={cwd}
          inspectCall={inspectCall}
          t={t}
        />
      ))}
    </div>
  )
})

/** One command lifecycle row: keyed dispatch on the command name with the
 *  generic card as the render-site fallback (zero registration required). A
 *  run-less cross-window node has no name and always lands on the fallback. */
const CommandRow = memo(function CommandRow({ renderSlot, node, t }: {
  renderSlot: RenderToolRow
  node: CommandNode
  t: ChatViewSlotProps['t']
}) {
  const owner = useMemo(() => ({ node }), [node])
  return (
    <div className={css.callRow}>
      {renderSlot('conversation.chat.commandview', owner, {
        entryKey: node.name ?? '',
        fallback: <GenericCommandCard {...owner} t={t} />,
      })}
    </div>
  )
})

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus() {
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      Deep diving...
    </div>
  )
}

/** The streaming partial, isolated so chunk batches re-render only this tail.
 *  onGrow lets the scroll owner follow content the parent never re-renders for. */
function StreamingTail({ useSession, onGrow, t }: {
  useSession: UseConversation
  onGrow: () => void
  t: ChatViewSlotProps['t']
}) {
  const partial = useSession(s => s.partial)
  useLayoutEffect(() => {
    onGrow()
  })
  if (partial === null) return null
  return <AssistantMarkdown blocks={partial.blocks} streaming t={t} />
}

/**
 * The chat view slot entry: pure component over the composed props (tool rows
 * render through the declared keyed hole's renderSlot share).
 */
export function ChatView({
  useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, inspectCall, chatScroll, forkAt, t,
}: ChatViewSlotProps) {
  const nodes = useSession(s => s.nodes)
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const runningCalls = useSession(s => s.runningCalls)
  const codeDispatches = useSession(s => s.codeDispatches)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => s.selection?.callId)

  const items = useMemo(() => deriveChatFlow(nodes), [nodes])
  const activeRetry = useMemo(() => activeRetrySeq(nodes, running), [nodes, running])
  // Only the last content assistant of each turn owns IconActions; mid-turn
  // text (before tools) omits `time` so AssistantMarkdown stays chrome-free.
  const actionSeqs = useMemo(() => assistantActionsSeqs(nodes), [nodes])

  const listRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Paging anchor: height/position at click, compensated after the prepend lands. */
  const anchorRef = useRef<{ h: number; t: number } | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (that was snapping inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)

  const firstSeq = nodes[0]?.seq ?? null
  const lastItem = items[items.length - 1]
  const lastKey = lastItem?.key ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${nodes.length}:${running ? 1 : 0}:${runningCalls.length}`

  const toBottom = (el: HTMLElement): void => {
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }

  useLayoutEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (openState === 'open' && !openedRef.current) {
      openedRef.current = true
      const saved = chatScroll.read()
      if (saved === null) {
        toBottom(el)
      } else {
        el.scrollTop = saved
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      followSigRef.current = followSig
      return
    }
    // Prepend (head seq decreased): compensate by the height delta.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      el.scrollTop = anchorRef.current.t + (el.scrollHeight - anchorRef.current.h)
      anchorRef.current = null
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const appendedUser = lastKey !== lastKeyRef.current
      && lastItem !== undefined && lastItem.kind === 'node' && lastItem.node.kind === 'user'
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (appendedUser || (tipMoved && atBottomRef.current)) toBottom(el)
  })

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    // Continuous save (unmount happens after ref detach, so saving there is
    // too late); pinned-to-bottom clears so a remount keeps following.
    chatScroll.save(isAtBottom ? null : el.scrollTop)
  }

  // Bind scroll to the resolved scrollport (host or local) once per mount.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [])

  // Follow streaming growth the parent never re-renders for (stable ref).
  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
    }
  }
  const onGrow = useRef(() => followRef.current?.()).current

  const loadOlderAnchored = (): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      anchorRef.current = { h: el.scrollHeight, t: el.scrollTop }
    }
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
          openFile={openFile}
          selectedCallId={inGroup ? selectedCallId : undefined}
          codeDispatches={codeDispatches}
          cwd={cwd}
          inspectCall={inspectCall}
          t={t}
        />
      )
    }
    const node: ConversationNode = item.node
    if (node.kind === 'assistant') {
      return (
        <AssistantMarkdown
          key={item.key}
          blocks={node.blocks}
          streaming={false}
          interrupted={node.interrupted}
          time={actionSeqs.has(node.seq) ? node.time : undefined}
          seq={node.seq}
          onFork={forkAt}
          t={t}
        />
      )
    }
    if (node.kind === 'command') {
      return <CommandRow key={item.key} renderSlot={renderSlot} node={node} t={t} />
    }
    /* v8 ignore next -- tool-result never reaches here: deriveChatFlow folds them into groups. */
    if (node.kind === 'tool-result') return null
    return (
      <MessageItem
        key={item.key}
        node={node}
        retryActive={node.kind === 'model-retry' && node.seq === activeRetry}
        onFork={forkAt}
        t={t}
      />
    )
  }

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll}>
        <div className={css.column}>
          {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
          {openState === 'error' && openError !== null && (
            <div className={css.openError}>
              {t('chat.loadError', { message: openError.message, code: openError.code })}
            </div>
          )}
          {hasMore && (
            <div className={css.older}>
              <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
                {loadingOlder ? t('loading') : t('chat.loadOlder')}
              </button>
            </div>
          )}
          {items.map(renderItem)}
          <StreamingTail useSession={useSession} onGrow={onGrow} t={t} />
          {runningCalls.length > 0 && (
            <div className={css.toolGroup}>
              {runningCalls.map(call => (
                <CallRow
                  key={call.callId}
                  renderSlot={renderSlot}
                  callId={call.callId}
                  toolName={call.name}
                  block={call}
                  openFile={openFile}
                  selected={call.callId === selectedCallId}
                  subCalls={codeDispatches.get(call.callId)}
                  selectedCallId={selectedCallId}
                  cwd={cwd}
                  inspectCall={inspectCall}
                  t={t}
                />
              ))}
            </div>
          )}
          {/* No pending placeholders: questions (ui-question) and approvals
              (ApprovalPanel) both take over the composer, so a flow card would
              double-render the same wait. */}
          {/* Turn-level loading signal: rides the whole running turn (first-token
              wait, tool execution, streaming) so it never flickers per step. */}
          {running && <TurnStatus />}
        </div>
        {!atBottom && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={() => {
                const local = listRef.current
                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                if (local !== null) toBottom(scrollerOf(local))
              }}
            >
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
