/**
 * `BasicCompactService`: the first implementation of the
 * `@deepseek-ai/dsh-compact` seam. It owns the entire compaction strategy:
 *
 * - **Token estimation** — chars/`charsPerToken` heuristic (config, default 4)
 *   with per-block structural overhead.
 * - **Retention policy** — walk surface nodes tail→head, keep recent nodes up
 *   to a token budget, compact everything older. The cutoff is snapped forward
 *   to the next balanced tool-pairing boundary so a compacted region never
 *   splits a step's tool-call/result pair (an open tail step is never crossed —
 *   compaction declines and retries once it closes).
 * - **Summarization** — a direct one-shot `ctx.llm.stream()` call assembled
 *   via `BlockAssembler` with a fixed condense-the-history system prompt;
 *   NOT a loop step, so `agent/request` never fires — interception happens
 *   at `llm/stream` like any other direct call.
 * - **Surface mutation** — a single `user/message` replace node carries the
 *   summary; `compact/*` events are log-only lock + provenance records.
 * - **Auto-compaction** — an `agent/pre-step` listener delegates to
 *   {@link BasicCompactService.compactIfNeeded} before EVERY step (so a
 *   tool-heavy turn that grows the surface mid-turn still compacts); it owns the
 *   sole token-pressure check.
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
import { CompactService, renderTranscript } from '@deepseek-ai/dsh-compact'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isToolPairingBalanced } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BasicCompactConfig, ResolvedConfig } from './types.ts'
import { resolveConfig } from './types.ts'

export type { BasicCompactConfig, ResolvedConfig } from './types.ts'
export { resolveConfig } from './types.ts'

/** Per-block structural overhead for JSON framing / type tag. */
const BLOCK_OVERHEAD = 4

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
 * Basic, dependency-light compaction backend: estimates the surface's token
 * footprint, summarizes the stale prefix through the model, and shadows it
 * behind a durable checkpoint. Every threshold/budget knob is required config
 * ({@link BasicCompactConfig}); the estimator's text density is the
 * `charsPerToken` knob.
 */
export class BasicCompactService extends CompactService {
  static inject = ['llm']

