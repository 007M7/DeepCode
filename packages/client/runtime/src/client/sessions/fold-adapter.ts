// FoldAdapter: core SurfaceManager wiring + node materialization cache.
// Padding sentinels solve the paged-window seq offset (core fold asserts seq === index);
// a cross-window replace throw degrades to a lenient linear scan (foldDegraded —
// the degradation lives in one branch function in this file, zero scattered removal points).

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Subpath export (package.json exports "./surface", alias added for this): all value imports
// go through it — the package root points at lib/index.js (needs a build) which the vite
// browser bundle cannot resolve; surface.ts has no Node dependencies.
import {
  SurfaceManager, isSurfaceEligibleType, isSurfaceEvent,
} from '@deepseek-ai/dsh-session/surface'
import type { ToolCallView, ToolEventView, ToolResultView } from '@deepseek-ai/dsh-client-connection/client'
import type {
  AssistantRequestConfig, AssistantTiming, ConversationContext, ConversationContextOriginKind, ConversationNode,
  ConversationPromptSnapshot,
} from './conversation.ts'
import { toAssistantBlocks } from './conversation.ts'

/** In-window tool/call index entry (result-card backfill + runningCalls material). */
export interface CallIndexEntry {
  name: string
  argsRaw: string
  turn: number
  step: number
  /** Unix epoch ms of the tool/call event. */
  time: number
  /** Wire view riding the tool/call (envelope-level; never inside the event). */
  callView: ToolCallView | null
}

/** Non-surface sentinel used to preserve paged-window sequence offsets.
 * `noop/padding` is deliberately not a real event type, so it cannot acquire
 * surface behavior; this cast is the only synthetic event entry point.
 */
function paddingEvent(seq: number): SessionEvent {
  return { type: 'noop/padding', seq, time: 0, data: {} } as unknown as SessionEvent
}

/** One event -> UI node (pure function; the six-variant ConversationNode union). */
function materializeNode(
  event: SessionEvent,
  callIndex: ReadonlyMap<string, CallIndexEntry>,
  resultView: ToolResultView | null,
  assistantTiming?: AssistantTiming,
  requestConfig?: AssistantRequestConfig,
): ConversationNode {
  switch (event.type) {
    case 'user/message':
      // Injected context (plugin/goal source) folds to a context node, not a
      // user message; only a direct human prompt is a user node.
      if (event.data.source.kind !== 'user') {
        return {
          kind: 'context', seq: event.seq, time: event.time,
          content: event.data.content, source: event.data.source,
          meta: event.data.meta,
        }
      }
      return {
        kind: 'user', seq: event.seq, time: event.time,
        content: event.data.content, source: event.data.source,
        meta: event.data.meta,
      }
    case 'assistant/message':
      return {
        kind: 'assistant', seq: event.seq, time: event.time,
        turn: event.data.turn, step: event.data.step,
        blocks: toAssistantBlocks(event.data.content), usage: event.data.usage,
        provenance: {
          provider: event.data.provenance.provider,
          model: event.data.provenance.model,
        },
        ...(requestConfig === undefined ? {} : { requestConfig }),
        ...(assistantTiming !== undefined ? { timing: assistantTiming } : {}),
      }
    case 'steering/message':
      return {
        kind: 'steering', seq: event.seq, time: event.time, turn: event.data.turn,
        content: event.data.content, source: event.data.source,
        meta: event.data.meta,
      }
    case 'tool/result': {
      const call = callIndex.get(String(event.data.callId))
      return {
        kind: 'tool-result', seq: event.seq, time: event.time,
        callId: String(event.data.callId),
        call: call ? { name: call.name, argsRaw: call.argsRaw } : null,
        callTime: call?.time ?? null,
        content: event.data.content, isError: event.data.isError,
        ...(event.data.error !== undefined ? { error: event.data.error } : {}),
        meta: event.data.meta,
        callView: call?.callView ?? null,
        resultView,
      }
    }
    /* v8 ignore next 2 -- defensive arm: fold output only carries the four
    surface-eligible types, and each has a case above; reachable only if core
    adds an eligible type. */
    default:
      return {
        kind: 'unknown', seq: event.seq, time: event.time,
        type: event.type, data: (event as { data?: unknown }).data,
      }
  }
}

