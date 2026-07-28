// FoldAdapter: core SurfaceManager wiring + node materialization cache.
// Padding sentinels solve the paged-window seq offset (core fold asserts seq === index);
// a cross-window replace throw degrades to a lenient linear scan (foldDegraded —
// the degradation lives in one branch function in this file, zero scattered removal points).

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Subpath export (package.json exports "./surface", alias added for this): all value imports
// go through it — the package root points at lib/index.js (needs a build) which the vite
// browser bundle cannot resolve; surface.ts has no Node dependencies.
import { SurfaceManager, isSurfaceEligibleType } from '@deepseek-ai/dsh-session/surface'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ToolCallView, ToolEventView, ToolResultView } from '@deepseek-ai/dsh-client-connection/client'
import type { CommandNode, ConversationNode } from './conversation.ts'
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
): ConversationNode {
  switch (event.type) {
    case 'user/message':
      // Injected context (plugin/goal source) folds to a context node, not a
      // user message; only a direct human prompt is a user node.
      if (event.data.source.kind !== 'user') {
        return {
          kind: 'context', seq: event.seq, time: event.time,
          content: event.data.content, source: event.data.source,
        }
      }
      return {
        kind: 'user', seq: event.seq, time: event.time,
        content: event.data.content, source: event.data.source,
      }
    case 'assistant/message':
      return {
        kind: 'assistant', seq: event.seq, time: event.time,
        turn: event.data.turn, step: event.data.step,
        blocks: toAssistantBlocks(event.data.message.content), usage: event.data.usage,
      }
    case 'steering/message':
      return {
        kind: 'steering', seq: event.seq, time: event.time, turn: event.data.turn,
        content: event.data.message.content, source: event.data.message.source,
      }
    case 'tool/result': {
      const result = event.data.message.content[0]
      const callId = String(event.data.message.source.callId)
      const call = callIndex.get(callId)
      return {
        kind: 'tool-result', seq: event.seq, time: event.time,
        callId,
        call: call ? { name: call.name, argsRaw: call.argsRaw } : null,
        callTime: call?.time ?? null,
        content: result.content, isError: result.isError === true,
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
  /**
   * Command lifecycle nodes by commandId (insertion = run order). The
   * `command/run`/`command/done` pair is log-only, so the surface fold never
   * emits it; this index folds the pair (done settles its run's node in
   * place) and nodes() merges the products into the flow by seq. Window cuts
   * soft-fall like tool pairs: a done with no in-window run still builds a
   * node.
   */
  private commandIdx = new Map<string, CommandNode>()
  /** Window revision (bumped on reset/append) keying the nodes() result cache: an unchanged
   *  window returns the previous ARRAY reference, not just cached elements — the snapshot's
   *  reference-stability contract (§A.9.4) starts here. */
  private rev = 0
  private nodesResult: { rev: number; value: { nodes: ConversationNode[]; degraded: boolean } } | null = null

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
    this.baseSeq = baseSeq
    this.padded = []
    for (let i = 0; i < baseSeq; i++) this.padded.push(paddingEvent(i))
    for (const event of events) this.padded.push(event)
    this.surface = new SurfaceManager(this.padded)
    this.nodeCache.clear()
    this.degraded = false
    this.callIdx = new Map()
    this.resultViews.clear()
    this.commandIdx = new Map()
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      /* v8 ignore next -- dense-array guard: i stays within events.length, so the undefined arm needs a sparse array no caller builds. */
      if (event !== undefined) {
        this.indexCall(event, views?.[i])
        this.indexCommand(event)
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
    this.padded.push(event)
    this.indexCall(event, view)
    this.indexCommand(event)
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
      const node = materializeNode(event, this.callIdx, this.resultViews.get(seq) ?? null)
      this.nodeCache.set(seq, node)
      out.push(node)
    }
    // Command nodes fold outside the surface (log-only events); merge by seq.
    // Both inputs are seq-ascending (surface order and run-index insertion
    // order share the log order), so one linear merge keeps flow order.
    let nodes = out
    if (this.commandIdx.size > 0) {
      nodes = []
      const commands = [...this.commandIdx.values()]
      let next = 0
      for (const node of out) {
        for (let cmd = commands[next]; cmd !== undefined && cmd.seq < node.seq; cmd = commands[++next]) {
          nodes.push(cmd)
        }
        nodes.push(node)
      }
      for (let cmd = commands[next]; cmd !== undefined; cmd = commands[++next]) nodes.push(cmd)
    }
    const value = { nodes, degraded: this.degraded }
    this.nodesResult = { rev: this.rev, value }
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

  /** Fold one command lifecycle event into its node (run mints, done settles in place; done-only soft-falls). */
  private indexCommand(event: SessionEvent): void {
    // Log-only plugin events: the host-side dsh-commands declaration cannot
    // enter the client program, so this wire consumer narrows structurally
    // (the same posture as tool/code-dispatch in session.ts).
    if ((event.type as string) === 'command/run') {
      const data = event.data as unknown as { commandId: CommandId; name: string; args: string }
      this.commandIdx.set(data.commandId, {
        kind: 'command', seq: event.seq, time: event.time,
        commandId: data.commandId, name: data.name, args: data.args, outcome: null,
      })
      return
    }
    if ((event.type as string) !== 'command/done') return
    const data = event.data as unknown as { commandId: CommandId; kind: 'success' | 'error'; text?: string }
    const run = this.commandIdx.get(data.commandId)
    const outcome = { kind: data.kind, ...data.text === undefined ? {} : { text: data.text } }
    if (run === undefined) {
      // Cross-window cut: the run page fell out of the window — build the
      // node from the done alone (same soft-fall as a call-less tool result).
      this.commandIdx.set(data.commandId, {
        kind: 'command', seq: event.seq, time: event.time,
        commandId: data.commandId, name: null, args: null, outcome,
      })
      return
    }
    // Settle in place: a fresh node object (published references stay immutable).
    this.commandIdx.set(data.commandId, { ...run, outcome })
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
}