  /** Resolved configuration (`auto` defaulted). */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: BasicCompactConfig) {
    super(ctx)
    this.config = resolveConfig(config)

    if (this.config.auto) {
      // Auto-compaction: delegate to compactIfNeeded before EVERY step. This is
      // LOAD-BEARING for runaway-turn survival: a tool-heavy ReAct turn appends
      // an assistant/message and a tool/result per step, so the surface (and the
      // derived token count) grows WITHIN a turn. The only moment to rescue a
      // turn that alone approaches the window is the next step's pre-step
      // checkpoint; gating to a turn's first step would let a runaway turn
      // overflow before the next turn's check. The listener owns NO threshold
      // logic — compactIfNeeded is the single place that decides whether to
      // compact, and its in-progress lock serializes concurrent attempts.
      //
      // It runs on `agent/pre-step` (a serial surface-mutation checkpoint fired
      // AFTER turn/start but BEFORE step/start), NOT `agent/request`: compaction
      // mutates the session surface, and the loop derives the request `messages`
      // AFTER this fires — so a single derive already reflects the compaction,
      // with no double-derive and no need to rewrite an already-assembled
      // `messages` array. Firing pre-step (outside any open step) keeps the
      // log-only `compact/*` records and the replacement node cleanly outside a
      // step, so a crash mid-compaction leaves an inert orphan the turn-repair
      // closes — never a half-open step.
      ctx.on('agent/pre-step', async (agent: Agent, _turn: number, _step: number, fullSystemPrompt: string, sessionPrefix: readonly Message[], signal: AbortSignal) => {
        try {
          const result = await this.compactIfNeeded(agent, fullSystemPrompt, sessionPrefix, signal)
          if (result) {
            const after = this.estimatePressure(agent.session, fullSystemPrompt, sessionPrefix)
            ctx.logger.info(
              `compaction: shadowed ${result.shadowedSeqs.length} surface nodes ` +
              `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ` +
              `~${result.shadowedTokenCount} tokens) ` +
              `→ ${after} estimated tokens after compaction`,
            )
          }
        } catch (error: unknown) {
          // A failed compaction must not prevent the model call — the surface is
          // untouched on failure, so the loop derives the full history and the
          // call proceeds.
          const msg = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`compaction failed: ${msg}; proceeding with full history`)
        }
      })
    }
  }

  // ---- Token estimation (overridable hooks) ----

  // TODO: chars/charsPerToken is a coarse heuristic. Replace with an exact
  // count — a real tokenizer, or the provider's post-response `usage` (input
  // tokens) fed back as a correction — so threshold decisions match the
  // model's actual budget.
  /**
   * Estimate the token count of content blocks — chars divided by the
   * `charsPerToken` config, with per-block overhead. Override in a subclass to
   * plug in a real tokenizer.
   *
   * @param blocks - the blocks to estimate; `tool-result` blocks recurse into
   *   their nested content, and unknown (merge-extended) types fall back to
   *   their JSON-stringified length.
   * @returns the estimated token count.
   */
  estimateContentTokens(blocks: readonly ContentBlock[]): number {
    const { charsPerToken } = this.config
    let tokens = 0
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          tokens += Math.ceil(block.text.length / charsPerToken) + BLOCK_OVERHEAD
          break
        case 'tool-call':
          tokens += Math.ceil(block.name.length / charsPerToken)
            + Math.ceil(block.arguments.length / charsPerToken)
            + BLOCK_OVERHEAD
          break
        case 'tool-result':
          tokens += this.estimateContentTokens(block.content) + BLOCK_OVERHEAD
          break
        default:
          // Unknown block types (merge-extensible ContentBlockMap):
          // estimate conservatively via JSON stringify.
          tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / charsPerToken)
      }
    }
    return tokens
  }

  /**
   * Estimate token count for a single session event. Returns 0 for non-message
   * event types (boundaries, chunks, usage, errors, compact markers).
   *
   * @param event - any session event; only the message-bearing types carry
   *   content to count.
   * @returns the estimated token count of the event's content, or 0 for a
   *   non-message event.
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

  /**
   * Estimate total tokens across a list of messages plus optional system prompt.
   *
   * @param messages - the derived conversation messages; each adds a fixed
   *   role-framing overhead on top of its content estimate.
   * @param systemPrompt - counted at chars / `charsPerToken` when provided.
   * @returns the estimated token footprint of the whole request.
   */
  estimateTokens(messages: readonly Message[], systemPrompt?: string): number {
    let total = 0
    for (const msg of messages) {
      total += this.estimateContentTokens(msg.content)
      total += ROLE_OVERHEAD
    }
    if (systemPrompt) total += Math.ceil(systemPrompt.length / this.config.charsPerToken)
    return total
  }

  /**
   * Summarize conversation text into content blocks via `ctx.llm.stream()`
   * assembled through a `BlockAssembler`. A direct one-shot model call, NOT a
   * loop step: it does not run the `agent/request` waterfall (that seam shapes
   * the loop's conversation requests); per-call
   * interception happens at `llm/stream` like any other direct call. The model
   * comes from `BasicCompactConfig.summarizationModel`, falling back to the
   * agent's own model.
   * Override in a subclass for a template or remote summarizer.
   *
   * Honors the adapter failure contract: an adapter may report a model failure
   * by throwing from `stream()` (propagated here) OR by ending the stream with
   * a `finish {kind:'error'|'aborted'}` chunk — the latter is re-thrown so a
   * provider error never yields an empty summary.
   *
   * Forwards `signal` into `GenerateOptions.signal` so an abort/dispose tears
   * down the in-flight summarization rather than orphaning the model call.
   *
   * Returns the summary blocks TOGETHER with the call envelope it actually
   * used (`model`, `maxTokens`) — the caller logs the envelope on the
   * `compact/summary` provenance event, so an overriding subclass (template
   * or remote summarizer) reports its own envelope honestly.
   *
   * @param text - plain-text rendering of the conversation region to condense.
   * @param agent - supplies the fallback model and the session id stamped on
   *   the call; throws when neither it nor the config names a model.
   * @param signal - optional abort signal, forwarded into the model call.
   * @returns the text-only summary blocks plus the call envelope used
   *   (`model`, and `maxTokens` when the summarizer has a cap).
   */
  async summarize(
    text: string, agent: Agent, signal?: AbortSignal,
  ): Promise<{ summary: ContentBlock[]; model: string; maxTokens?: number }> {
    const assembler = new BlockAssembler()
    const options: GenerateOptions = {
      model: this.config.summarizationModel || agent.options.model || '',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Summarize this conversation history:\n\n${text}\n\nSummary:` }],
      }],
      system: SUMMARIZE_SYSTEM_PROMPT,
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
    }
    // exactOptionalPropertyTypes: only set `signal` when present — assigning
    // `undefined` to an optional `signal?: AbortSignal` is a type error.
    if (signal) options.signal = signal
    if (!options.model) {
      throw new Error('no model available for summarization: set BasicCompactConfig.summarizationModel or AgentOptions.model')
    }
    for await (const chunk of this.ctx.llm.stream(options)) {
      assembler.push(chunk)
    }

    const error = finishError(assembler.finish)
    if (error) throw error

    const summary = this._textOnly(assembler.message().content)
    if (!summary.some(block => block.type === 'text' && block.text.trim().length > 0)) {
      throw new Error('summarization produced no text summary content')
    }

    // config.maxTokens is required and validated positive, so this backend's
    // envelope always carries the cap; the return type's optionality exists
    // for overriding subclasses whose summarizer has none.
    return { summary, model: options.model, maxTokens: this.config.maxTokens }
  }

  // ---- Core API (implements the abstract contract) ----

  /**
   * The sole token-pressure gate: estimate the NEXT request's pressure — the
   * session prefix + the surface-derived history + the system prompt
   * ({@link estimatePressure}) — and if it exceeds the threshold
   * (`contextWindow * thresholdRatio`), compact
   * the oldest surface nodes outside the `retainTokens` budget. The auto-
   * compaction listener delegates here rather than pre-checking, so this is the
   * only place the decision lives. The prefix counts because every request
   * carries it in front of the history (`EpochHeader.messagePrefix`) even
   * though it is not derived history — omitting it would under-estimate by
   * exactly the prefix and let a deployment at the window edge skip
   * compaction, then ship an over-window request. The loop composes the
   * prefix BEFORE the pre-step seam and hands it through, so the gate sees
   * this instance's actual prefix (never a previous instance's logged one —
   * a resumed/forked instance whose contributor grew is gated on the grown
   * value from its very first step). Compaction itself can only
   * shrink HISTORY: a prefix that alone approaches the window is a
   * configuration error no compactor fixes.
   *
   * Retention is a UNIFORM tail→head walk over the whole surface — turn
   * boundaries play NO role. Walking node-by-node from the tail and summing
   * token estimates, once the retained total reaches `retainTokens` the cutoff
   * is rounded to a balanced tool-pairing boundary: if the cut before the
   * retained node is unbalanced (an unanswered tool-call sits before it — i.e.
   * it is mid-step), the walk continues head-ward until the cut is balanced so
   * the whole step is retained (never splitting a step's tool-calls from their
   * results); if it stopped on a free node (a node belonging to no step), that
   * cut is already balanced. This always rounds toward retaining MORE (retained
   * ≥ `retainTokens`) and is boundary-safe by construction — no separate snap
   * pass.
   *
   * The compacted range is always anchored at the surface HEAD (`nodes[0]`):
   * auto-compaction re-consolidates any prior head checkpoint into one fresh
   * checkpoint. Declines (`null`) when nothing is over threshold, when the whole
   * surface fits the retain budget, or when no balanced cutoff exists in the
   * compactable range (its only content is an open tail step — retry once it
   * closes).
   */
  override async compactIfNeeded(
    agent: Agent,
    fullSystemPrompt: string,
    sessionPrefix: readonly Message[],
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    const threshold = Math.floor(this.config.contextWindow * this.config.thresholdRatio)
    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= this.config.compactionRetries; attempt++) {
      const totalTokens = this.estimatePressure(session, fullSystemPrompt, sessionPrefix)
      if (totalTokens < threshold) return result

      const range = this._compactableRange(session)
      if (range === null) {
        /* v8 ignore else -- defensive for non-standard subclass mutations; the concrete replace keeps a compactable head checkpoint. */
        if (result === null) return null
        /* v8 ignore next -- paired with the ignored defensive branch above. */
        break
      }

      result = await this.compactRegion(session, range.start, range.end, agent, signal)
    }

    const totalTokens = this.estimatePressure(session, fullSystemPrompt, sessionPrefix)
    if (totalTokens < threshold) return result

    throw new Error(
      `compaction still above threshold after ${this.config.compactionRetries + 1} compaction attempts `
      + `(${totalTokens} estimated tokens >= threshold ${threshold})`,
    )
  }

  /**
   * Estimated token pressure of the NEXT request: the session prefix
   * (`EpochHeader.messagePrefix` — request-only messages the loop sends in
   * front of the derived history, composed before the pre-step seam and
   * handed to the gate), the derived history, and the system prompt.
   * @param session - the session whose next request is being estimated.
   * @param fullSystemPrompt - the assembled system prompt (counts toward pressure).
   * @param sessionPrefix - the instance's composed session prefix (counts toward pressure).
   * @returns the estimated token total the next request will carry.
   */
  estimatePressure(session: Session, fullSystemPrompt: string, sessionPrefix: readonly Message[]): number {
    return this.estimateTokens([...sessionPrefix, ...session.deriveMessages()], fullSystemPrompt)
  }

  override async compactRegion(
    session: Session,
    start: number,
    end: number,
    agent: Agent,
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

    // The region must never split a step's assistant-message tool-calls from
    // their tool/results (which would orphan one side and produce a transcript
    // every provider rejects). A region is safe iff BOTH its edges are balanced
    // cuts: the cut before `start`, and the cut after `end`. A node that belongs
    // to no step (pre-step user message, inter-step steering, injection context)
    // is a balanced (free) boundary; an `end` inside an open (unclosed) tail step
    // leaves the cut after it unbalanced (the open tool-call has no result yet),
    // so it is rejected. See dsh-session's tool-pairing balance check.
    const events = session.events
    if (!isToolPairingBalanced(nodes, events, start)) {
      throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
    }
    // The cut after `end` is named by `end`'s surface successor, or `null` when
    // `end` is the tail.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const afterEnd: number | null = nodes[endIdx]!.next
    if (!isToolPairingBalanced(nodes, events, afterEnd)) {
      throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
    }

    if (this._isCompactionInProgress(session)) {
      throw new Error('compaction already in progress')
    }

    // Compaction's events (compact/* and the replacement user/message) must be
    // turn-enclosed: the session-log contract rejects any plugin event appended
    // outside an open turn. Auto-compaction satisfies this — it runs on the
    // `agent/pre-step` seam, after `turn/start` and before `step/start`, so
    // strictly inside the open turn (but outside any step). A manual call on a
    // fully-closed session has no turn to enclose the events, so reject rather
    // than emit an un-enclosed run.
    const openTurn = this._openTurn(session)
    if (openTurn === null) {
      throw new Error('compactRegion: no open turn — compaction events must be enclosed in a turn')
    }
    // Slice the ordered surface nodes [startIdx, endIdx] inclusive — the
    // shadowed range is positional, so this is the set the replace op covers.
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1).map(n => n.seq)

    // --- Acquire lock ---
    const startEvent = session.append('compact/start', { turn: openTurn })

    try {
      // --- Extract text and summarize ---
      const text = renderTranscript(session.events, shadowedSeqs)
      const { summary, model, maxTokens } = await this.summarize(text, agent, signal)

      // Estimate token count of the shadowed content for provenance.
      let shadowedTokenCount = 0
      for (const seq of shadowedSeqs) {
        // seq comes from a surface node — always a valid log index by construction.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        shadowedTokenCount += this.estimateEventTokens(session.events[seq]!)
      }
      const framedSummary = this._frameSummary(summary)
      const framedSummaryTokenCount = this.estimateContentTokens(framedSummary)
      if (framedSummaryTokenCount >= shadowedTokenCount) {
        throw new Error(
          `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${shadowedTokenCount})`,
        )
      }
      // --- Provenance record (log-only) ---
      const summaryEvent = session.append('compact/summary', {
        summary,
        shadowedRange: { start, end },
        shadowedSeqs,
        shadowedTokenCount,
        model,
        ...maxTokens !== undefined ? { maxTokens } : {},
      })

      // --- Surface replacement ---
      // The user/message directly shadows all compacted surface nodes with a
      // single replace op. It is the ONLY surface event in the compaction
      // sequence — compact/start, compact/summary, and compact/end are log-only
      // (surfaceOp is rejected by the compiler for non-SurfaceEventType).
      // The landed content is FRAMED (checkpoint preamble + tag-wrapped summary);
      // the compact/summary provenance event above holds the raw model output.
      session.append('user/message', {
        content: framedSummary,
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
      const endEvent = session.append('compact/end', { turn: openTurn })

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
      session.append('compact/end', { turn: openTurn, error: msg })
      throw error
    }
  }

  // ---- Internal helpers ----

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

  /** Resolve the next head-anchored compactable surface range, or `null`. */
  private _compactableRange(session: Session): { start: number; end: number } | null {
    const nodes = session.surface.nodes
    if (nodes.length === 0) return null

    const events = session.events
    const retainBudget = this.config.retainTokens

    // Walk tail→head summing per-node token estimates. `keepFromIdx` is the
    // index of the OLDEST node we retain verbatim; everything strictly older
    // (`[0, keepFromIdx - 1]`) is the compactable range.
    let accumulated = 0
    let keepFromIdx = nodes.length // nothing retained yet
    for (let i = nodes.length - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const node = nodes[i]!
      const event = events[node.seq]
      /* v8 ignore next -- node.seq is a surface-node seq, always a valid log index by construction */
      if (event) accumulated += this.estimateEventTokens(event)
      keepFromIdx = i
      if (accumulated >= retainBudget) break
    }

    // The whole surface fits the retain budget — nothing to compact.
    if (keepFromIdx === 0) return null

    // Round the cutoff to a tool-pairing boundary: if the cut before
    // `nodes[keepFromIdx]` is unbalanced (an unanswered tool-call sits before
    // it — i.e. it is mid-step), extend the retained side head-ward until the
    // cut is balanced, so the compacted range ends without splitting an
    // assistant↔result pair. A node that belongs to no step is already a
    // balanced (free) boundary. Decline if no balanced cut exists at or below
    // `keepFromIdx` (the compactable range is only an un-splittable open tail
    // step — retry once it closes).
    while (keepFromIdx > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (isToolPairingBalanced(nodes, events, nodes[keepFromIdx]!.seq)) break
      keepFromIdx -= 1
    }
    if (keepFromIdx === 0) return null

    // The compacted range is [head … keepFromIdx - 1], anchored at the head.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstSeq = nodes[0]!.seq
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const cutoffSeq = nodes[keepFromIdx - 1]!.seq
    return { start: firstSeq, end: cutoffSeq }
  }

  /**
   * Keep ONLY text blocks from the model-produced summary before storing it.
   *
   * The summary lands on the surface as a synthesized `user/message` (see
   * {@link _frameSummary}), so the only block type that is both useful and safe
   * there is `text`. A model assistant message can otherwise carry `reasoning`
   * (private chain-of-thought, must not leak into the durable checkpoint) and
   * `tool-call` blocks — and a surviving `tool-call` in a user message would be
   * an orphaned call with no matching `tool-result`, exactly the tool-pairing
   * breakage compaction works to avoid. Filtering to text drops both.
   */
  private _textOnly(blocks: readonly ContentBlock[]): ContentBlock[] {
    return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
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
}

export default BasicCompactService