/** Window fold over the core SurfaceManager (sentinel padding for the seq offset; degrades to a linear scan on cross-window replace). */
export class FoldAdapter {
  /** padded = [sentinel x baseSeq, ...window events]; SurfaceManager borrows this reference for lazy incremental folding. */
  private padded: SessionEvent[] = []
  private baseSeq = 0
  private surface = new SurfaceManager(this.padded)
  private nodeCache = new Map<number, ConversationNode>()
  private degraded = false
  private callIdx = new Map<string, CallIndexEntry>()
  /** Wire result views keyed by the tool/result event's seq (views ride the envelope, not the event). */
  private resultViews = new Map<number, ToolResultView>()
  /** Window revision (bumped on reset/append) keying the nodes() result cache: an unchanged
   *  window returns the previous ARRAY reference, not just cached elements — the snapshot's
   *  reference-stability contract (§A.9.4) starts here. */
  private rev = 0
  private nodesResult: { rev: number; value: { nodes: ConversationNode[]; degraded: boolean } } | null = null
  /** Revision of context structure or its request header; unrelated log-only events do not rebuild contexts. */
  private contextRev = 0
  private contextsResult: { rev: number; value: readonly ConversationContext[] } | null = null
  private contextGeneration = 0
  private activePrompt: ConversationPromptSnapshot | undefined
  private promptsByContext = new Map<number, ConversationPromptSnapshot>()

  /** In-window tool/call index (Session uses it for runningCalls and result-card backfill). */
  get callIndex(): ReadonlyMap<string, CallIndexEntry> {
    return this.callIdx
  }

