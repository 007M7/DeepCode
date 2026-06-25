/**
 * `BasicCompactService`: the first implementation of the
 * `@deepseek-ai/dsh-compact` seam. It owns the entire compaction strategy:
 *
 * - **Token estimation** — char/4 heuristic with per-block structural overhead.
 * - **Retention policy** — walk surface nodes tail→head, keep recent nodes up
 *   to a token budget, compact everything older. The cutoff is snapped forward
 *   to the next step boundary so a compacted region never splits a step's
 *   tool-call/result pair (an open tail step is never crossed — compaction
 *   declines and retries once it closes).
 * - **Summarization** — `ctx.llm.stream()` assembled via `BlockAssembler`
 *   (the single model-call surface; same path the loop uses) with a fixed
 *   condense-the-history system prompt.
 * - **Surface mutation** — a single `user/message` replace node carries the
 *   summary; `compact/*` events are log-only lock + provenance records.
 * - **Auto-compaction** — an `agent/request` waterfall listener delegates to
 *   {@link BasicCompactService.compactIfNeeded} before EVERY model call (every
 *   step, so a tool-heavy turn that grows the surface mid-turn still compacts);
 *   it owns the sole token-pressure check.
 *
 * A different backend (real tokenizer, template summarizer, turn-count
 * retention) either subclasses this and overrides the {@link
 * BasicCompactService.estimateContentTokens} / {@link
 * BasicCompactService.summarize} hooks, or implements the abstract
 * {@link CompactService} from scratch.
 *
 * @module @deepseek-ai/dsh-compact-basic
 */

import { Context } from 'cordis'
import { CompactService } from '@deepseek-ai/dsh-compact'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SurfaceNode } from '@deepseek-ai/dsh-session'
import { isStepAlignedStart, isStepAlignedEnd } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BasicCompactConfig, ResolvedConfig } from './types.ts'
import { resolveConfig } from './types.ts'

export type { BasicCompactConfig, ResolvedConfig } from './types.ts'
export { DEFAULTS, resolveConfig } from './types.ts'

/** Per-block structural overhead for JSON framing / type tag. */
const BLOCK_OVERHEAD = 4

/** Heuristic token count for an image block (~85 tokens for low-res URL). */
const IMAGE_TOKEN_COST = 85

/** Role-field framing overhead added per message in {@link BasicCompactService.estimateTokens}. */
const ROLE_OVERHEAD = 4

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization system prompt: instructs the model to condense the
 * conversation into a fixed, fully-populated structure rather than freeform
 * bullets. The fixed structure guarantees coverage of the things a resuming
 * model needs (original intent, pending work, the next step, critical context)
 * and is stable across compaction cycles, so a prior checkpoint can be merged
 * in place. The final rule keys off {@link SUMMARY_OPEN_TAG}: when the
 * transcript already contains a prior checkpoint, the model consolidates rather
 * than re-summarizing it verbatim (a cheap incremental-merge that needs no
 * extra log/event machinery — the tag travels on the summary surface node).
 */
