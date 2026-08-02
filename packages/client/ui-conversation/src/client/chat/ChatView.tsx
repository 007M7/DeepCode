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
import { assistantActionsSeqs, deriveChatFlow, messageBranchSeqs, type ChatFlowItem } from './chat-flow.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import { GenericToolCard } from './GenericToolCard.tsx'
import { MessageItem, PendingSteeringBubble } from './MessageItem.tsx'
import css from './ChatView.module.css'

const FOLLOW_THRESHOLD = 24
const POINTER_CANCEL_GRACE_FRAMES = 8

type VerticalDirection = -1 | 0 | 1

interface ReaderGesture {
  /** Reader-created distance from the followed floor, excluding layout growth. */
  awayDistance: number
  /** Incremented by each qualifying input or host movement. */
  epoch: number
  /** Pointer gestures remain live through their pressed phase. */
  held: boolean
  /** Latest host position, used to reject no-op input events. */
  lastTop: number
  /** Primary pointer that owns a held direct-manipulation gesture. */
  pointerId: number | null
}

/** Whether this element can consume a vertical gesture in the given direction. */
function canScrollVertically(element: HTMLElement, direction: VerticalDirection): boolean {
  if (direction === 0) return element.scrollHeight > element.clientHeight + 1
  if (direction < 0) return element.scrollTop > 1
  return element.scrollTop + element.clientHeight < element.scrollHeight - 1
}

/** A nested overflow owner keeps wheel/key input away from the transcript. */
function nestedOwnsVerticalScroll(
  target: EventTarget | null,
  scrollport: HTMLElement,
  direction: VerticalDirection,
): boolean {
  let current = target instanceof HTMLElement ? target : null
  while (current !== null && current !== scrollport) {
    const style = getComputedStyle(current)
    const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay'
    if (scrollable && current.scrollHeight > current.clientHeight + 1) {
      if (canScrollVertically(current, direction)) return true
      if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') return true
    }
    current = current.parentElement
  }
  return false
}

/** Vertical scrolling keys and their expected host direction. */
function keyDirection(event: globalThis.KeyboardEvent): VerticalDirection | null {
  if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') return -1
  if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') return 1
  if (event.key === ' ' || event.key === 'Spacebar') return event.shiftKey ? -1 : 1
  return null
}

/** Whether the focused control, rather than its scroll ancestor, owns this key. */
function consumesScrollKey(event: globalThis.KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  const editable = target.isContentEditable || target.closest('input, textarea, select') !== null
  if (event.key === ' ' || event.key === 'Spacebar') {
    return editable || target.closest('button, [role="button"], [role="menuitem"]') !== null
  }
  if (event.key === 'PageUp' || event.key === 'PageDown') return false
  return editable || target.closest('[role="tab"], [role="menuitem"], [role="listbox"], [role="option"], [role="slider"], [role="spinbutton"]') !== null
}

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/** Find an already-rendered settled row without interpolating a selector. */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  // Scroll events are hot: hit-test a few points through the stretched flow
  // rows before considering the full mounted set. The fallback keeps jsdom
  // and pre-layout states deterministic; a virtualizer naturally bounds it.
  if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
    const content = list.getBoundingClientRect()
    const left = Math.max(viewport.left, content.left)
    const right = Math.min(viewport.right, content.right)
    const x = left + Math.max(0, right - left) / 2
    const height = visibleBottom - viewport.top
    const points = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)]
    for (const offset of points) {
      for (const element of document.elementsFromPoint(x, viewport.top + offset)) {
        const row = element instanceof HTMLElement
          ? element.closest<HTMLElement>('[data-chat-anchor-key]')
          : null
        if (row !== null && list.contains(row)) return row
      }
    }
  }
  const rows = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
  const visibleRows = rows.filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > viewport.top && rect.top < visibleBottom
  })
  return visibleRows[0] ?? rows[0] ?? null
}

type OpenFile = (path: string) => void

type InspectCall = (callId: string) => void