  /**
   * Window rebuild (after open/resync/page prepend): new padded array, new
   * SurfaceManager, cleared cache, rebuilt callIndex.
   * @param events - the new window contents (seq-ascending).
   * @param baseSeq - seq of the window head (sentinels pad below it).
   * @param views - per-event wire views aligned with `events` by index (undefined slots for view-less events).
   */
  reset(events: readonly SessionEvent[], baseSeq: number, views?: readonly (ToolEventView | undefined)[]): void {
    this.rev++
    this.contextRev++
    this.baseSeq = baseSeq
    this.padded = []
    for (let i = 0; i < baseSeq; i++) this.padded.push(paddingEvent(i))
    for (const event of events) this.padded.push(event)
    this.surface = new SurfaceManager(this.padded)
    this.nodeCache.clear()
    this.degraded = false
    this.callIdx = new Map()
    this.resultViews.clear()
    this.contextGeneration = 0
    this.activePrompt = undefined
    this.promptsByContext = new Map()
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      /* v8 ignore next -- dense-array guard: i stays within events.length, so the undefined arm needs a sparse array no caller builds. */
      if (event !== undefined) {
        this.indexCall(event, views?.[i])
        this.indexContextPrompt(event)
      }
    }
  }

  /**
   * Tail append (live session/event): push into the same array (incremental
   * lazy fold applies) + incremental callIndex upkeep.
   * @param event - the live event (seq = window tail + 1).
   * @param view - host-computed tool view paired with the event when it is a tool call/result; indexed for card rendering.
   */
  append(event: SessionEvent, view?: ToolEventView): void {
    this.rev++
    if (isSurfaceEvent(event) || event.type === 'request/header') this.contextRev++
    this.padded.push(event)
    this.indexCall(event, view)
    this.indexContextPrompt(event)
  }

  /**
   * Current node array + degradation flag. Same revision -> same array
   * reference (memo boundary); node object references always come from the per-seq cache.
   * @returns the fold projection for the current window revision.
   */
  nodes(): { nodes: ConversationNode[]; degraded: boolean } {
    if (this.nodesResult !== null && this.nodesResult.rev === this.rev) return this.nodesResult.value
    let seqs: readonly number[]
    if (this.degraded) {
      seqs = this.degradedSeqs()
    } else {
      try {
        seqs = this.surface.nodes
      } catch (error) {
        console.error('[web-runtime] surface fold failed, degrading to linear scan:', error)
        this.degraded = true
        seqs = this.degradedSeqs()
      }
    }
    const out: ConversationNode[] = []
    for (const seq of seqs) {
      const cached = this.nodeCache.get(seq)
      if (cached !== undefined) {
        out.push(cached)
        continue
      }
      const event = this.padded[seq]
      /* v8 ignore next -- sparse guard: both seq sources (surface fold and degradedSeqs) only emit indexes present in padded. */
      if (event === undefined) continue
      const node = materializeNode(
        event,
        this.callIdx,
        this.resultViews.get(seq) ?? null,
        event.type === 'assistant/message' ? this.assistantTiming(event) : undefined,
        event.type === 'assistant/message' ? this.assistantRequestConfig(event) : undefined,
      )
      this.nodeCache.set(seq, node)
      out.push(node)
    }
    const value = { nodes: out, degraded: this.degraded }
    this.nodesResult = { rev: this.rev, value }
    return value
  }

  /**
   * Append-only context generations reconstructed from canonical surface replacements.
   * @returns Frozen historical contexts followed by the current context.
   */
  contexts(): readonly ConversationContext[] {
    if (this.contextsResult !== null && this.contextsResult.rev === this.contextRev) {
      return this.contextsResult.value
    }
    const current = this.nodes()
    if (current.degraded) {
      const value: readonly ConversationContext[] = [{
        id: 0,
        ...(this.activePrompt === undefined ? {} : { prompt: this.activePrompt }),
        nodes: current.nodes,
      }]
      this.contextsResult = { rev: this.contextRev, value }
      return value
    }
    const value = this.surface.contexts.map((context): ConversationContext => {
      const nodes: ConversationNode[] = []
      for (const seq of context.nodes) {
        const node = this.materialize(seq)
        if (node !== undefined) nodes.push(node)
      }
      const prompt = this.promptsByContext.get(context.generation)
      if (context.origin === undefined) {
        return {
          id: context.generation,
          ...(prompt === undefined ? {} : { prompt }),
          nodes,
        }
      }
      const originEvent = this.padded[context.origin.seq]
      return {
        id: context.generation,
        parentId: context.generation - 1,
        origin: contextOriginKind(originEvent),
        originSeq: context.origin.seq,
        ...(originEvent === undefined ? {} : { createdAt: originEvent.time }),
        ...(prompt === undefined ? {} : { prompt }),
        nodes,
      }
    })
    this.contextsResult = { rev: this.contextRev, value }
    return value
  }

  /** Degradation branch: lenient linear scan ignoring surfaceOp/replace (all surface-eligible events in append order). */
  private degradedSeqs(): number[] {
    const seqs: number[] = []
    for (let i = this.baseSeq; i < this.padded.length; i++) {
      const event = this.padded[i]
      if (event !== undefined && isSurfaceEligibleType(event.type)) seqs.push(event.seq)
    }
    return seqs
  }

  private materialize(seq: number): ConversationNode | undefined {
    const cached = this.nodeCache.get(seq)
    if (cached !== undefined) return cached
    const event = this.padded[seq]
    if (event === undefined) return
    const node = materializeNode(
      event,
      this.callIdx,
      this.resultViews.get(seq) ?? null,
      event.type === 'assistant/message' ? this.assistantTiming(event) : undefined,
      event.type === 'assistant/message' ? this.assistantRequestConfig(event) : undefined,
    )
    this.nodeCache.set(seq, node)
    return node
  }

  private assistantTiming(event: SessionEvent<'assistant/message'>): AssistantTiming {
    let stepStartTime: number | null = null
    let firstTokenTime: number | null = null
    for (let i = this.baseSeq; i < this.padded.length; i++) {
      const candidate = this.padded[i]
      if (candidate === undefined || candidate.seq > event.seq) break
      if (
        candidate.type === 'step/start'
        && candidate.data.turn === event.data.turn
        && candidate.data.step === event.data.step
      ) {
        stepStartTime = candidate.time
        continue
      }
      if (
        firstTokenTime === null
        && candidate.type === 'assistant/chunk'
        && candidate.data.turn === event.data.turn
        && candidate.data.step === event.data.step
        && isTokenDelta(candidate.data.chunk)
      ) {
        firstTokenTime = candidate.time
      }
    }
    return { stepStartTime, firstTokenTime, completedTime: event.time }
  }

  private assistantRequestConfig(
    event: SessionEvent<'assistant/message'>,
  ): AssistantRequestConfig | undefined {
    for (let i = event.seq; i >= this.baseSeq; i--) {
      const candidate = this.padded[i]
      if (candidate?.type !== 'request/header') continue
      return candidate.data.header.config
    }
    return undefined
  }

  private indexCall(event: SessionEvent, view?: ToolEventView): void {
    if (event.type === 'tool/result') {
      if (view?.for === 'result') this.resultViews.set(event.seq, view.view)
      return
    }
    if (event.type !== 'tool/call') return
    this.callIdx.set(String(event.data.callId), {
      name: event.data.name, argsRaw: event.data.arguments, turn: event.data.turn, step: event.data.step,
      time: event.time,
      callView: view?.for === 'call' ? view.view : null,
    })
    // No backfill into already-materialized tool-result nodes for this callId
    // (window order puts the call before its result; cannot happen on the normal path).
  }

  private indexContextPrompt(event: SessionEvent): void {
    if (isSurfaceEvent(event) && event.surfaceOp !== 'append') {
      this.contextGeneration++
      if (this.activePrompt !== undefined) {
        this.promptsByContext.set(this.contextGeneration, this.activePrompt)
      }
    }
    if (event.type !== 'request/header') return
    this.activePrompt = {
      config: event.data.header.config,
      system: event.data.header.system ?? '',
      tools: event.data.header.tools ?? [],
    }
    this.promptsByContext.set(this.contextGeneration, this.activePrompt)
  }
}

function contextOriginKind(event: SessionEvent | undefined): ConversationContextOriginKind {
  if (event?.type !== 'user/message') return 'rewrite'
  const source = event.data.source
  if (
    typeof source === 'object'
    && 'kind' in source
    && 'plugin' in source
  ) {
    if (source.plugin === 'compact') return 'compaction'
    if (source.plugin === 'rewind') return 'rewind'
  }
  return 'rewrite'
}

function isTokenDelta(chunk: SessionEvent<'assistant/chunk'>['data']['chunk']): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}