const SUMMARIZE_SYSTEM_PROMPT = [
  'You are a compaction engine for an AI coding assistant. Condense the conversation transcript into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Tasks',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, and function signatures.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization process or that the context was compacted.',
  `- If the transcript already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/**
 * Framing prepended to the landed summary so a resuming model reads it as a
 * checkpoint rather than a fresh user request, and continues the task from it.
 * It summarizes an earlier span of the conversation; the messages that follow
 * are the continuation. Because region compaction can be invoked manually, a
 * surface may hold several checkpoints, so the framing does NOT claim that
 * everything after it is recent or verbatim — only that the captured context
 * should be built on, not restated.
 */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * Map a terminal `FinishReason` to the error a SUMMARIZATION must throw, or
 * `undefined` for an acceptable finish. `FinishReason` is merge-extensible.
 *
 * Compaction fails CLOSED on a truncated summary: `error`, `aborted`, AND
 * `max-tokens` all raise. Unlike an ordinary agent turn — where `max-tokens` is
 * a normal "the model hit its budget" outcome the loop keeps — a summary cut off
 * at the token cap is an INCOMPLETE checkpoint, and committing it would shadow
 * (discard) the real history it summarizes. Raising here keeps the original
 * surface intact (the caller appends `compact/end` with the error and the auto
 * path proceeds with full history). `stop`/future kinds are accepted.
 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error': {
      const error = new Error(finish.message) as Error & { code?: string }
      if (finish.code !== undefined) error.code = finish.code
      return error
    }
    case 'aborted': {
      const error = new Error('summarization stream aborted') as Error & { code?: string }
      error.code = 'ABORTED'
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/**
 * Basic, dependency-light compaction backend. Defaults target a 128K context
 * window, compacting at 80% utilization and retaining ~20K tokens of recent
 * context.
 */
export class BasicCompactService extends CompactService {
  /**
   * `summarize()` reads `ctx.llm.stream()`. Declaring `llm` here lets the cordis
   * context proxy resolve it when this service loads as a sibling of LlmService:
   * without the inject, `this.ctx.llm` cannot be resolved from this fiber and
   * compaction throws at runtime (see postmortem 0001).
   */
  static inject = ['llm']

  /** Resolved configuration (defaults applied). */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: BasicCompactConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)

    if (this.config.auto) {
      // Auto-compaction: delegate to compactIfNeeded before EVERY model call —
      // every step, not just the first. A tool-heavy ReAct turn appends an
      // assistant/message and a tool/result per step, so the surface (and the
      // derived token count) grows within a turn; gating to step 1 would let a
      // runaway turn overflow the window before the next turn's check. The
      // listener stays agnostic — it owns NO threshold logic; compactIfNeeded is
      // the single place that decides whether to compact, and its in-progress
      // lock serializes concurrent attempts.
      ctx.on('agent/request', async (agent: Agent, _turn, _step, request, next) => {
        const before = this.estimateTokens(request.messages, request.system)
        try {
          const result = await this.compactIfNeeded(agent.session, request.system, request.model, request.signal)
          if (result) {
            // The surface has been mutated — re-derive messages for the call.
            const rederived = agent.session.deriveMessages()
            const afterTokens = this.estimateTokens(rederived, request.system)

            ctx.logger.info(
              `compaction: shadowed ${result.shadowedSeqs.length} surface nodes ` +
              `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ` +
              `~${result.shadowedTokenCount} tokens) ` +
              `→ ${afterTokens} estimated tokens after compaction ` +
              `(pressure was ~${before})`,
            )

            request.messages = rederived
          }
        } catch (error: unknown) {
          // A failed compaction must not prevent the model call — proceed
          // with the original messages.
          const msg = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`compaction failed: ${msg}; proceeding with full history`)
        }

        return next()
      })
    }
  }

  // ---- Token estimation (overridable hooks) ----

  /**
   * Estimate the token count of content blocks — char/4 with per-block
   * overhead. Override in a subclass to plug in a real tokenizer.
   */
  estimateContentTokens(blocks: readonly ContentBlock[]): number {
    let tokens = 0
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          tokens += Math.ceil(block.text.length / 4) + BLOCK_OVERHEAD
          break
        case 'tool-call':
          tokens += Math.ceil(block.name.length / 4)
            + Math.ceil(block.arguments.length / 4)
            + BLOCK_OVERHEAD
          break
        case 'tool-result':
          tokens += this.estimateContentTokens(block.content) + BLOCK_OVERHEAD
          break
        case 'image':
          tokens += IMAGE_TOKEN_COST
          break
        default:
          // Unknown block types (merge-extensible ContentBlockMap):
          // estimate conservatively via JSON stringify.
          tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / 4)
      }
    }
    return tokens
  }

  /**
   * Estimate token count for a single session event. Returns 0 for non-message
   * event types (boundaries, chunks, usage, errors, compact markers).
   */
  estimateEventTokens(event: SessionEvent): number {
    switch (event.type) {
      case 'user/message':
      case 'assistant/message':
      case 'context/message':
      case 'steering/message':
      case 'tool/result':
        return this.estimateContentTokens(event.data.content)
      default:
        return 0
    }
  }

  /** Estimate total tokens across a list of messages plus optional system prompt. */
  estimateTokens(messages: readonly Message[], systemPrompt?: string): number {
    let total = 0
    for (const msg of messages) {
      total += this.estimateContentTokens(msg.content)
      total += ROLE_OVERHEAD
    }
    if (systemPrompt) total += Math.ceil(systemPrompt.length / 4)
    return total
  }

  /**
   * Summarize conversation text into content blocks via `ctx.llm.stream()`
   * assembled through a `BlockAssembler` (the single model-call surface).
   * Override in a subclass for a template or remote summarizer.
   *
   * Honors the adapter failure contract: an adapter may report a model failure
   * by throwing from `stream()` (propagated here) OR by ending the stream with
   * a `finish {kind:'error'|'aborted'}` chunk — the latter is re-thrown so a
   * provider error never yields an empty summary.
   *
   * Forwards `signal` into `GenerateOptions.signal` so an abort/dispose tears
   * down the in-flight summarization rather than orphaning the model call.
   */
  async summarize(text: string, model: string, signal?: AbortSignal): Promise<ContentBlock[]> {
    if (!model) throw new Error('no model available for summarization')

    const assembler = new BlockAssembler()
    const options: GenerateOptions = {
      model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Summarize this conversation history:\n\n${text}\n\nSummary:` }],
      }],
      system: SUMMARIZE_SYSTEM_PROMPT,
      maxTokens: this.config.summarizationMaxTokens,
    }
    // exactOptionalPropertyTypes: only set `signal` when present — assigning
    // `undefined` to an optional `signal?: AbortSignal` is a type error.
    if (signal) options.signal = signal
    for await (const chunk of this.ctx.llm.stream(options)) {
      assembler.push(chunk)
    }

    const error = finishError(assembler.finish)
    if (error) throw error

    return assembler.message().content
  }

  // ---- Core API (implements the abstract contract) ----

  /**
   * The sole token-pressure gate: estimate the current history, and if it
   * exceeds the threshold (`contextWindow * thresholdRatio`), compact the oldest
   * surface nodes outside the `retainTokens` budget. The auto-compaction listener
   * delegates here rather than pre-checking, so this is the only place the
   * decision lives.
   */
  override async compactIfNeeded(
    session: Session,
    systemPrompt?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null> {
    const messages = session.deriveMessages()
    const totalTokens = this.estimateTokens(messages, systemPrompt)

    const threshold = Math.floor(this.config.contextWindow * this.config.thresholdRatio)
    if (totalTokens < threshold) return null

    // Walk surface nodes tail→head, accumulating token estimates.
    const nodes = session.surface.nodes
    if (nodes.length === 0) return null

    const retainBudget = this.config.retainTokens
    // ALWAYS retain the IN-FLIGHT turn's surface nodes verbatim — its initiating
    // user request and any mid-turn tool results are the exact input/observation
    // the model is acting on right now, even if they exceed the soft retain
    // budget. Compacting them would hand the model a lossy summary of its own
    // current task. Only nodes in PRIOR (closed) turns are eligible to compact;
    // `protectedIdx` is the first surface node of the open turn (or `nodes.length`
    // when the open turn has no surface nodes yet, e.g. before step 1).
    const protectedIdx = this._openTurnFirstSurfaceIdx(session, nodes)
    if (protectedIdx === 0) return null

    let accumulated = 0
    let cutoffIdx = -1
    // Seed the accumulator with the protected suffix so the retain budget is
    // measured against what actually stays, then look for a cutoff only among
    // the older (compactable) nodes.
    for (let i = nodes.length - 1; i >= protectedIdx; i--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const event = session.events[nodes[i]!.seq]
      if (event) accumulated += this.estimateEventTokens(event)
    }

    for (let i = protectedIdx - 1; i >= 0; i--) {
      // nodes[i] bounded by i >= 0 and i < nodes.length — never undefined.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const node = nodes[i]!
      const event = session.events[node.seq]
      /* v8 ignore next -- node.seq is a surface-node seq, always a valid log index by construction */
      if (!event) continue
      accumulated += this.estimateEventTokens(event)
      if (accumulated > retainBudget) {
        cutoffIdx = i
        break
      }
    }

    // If we walked the entire compactable range without exceeding the budget,
    // everything outside the protected in-flight turn fits — no compaction
    // needed.
    if (cutoffIdx === -1) return null

    // Snap the cutoff to a step-aligned end so the compacted region never splits
    // a step (which would orphan a tool-call or its tool/result). The token
    // budget is a soft target. PREFER snapping FORWARD (compact slightly more
    // recent context to reach a clean boundary), but never into the protected
    // in-flight turn: if the forward snap would reach `protectedIdx`, fall back
    // to snapping BACKWARD to the previous step-aligned end (compact slightly
    // less), and decline only if no step-aligned end exists in the compactable
    // range at all.
    const events = session.events
    cutoffIdx = this._snapCutoff(events, nodes, cutoffIdx, protectedIdx)
    if (cutoffIdx === -1) return null

    // nodes is non-empty (checked above) and cutoffIdx is a valid index.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstSeq = nodes[0]!.seq
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const cutoffSeq = nodes[cutoffIdx]!.seq
    const resolvedModel = model ?? ''

    return this.compactRegion(session, firstSeq, cutoffSeq, resolvedModel, signal)
  }

  override async compactRegion(
    session: Session,
    start: number,
    end: number,
    model: string,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    // Resolve the range by surface POSITION, not numeric seq interval. A prior
    // replace lands a fresh high-seq summary node AT the shadowed range's
    // position, so the surface order (head→tail) no longer tracks seq order —
    // `[newSummarySeq, olderRetainedSeq, …]` is normal. Indexing into the
    // ordered node list and slicing it is the only correct way to read a range;
    // a `node.seq >= start && node.seq <= end` interval test would mis-collect
    // nodes (and `start > end` would falsely reject) once that happens.
    const nodes = session.surface.nodes
    const startIdx = nodes.findIndex(n => n.seq === start)
    const endIdx = nodes.findIndex(n => n.seq === end)
    if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
    if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
    if (startIdx > endIdx) {
      throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`)
    }

    // The region must contain whole steps, never split a step's
    // assistant-message tool-calls from their tool/results (which would orphan
    // one side and produce a transcript every provider rejects). A boundary is
    // valid when it sits on a step edge or on a node that belongs to no step
    // (pre-step user message, inter-step steering, injection context); an `end`
    // inside an open (unclosed) tail step is also rejected — its tool-calls have
    // no results yet. See dsh-session's step-boundary predicates.
    const events = session.events
    if (!isStepAlignedStart(events, start)) {
      throw new Error(`compactRegion: start seq ${start} is not on a step boundary (would split a step's tool-call/result pair)`)
    }
    if (!isStepAlignedEnd(events, end)) {
      throw new Error(`compactRegion: end seq ${end} is not on a step boundary (would split a step, or the step is still open)`)
    }

    if (this._isCompactionInProgress(session)) {
      throw new Error('compaction already in progress')
    }

    // Compaction's events (compact/* and the replacement user/message) must be
    // turn-enclosed: the session-log contract rejects any plugin event appended
    // outside an open turn. Auto-compaction satisfies this — it runs inside the
    // `agent/request` waterfall, strictly between a turn's start and end. A
    // manual call on a fully-closed session has no turn to enclose the events,
    // so reject rather than emit an un-enclosed run.
    const turn = this._openTurn(session)
    if (turn === null) {
      throw new Error('compactRegion: no open turn — compaction events must be enclosed in a turn')
    }
    // Slice the ordered surface nodes [startIdx, endIdx] inclusive — the
    // shadowed range is positional, so this is the set the replace op covers.
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1).map(n => n.seq)

    // --- Acquire lock ---
    const startEvent = session.append('compact/start', { turn })

    try {
      // --- Extract text and summarize ---
      const text = this._extractText(session, shadowedSeqs)
      const summaryModel = this.config.summarizationModel || model
      const summary = await this.summarize(text, summaryModel, signal)

      // Estimate token count of the shadowed content for provenance.
      let shadowedTokenCount = 0
      for (const seq of shadowedSeqs) {
        // seq comes from a surface node — always a valid log index by construction.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        shadowedTokenCount += this.estimateEventTokens(session.events[seq]!)
      }

      // --- Provenance record (log-only) ---
      const summaryEvent = session.append('compact/summary', {
        summary,
        shadowedRange: { start, end },
        shadowedSeqs,
        shadowedTokenCount,
      })

      // --- Surface replacement ---
      // The user/message directly shadows all compacted surface nodes with a
      // single replace op. It is the ONLY surface event in the compaction
      // sequence — compact/start, compact/summary, and compact/end are log-only
      // (surfaceOp is rejected by the compiler for non-SurfaceEventType).
      // The landed content is FRAMED (checkpoint preamble + tag-wrapped summary);
      // the compact/summary provenance event above holds the raw model output.
      session.append('user/message', {
        content: this._frameSummary(summary),
        source: { kind: 'plugin', plugin: 'compact' },
      }, {
        surfaceOp: { op: 'replace', start, end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
      })

      // --- Release lock (log-only) ---
      // Appended LAST so the lock brackets the WHOLE operation: a crash between
      // compact/start and here leaves a detectable orphaned lock (a compact/start
      // with no matching compact/end) rather than a compact/end that falsely
      // claims compaction finished before the surface replacement landed.
      const endEvent = session.append('compact/end', { turn })

      return {
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary,
        shadowedRange: { start, end },
        shadowedSeqs,
        shadowedTokenCount,
      }
    } catch (error: unknown) {
      // Always release the lock — append compact/end with the error so a
      // wedged lock is impossible.
      const msg = error instanceof Error ? error.message : String(error)
      session.append('compact/end', { turn, error: msg })
      throw error
    }
  }

  // ---- Internal helpers ----

  /**
   * The index of the first surface node that belongs to the currently-open turn
   * — the boundary of the protected, never-compacted suffix. Returns
   * `nodes.length` when the open turn has contributed no verbatim surface node
   * yet (e.g. before step 1 appends anything), so the whole surface is
   * compaction-eligible up to the tail.
   *
   * The in-flight turn's verbatim nodes (its request, mid-turn assistant
   * messages, tool results — all `append` ops) form a CONTIGUOUS run at the TAIL
   * of the surface. A compaction replacement node, though also appended during
   * the open turn (seq > `turn/start`), lands at the position of the older range
   * it shadowed — earlier in the surface, NOT in the tail run — so it is itself
   * compaction-eligible (a later cycle can merge it). The protected suffix is
   * therefore the contiguous tail run of nodes whose seq exceeds the open turn's
   * `turn/start`, found by walking from the tail. With no open turn (a closed
   * session — only manual `compactRegion`, never the auto path), nothing is
   * protected and this returns `nodes.length`.
   */
  private _openTurnFirstSurfaceIdx(session: Session, nodes: readonly SurfaceNode[]): number {
    const openTurn = this._openTurn(session)
    if (openTurn === null) return nodes.length
    // Find the open turn's turn/start seq (scanning back from the tail).
    let turnStartSeq = -1
    for (let i = session.events.length - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const e = session.events[i]!
      if (e.type === 'turn/start' && e.data.turn === openTurn) { turnStartSeq = e.seq; break }
    }
    /* v8 ignore next -- _openTurn returned non-null, so its turn/start exists */
    if (turnStartSeq === -1) return nodes.length
    // Walk from the tail while nodes belong to the open turn (seq > turn/start),
    // taking only the CONTIGUOUS run — a compaction summary node appended this
    // turn but sitting earlier in the surface stops the run and stays eligible.
    let idx = nodes.length
    while (idx > 0 && nodes[idx - 1]!.seq > turnStartSeq) idx -= 1 // eslint-disable-line @typescript-eslint/no-non-null-assertion
    return idx
  }

  /**
   * Snap a raw token-budget cutoff index to a step-aligned end among the nodes
   * BELOW the protected suffix (`protectedIdx`, the first node of the in-flight
   * turn). Returns the snapped index, or `-1` if no step-aligned end exists in
   * the compactable range (e.g. it is empty, or its only content is an open tail
   * step).
   *
   * Prefers snapping FORWARD to the next step-aligned end (compact slightly more
   * recent context for a clean boundary); if the forward scan reaches
   * `protectedIdx` without finding one, falls back to scanning BACKWARD from the
   * raw cutoff (compact slightly less). The protected suffix is never returned —
   * it stays verbatim so the model sees its current task, not a summary.
   */
  private _snapCutoff(
    events: readonly SessionEvent[],
    nodes: readonly SurfaceNode[],
    rawCutoffIdx: number,
    protectedIdx: number,
  ): number {
    // Forward: the next step-aligned end strictly below the protected suffix.
    for (let i = rawCutoffIdx; i < protectedIdx; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (isStepAlignedEnd(events, nodes[i]!.seq)) return i
    }
    // Backward: the nearest step-aligned end at or below the raw cutoff.
    for (let i = rawCutoffIdx - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (isStepAlignedEnd(events, nodes[i]!.seq)) return i
    }
    return -1
  }

  /**
   * Frame the raw summary blocks into the content that lands on the surface:
   * a checkpoint preamble (so a resuming model reads it as a checkpoint, not a
   * fresh user request) followed by the summary wrapped in
   * {@link SUMMARY_OPEN_TAG}/{@link SUMMARY_CLOSE_TAG}. The tags make a prior
   * checkpoint detectable in the transcript on the next compaction cycle, which
   * triggers the merge rule in the summarization prompt. The raw, unframed
   * `summary` is preserved separately on the `compact/summary` provenance event.
   */
  private _frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
    return [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      ...summary,
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ]
  }

  /**
   * Whether a compaction is currently in progress for `session` — an unmatched
   * `compact/start` (no later `compact/end`) WITHIN the current turn.
   *
   * The scan is scoped to the current turn: walking back from the tail it stops
   * at the first `turn/end` (the boundary closing the prior turn). A
   * `compact/start` left orphaned by a crash mid-compaction lives in a turn that
   * persistence repair then closes with a synthetic `turn/end`; scoping here so
   * that a stale orphan from a PAST turn cannot wedge compaction forever (it sits
   * before the nearest `turn/end`, so the scan never reaches it). An in-progress
   * compaction's `compact/start` is always in the still-open current turn,
   * before any `turn/end`, so it is still detected.
   */
  private _isCompactionInProgress(session: Session): boolean {
    const events = session.events
    for (let i = events.length - 1; i >= 0; i--) {
      // Index bounded by i >= 0 and i < events.length — never undefined.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const e = events[i]!
      if (e.type === 'compact/start') return true
      if (e.type === 'compact/end') break
      // A turn/end bounds the scan: anything before it belongs to a prior
      // (closed) turn and cannot be an in-progress compaction of THIS turn.
      if (e.type === 'turn/end') break
    }
    return false
  }

  /**
   * The turn number of the currently OPEN turn — a `turn/start` not yet
   * followed by its `turn/end` — or `null` if the session has no open turn.
   *
   * Compaction's events must be enclosed in a turn, so scanning back from the
   * tail: a `turn/start` means that turn is open (return it); a `turn/end` means
   * the most recent turn already closed (return null). The whole compaction
   * sequence (compact/start … compact/end) is stamped with this turn.
   */
  private _openTurn(session: Session): number | null {
    for (let i = session.events.length - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const e = session.events[i]!
      if (e.type === 'turn/start') return e.data.turn
      if (e.type === 'turn/end') return null
    }
    return null
  }

  /**
   * Extract plain-text conversation from a set of surface node seqs, for
   * feeding into the summarization model. Walks events in log order so the
   * summary captures chronological flow.
   */
  private _extractText(session: Session, seqs: number[]): string {
    const lines: string[] = []

    // Walk seqs in the order given (surface order, as compactRegion slices the
    // surface-node list) — NOT ascending log-seq order. After a replace the
    // summary node carries a fresh high seq while sitting at the head of the
    // surface before older retained lower-seq nodes, so a log-order scan would
    // feed the transcript out of order and break the checkpoint-merge prompt.
    for (const seq of seqs) {
      const event = session.events[seq]
      /* v8 ignore next -- seq is a surface-node seq, always a valid log index by construction */
      if (!event) continue

      switch (event.type) {
        case 'user/message': {
          const text = this._blocksToText(event.data.content)
          if (text) lines.push(`User: ${text}`)
          break
        }
        case 'assistant/message': {
          const text = this._blocksToText(event.data.content)
          if (text) lines.push(`Assistant: ${text}`)
          break
        }
        case 'tool/result': {
          const text = this._blocksToText(event.data.content)
          const label = event.data.isError ? 'Tool error' : 'Tool result'
          if (text) lines.push(`${label} (call ${event.data.callId}): ${text}`)
          break
        }
        case 'context/message': {
          const text = this._blocksToText(event.data.content)
          if (text) lines.push(`[Context: ${text}]`)
          break
        }
        case 'steering/message': {
          const text = this._blocksToText(event.data.content)
          if (text) lines.push(`[Steering: ${text}]`)
          break
        }
        // SessionEventMap is merge-extensible — unknown types are
        // non-message events that carry no extractable text.
        /* v8 ignore next 2 -- seqs only name surface nodes, always one of the 5 handled SurfaceEventTypes; unreachable */
        default:
          break
      }
    }

    return lines.join('\n\n')
  }

  /**
   * Render content blocks to a single plain-text string for the summarization
   * prompt. Text and reasoning contribute their text; every other block type
   * contributes a type-tagged placeholder (`[image]`, `[tool-call: name(args)]`,
   * …) so the summarizer is told what non-text content existed in the region
   * rather than silently losing it. Blocks join with newlines; empty-text
   * blocks contribute nothing.
   */
  private _blocksToText(blocks: readonly ContentBlock[]): string {
    const parts: string[] = []
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text) parts.push(block.text)
          break
        case 'reasoning':
          if (block.text) parts.push(`[reasoning: ${block.text}]`)
          break
        case 'tool-call':
          parts.push(`[tool-call: ${block.name}(${block.arguments})]`)
          break
        case 'tool-result': {
          const inner = this._blocksToText(block.content)
          parts.push(inner ? `[tool-result: ${inner}]` : '[tool-result]')
          break
        }
        case 'image':
          parts.push('[image]')
          break
        // ContentBlockMap is merge-extensible — render an unknown block as a
        // bare type-tagged placeholder so a plugin-added block type is still
        // signalled to the summarizer rather than dropped.
        default:
          parts.push(`[${(block as ContentBlock).type}]`)
      }
    }
    return parts.join('\n')
  }
}

export default BasicCompactService