/** The declared toolview hole's render share (stable framework binding, passed through memoized rows). */
type RenderToolRow = ChatViewSlotProps['renderSlot']

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

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

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
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
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${node.callId}`}
      data-chat-call-id={node.callId}
      data-selected={selected || undefined}
    >
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
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
      data-selected={selected || undefined}
    >
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

/** The streaming partial, isolated so chunk batches re-render only this tail;
 *  the column ResizeObserver owns bottom-follow when its box grows. */
function StreamingTail({ useSession, t }: {
  useSession: UseConversation
  t: ChatViewSlotProps['t']
}) {
  const partial = useSession(s => s.partial)
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
  const turnEnds = useSession(s => s.turnEnds)
  const inbox = useSession(s => s.queue)
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
  const pendingSteering = useMemo(
    () => inbox.filter(item => item.placement === 'steering'),
    [inbox],
  )
  const activeRetry = useMemo(() => activeRetrySeq(nodes, running), [nodes, running])
  // Only the last content assistant of each turn owns IconActions; mid-turn
  // text (before tools) omits `time` so AssistantMarkdown stays chrome-free.
  const actionSeqs = useMemo(() => assistantActionsSeqs(nodes), [nodes])
  const branchSeqs = useMemo(() => messageBranchSeqs(nodes, turnEnds), [nodes, turnEnds])

  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  /** Reader-owned follow intent, distinct from transient bottom geometry. */
  const bottomOwnedRef = useRef(true)
  const [bottomOwned, setBottomOwned] = useState(true)
  /** Distance created by reader movement while follow ownership is retained. */
  const readerAwayRef = useRef(0)
  /** Last scrollTop delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  /** Only an observable reader input may let scroll geometry change follow intent. */
  const readerGestureRef = useRef<ReaderGesture | null>(null)
  const finishReaderGestureRef = useRef<(gesture: ReaderGesture) => void>(() => {})
  const scheduleReaderGestureEndRef = useRef<(gesture: ReaderGesture) => void>(() => {})
  const schedulePointerCancelEndRef = useRef<(gesture: ReaderGesture) => void>(() => {})
  const followRef = useRef<(() => void) | null>(null)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  const lastSteeringIdRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (that was snapping inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)

  const firstSeq = nodes[0]?.seq ?? null
  const lastItem = items[items.length - 1]
  const lastKey = lastItem?.key ?? null
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${nodes.length}:${running ? 1 : 0}:${runningCalls.length}:${lastSteeringId ?? ''}`

  const writeBottom = (el: HTMLElement): void => {
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    readerAwayRef.current = 0
    chatScroll.save(null)
  }

  const cancelReaderGesture = (): void => {
    readerGestureRef.current = null
  }

  const toBottom = (el: HTMLElement): void => {
    cancelReaderGesture()
    anchorRef.current = null
    bottomOwnedRef.current = true
    setBottomOwned(true)
    writeBottom(el)
  }

  const recordReaderPosition = (local: HTMLElement, el: HTMLElement, ownsBottom?: boolean): boolean => {
    const nextOwnsBottom = ownsBottom
      ?? el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
    bottomOwnedRef.current = nextOwnsBottom
    setBottomOwned(nextOwnsBottom)
    const position = nextOwnsBottom ? null : scrollPosition(local, el)
    if (nextOwnsBottom) {
      anchorRef.current = null
      chatScroll.save(null)
    } else {
      if (anchorRef.current !== null && position !== null) {
        anchorRef.current = { key: position.anchorKey, top: position.anchorTop }
      }
      if (position !== null) chatScroll.save(position)
    }
    return nextOwnsBottom
  }

  finishReaderGestureRef.current = (gesture) => {
    if (readerGestureRef.current !== gesture) return
    readerGestureRef.current = null
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const physicalAway = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    if (bottomOwnedRef.current && Math.abs(physicalAway - readerAwayRef.current) > 1) {
      followRef.current?.()
    }
  }

  // A wheel tick, smooth keyboard scroll, or touch fling can span multiple
  // scroll events. End only after two animation frames without new movement;
  // a held pointer keeps the gesture alive across slower frames.
  scheduleReaderGestureEndRef.current = (gesture) => {
    const epoch = gesture.epoch
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (readerGestureRef.current === gesture && gesture.epoch === epoch && !gesture.held) {
          finishReaderGestureRef.current(gesture)
        }
      })
    })
  }

  schedulePointerCancelEndRef.current = (gesture) => {
    const epoch = gesture.epoch
    let frames = POINTER_CANCEL_GRACE_FRAMES
    const waitForScroll = (): void => {
      requestAnimationFrame(() => {
        if (readerGestureRef.current !== gesture || gesture.epoch !== epoch) return
        frames -= 1
        if (frames > 0) waitForScroll()
        else finishReaderGestureRef.current(gesture)
      })
    }
    waitForScroll()
  }

  const armReaderGesture = (
    startTop: number,
    startBottom: number,
    held = false,
    pointerId: number | null = null,
  ): ReaderGesture => {
    const current = readerGestureRef.current
    const persistentAway = bottomOwnedRef.current
      ? readerAwayRef.current
      : Math.max(0, startBottom - startTop)
    const gesture = current ?? {
      awayDistance: persistentAway,
      epoch: 0,
      held: false,
      lastTop: startTop,
      pointerId: null,
    }
    gesture.epoch += 1
    if (held) {
      gesture.held = true
      gesture.pointerId = pointerId
    }
    readerGestureRef.current = gesture
    scheduleReaderGestureEndRef.current(gesture)
    return gesture
  }

  followRef.current = () => {
    const local = listRef.current
    if (local !== null && bottomOwnedRef.current && readerGestureRef.current === null) {
      writeBottom(scrollerOf(local))
    }
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
        cancelReaderGesture()
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        if (isAtBottom) {
          toBottom(el)
        } else {
          observedTopRef.current = el.scrollTop
          readerAwayRef.current = 0
          bottomOwnedRef.current = false
          setBottomOwned(false)
          const normalized = scrollPosition(local, el)
          if (normalized !== null) chatScroll.save(normalized)
        }
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      const row = anchorElement(local, anchor.key)
      cancelReaderGesture()
      if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top
      observedTopRef.current = el.scrollTop
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
      readerAwayRef.current = 0
      bottomOwnedRef.current = isAtBottom
      setBottomOwned(isAtBottom)
      const normalized = isAtBottom ? null : scrollPosition(local, el)
      if (isAtBottom) chatScroll.save(null)
      else if (normalized !== null) chatScroll.save(normalized)
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const appendedUser = lastKey !== lastKeyRef.current
      && lastItem !== undefined && lastItem.kind === 'node' && lastItem.node.kind === 'user'
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because bottomOwnedRef is true (scroll threshold → setState → snap).
    if (appendedUser || appendedSteering
      || (tipMoved && bottomOwnedRef.current && readerGestureRef.current === null)) toBottom(el)
  })

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    const gesture = readerGestureRef.current
    if (gesture !== null) {
      const previousTop = gesture.lastTop
      // A tail shrink can clamp the old scrollTop to the new physical floor
      // before its scroll event arrives. Exclude that forced portion while
      // retaining any reader movement beyond the clamp.
      const currentFloor = Math.max(0, el.scrollHeight - el.clientHeight)
      const baselineTop = Math.min(previousTop, currentFloor)
      const deltaTop = el.scrollTop - baselineTop
      gesture.lastTop = el.scrollTop
      if (Math.abs(deltaTop) > 0.5) {
        gesture.awayDistance = Math.max(0, gesture.awayDistance - deltaTop)
        if (bottomOwnedRef.current) {
          readerAwayRef.current = gesture.awayDistance
          if (!recordReaderPosition(local, el, gesture.awayDistance <= FOLLOW_THRESHOLD + 1)) {
            readerAwayRef.current = 0
          }
        } else {
          // Only reader motion toward the floor may reclaim follow ownership;
          // shrink/clamp or an upward gesture must preserve reading mode.
          const ownsBottom = recordReaderPosition(local, el, deltaTop > 0
            ? undefined
            : false)
          if (ownsBottom) {
            const physicalAway = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
            gesture.awayDistance = physicalAway
            readerAwayRef.current = physicalAway
          } else {
            readerAwayRef.current = 0
          }
        }
      } else if (!bottomOwnedRef.current && Math.abs(el.scrollTop - previousTop) > 0.5) {
        recordReaderPosition(local, el, false)
      }
      gesture.epoch += 1
      scheduleReaderGestureEndRef.current(gesture)
      observedTopRef.current = el.scrollTop
      return
    }

    if (bottomOwnedRef.current) {
      anchorRef.current = null
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (Math.abs(distance) > 1) writeBottom(el)
      else {
        readerAwayRef.current = 0
        chatScroll.save(null)
      }
      observedTopRef.current = el.scrollTop
      return
    }

    // A layout/programmatic event while reading may update the saved semantic
    // position, but cannot silently reclaim or release bottom ownership.
    const position = scrollPosition(local, el)
    if (position !== null) chatScroll.save(position)
    observedTopRef.current = el.scrollTop
  }

  // Bind scroll and its reader-input provenance to the resolved scrollport.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    let wheelStartTop = el.scrollTop
    let wheelStartBottom = el.scrollHeight - el.clientHeight
    let wheelCanMoveHost = false
    let directPointer: {
      id: number
      lastY: number
      startBottom: number
      startTop: number
      target: EventTarget | null
    } | null = null
    let tabStart: { bottom: number; top: number } | null = null
    let tabClearTimer: ReturnType<typeof setTimeout> | null = null

    const clearTabStart = (): void => {
      tabStart = null
      if (tabClearTimer !== null) {
        clearTimeout(tabClearTimer)
        tabClearTimer = null
      }
    }

    const onScroll = (): void => { onScrollRef.current() }
    const onWheelCapture = (event: WheelEvent): void => {
      // Passive wheel delivery may observe compositor-updated geometry before
      // the main-thread scroll event. The last delivered/written top remains
      // the authoritative pre-input baseline.
      wheelStartTop = observedTopRef.current
      wheelStartBottom = el.scrollHeight - el.clientHeight
      const direction: VerticalDirection = event.deltaY < 0 ? -1 : 1
      wheelCanMoveHost = event.deltaY !== 0 && (direction < 0
        ? wheelStartTop > 1
        : wheelStartTop < wheelStartBottom - 1)
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.deltaY === 0) return
      const direction: VerticalDirection = event.deltaY < 0 ? -1 : 1
      if (!wheelCanMoveHost) return
      if (nestedOwnsVerticalScroll(event.target, el, direction)) return
      armReaderGesture(wheelStartTop, wheelStartBottom)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Tab') {
        if (event.defaultPrevented) clearTabStart()
        return
      }
      if (event.defaultPrevented) return
      if (!(event.target instanceof Node) || !el.contains(event.target)) return
      const direction = keyDirection(event)
      if (direction === null) return
      if (consumesScrollKey(event)) return
      if (!canScrollVertically(el, direction)) return
      if (nestedOwnsVerticalScroll(event.target, el, direction)) return
      armReaderGesture(el.scrollTop, el.scrollHeight - el.clientHeight)
    }
    const onTabKeyCapture = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      const start = { bottom: el.scrollHeight - el.clientHeight, top: el.scrollTop }
      tabStart = start
      if (tabClearTimer !== null) clearTimeout(tabClearTimer)
      // The browser's default Tab focus and focus-induced scroll happen after
      // keydown propagation but before the next task. A microtask would clear
      // this provenance before focusin can consume it.
      tabClearTimer = setTimeout(() => {
        if (tabStart === start) tabStart = null
        tabClearTimer = null
      }, 0)
    }
    const onFocusIn = (): void => {
      const start = tabStart
      clearTabStart()
      if (start !== null) armReaderGesture(start.top, start.bottom)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!event.isPrimary) return
      if (event.pointerType === 'mouse') {
        // Native scrollbar/track events target the scrollport; ordinary flow
        // controls target their own element and must not pause follow.
        if (event.button === 0 && event.target === el) {
          armReaderGesture(el.scrollTop, el.scrollHeight - el.clientHeight, true, event.pointerId)
        }
        return
      }
      directPointer = {
        id: event.pointerId,
        lastY: event.clientY,
        startBottom: el.scrollHeight - el.clientHeight,
        startTop: el.scrollTop,
        target: event.target,
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const pointer = directPointer
      if (pointer === null || event.pointerId !== pointer.id) return
      const delta = pointer.lastY - event.clientY
      pointer.lastY = event.clientY
      if (Math.abs(delta) < 2) return
      const direction: VerticalDirection = delta < 0 ? -1 : 1
      if (!canScrollVertically(el, direction)) return
      if (nestedOwnsVerticalScroll(pointer.target, el, direction)) return
      armReaderGesture(pointer.startTop, pointer.startBottom, true, pointer.id)
    }
    const releasePointer = (event: PointerEvent, cancelled: boolean): void => {
      if (!event.isPrimary) return
      if (directPointer?.id === event.pointerId) directPointer = null
      const gesture = readerGestureRef.current
      if (gesture === null || !gesture.held || gesture.pointerId !== event.pointerId) return
      gesture.held = false
      gesture.pointerId = null
      gesture.epoch += 1
      if (cancelled) schedulePointerCancelEndRef.current(gesture)
      else scheduleReaderGestureEndRef.current(gesture)
    }
    const onPointerUp = (event: PointerEvent): void => { releasePointer(event, false) }
    const onPointerCancel = (event: PointerEvent): void => { releasePointer(event, true) }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheelCapture, { capture: true, passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('keydown', onTabKeyCapture, { capture: true })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', onPointerCancel, { passive: true })
    return () => {
      cancelReaderGesture()
      clearTabStart()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheelCapture, true)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onTabKeyCapture, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [])
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    const observer = new ResizeObserver(() => { followRef.current?.() })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => { observer.disconnect() }
  }, [])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  const loadOlderAnchored = (): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        cancelReaderGesture()
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
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
          blocks={node.blocks}
          streaming={false}
          interrupted={node.interrupted}
          time={actionSeqs.has(node.seq) ? node.time : undefined}
          seq={node.seq}
          onFork={forkAt}
          forkUnavailable={!branchSeqs.has(node.seq)}
          t={t}
        />
      )
    }
    if (node.kind === 'command') {
      return <CommandRow renderSlot={renderSlot} node={node} t={t} />
    }
    /* v8 ignore next -- tool-result never reaches here: deriveChatFlow folds them into groups. */
    if (node.kind === 'tool-result') return null
    return (
      <MessageItem
        node={node}
        retryActive={node.kind === 'model-retry' && node.seq === activeRetry}
        onFork={forkAt}
        forkUnavailable={!branchSeqs.has(node.seq)}
        t={t}
      />
    )
  }

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll}>
        <div ref={columnRef} className={css.column} data-chat-flow="">
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
          {items.map(item => (
            <div
              key={item.key}
              className={css.flowItem}
              data-chat-anchor-key={item.kind === 'node' ? `node:${String(item.node.seq)}` : undefined}
              data-chat-flow-key={item.key}
              data-chat-flow-kind={item.kind === 'node' ? item.node.kind : 'tool-group'}
            >
              {renderItem(item)}
            </div>
          ))}
          <StreamingTail useSession={useSession} t={t} />
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
          {pendingSteering.map(item => (
            <PendingSteeringBubble key={item.id} content={item.content} t={t} />
          ))}
        </div>
        {!bottomOwned && (
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
