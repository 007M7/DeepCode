/**
 * Single replay-aware token-meter service for request and surface pressure.
 *
 * @module @deepseek-ai/dsh-token-meter
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, Session, SessionEvent, SurfaceEvent } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type {
  TokenMeasurement,
  TokenMeasurementBaseline,
  TokenMeterConfig,
  TokenSurfaceNode,
} from './types.ts'

export type * from './types.ts'

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
const ROLE_OVERHEAD = 4

interface MeasurementAnchor {
  readonly header: EpochHeader | undefined
  readonly surfaceTokens: number
  readonly baseline: Exclude<TokenMeasurementBaseline, { kind: 'none' }>
}

interface ReplayState {
  consumedEvents: number
  header: EpochHeader | undefined
  surface: TokenSurfaceNode[]
  surfaceTokens: number
  stepStart: { turn: number; step: number; surfaceTokens: number } | undefined
  anchor: MeasurementAnchor | undefined
}

interface PreparedSurfaceMutation {
  readonly tokens: number
  commit(state: ReplayState): void
}

/** Sum disjoint provider usage buckets without double-counting reasoning output. */
function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/** Compare optional envelopes so a headerless estimate can track later surface deltas. */
function optionalHeaderEquals(
  left: EpochHeader | undefined,
  right: EpochHeader | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return headerEquals(left, right)
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config: TokenMeterConfig): void {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
  }
}

declare module 'cordis' {
  interface Context {
    tokenMeter: TokenMeterService
  }
}

/** Replay owner for one service-wide estimator and isolated per-session folds. */
export class TokenMeterService extends Service {
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // the public type excludes settings while validateConfigKeys rejects them.
  static Config: z<TokenMeterConfig> = z.object({}) as unknown as z<TokenMeterConfig>

  private readonly states = new WeakMap<Session, ReplayState>()

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    validateConfigKeys(config)

    // Readers catch up independently, while eager observation bounds ordinary
    // read latency without creating state for sessions no consumer has read.
    ctx.on('session/event', (session) => {
      if (this.states.has(session)) this._sync(session)
    })
  }

  /**
   * Measure current request pressure and surface through the durable tail.
   *
   * Provider usage is reused only when the latest successful call's canonical
   * request envelope matches `requestHeader` and its total is no lower than
   * that call's full heuristic anchor; otherwise the complete envelope and
   * surface are heuristically repriced.
   *
   * `requestHeader` affects request pressure only; surface fields always
   * describe the current session surface. Every call clones those positional
   * nodes, so measurement is O(surface).
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure and surface measurement.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this._sync(session)
    const header = requestHeader === undefined
      ? state.header
      : canonicalHeader(requestHeader)
    const anchor = state.anchor

    let baseline: TokenMeasurementBaseline
    let surfaceDeltaTokens: number
    if (anchor !== undefined && optionalHeaderEquals(anchor.header, header)) {
      baseline = anchor.baseline
      surfaceDeltaTokens = state.surfaceTokens - anchor.surfaceTokens
    } else if (header === undefined && state.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: this._estimateHeader(header) + state.surfaceTokens,
      }
      surfaceDeltaTokens = 0
    }

    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: state.surfaceTokens,
      nodes: state.surface,
    }))
  }

  /**
   * Heuristically price one model-visible message.
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under the fixed service heuristic.
   */
  estimateMessage(message: Message): number {
    return this._estimateContent(message.content) + ROLE_OVERHEAD
  }

  /** Catch one session's fold up to the current durable tail. */
  private _sync(session: Session): ReplayState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: 0,
        header: undefined,
        surface: [],
        surfaceTokens: 0,
        stepStart: undefined,
        anchor: undefined,
      }
      this.states.set(session, state)
    }

    while (state.consumedEvents < session.events.length) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous session seqs index the durable log
      const event = session.events[state.consumedEvents]!
      this._foldEvent(session, state, event)
      state.consumedEvents += 1
    }
    return state
  }

  /**
   * Validate and prepare every fallible part before mutating replay state.
   * A malformed event remains unread on every retry instead of partially
   * applying the same mutation more than once.
   */
  private _foldEvent(session: Session, state: ReplayState, event: SessionEvent): void {
    let nextHeader = state.header
    let nextStepStart = state.stepStart
    let nextAnchor = state.anchor

    switch (event.type) {
      case 'request/header':
        nextHeader = canonicalHeader(event.data.header)
        break
      case 'step/start':
        if (state.stepStart !== undefined) {
          throw new Error(
            `token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`,
          )
        }
        nextStepStart = { ...event.data, surfaceTokens: state.surfaceTokens }
        break
      case 'step/end':
        if (state.stepStart === undefined
          || state.stepStart.turn !== event.data.turn
          || state.stepStart.step !== event.data.step) {
          throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start boundary`)
        }
        nextStepStart = undefined
        break
      default:
        break
    }

    const surface = isSurfaceEvent(event)
      ? this._prepareSurfaceMutation(session, state, event)
      : undefined

    if (event.type === 'assistant/message') {
      const stepStart = state.stepStart
      if (stepStart === undefined
        || stepStart.turn !== event.data.turn
        || stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start boundary`)
      }

      // assistant/message is surface-mandatory at every append/seed boundary.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const eventTokens = surface!.tokens
      if (event.data.usage !== undefined && nextHeader !== undefined) {
        const providerAssistantTokens = this._estimateProviderAssistant(
          session,
          event,
          eventTokens,
        )
        const anchorSurfaceTokens = stepStart.surfaceTokens + providerAssistantTokens
        const providerTokens = usageTokens(event.data.usage)
        const estimatedAnchorTokens = this._estimateHeader(nextHeader) + anchorSurfaceTokens
        nextAnchor = {
          header: nextHeader,
          surfaceTokens: anchorSurfaceTokens,
          // Signed heuristic deltas remain conservative only from an anchor
          // that is at least as large as the matching full heuristic price.
          baseline: providerTokens >= estimatedAnchorTokens
            ? { kind: 'usage', tokens: providerTokens, usage: event.data.usage }
            : { kind: 'estimated', tokens: estimatedAnchorTokens },
        }
      } else {
        const anchorSurfaceTokens = stepStart.surfaceTokens + eventTokens
        nextAnchor = {
          header: nextHeader,
          surfaceTokens: anchorSurfaceTokens,
          baseline: {
            kind: 'estimated',
            tokens: this._estimateHeader(nextHeader) + anchorSurfaceTokens,
          },
        }
      }
    }

    state.header = nextHeader
    state.stepStart = nextStepStart
    if (surface !== undefined) surface.commit(state)
    state.anchor = nextAnchor
  }

  /** Validate one surface operation and return its allocation-light commit. */
  private _prepareSurfaceMutation(
    session: Session,
    state: ReplayState,
    event: SurfaceEvent,
  ): PreparedSurfaceMutation {
    const tokens = this._estimateSurfaceEvent(session, event)
    const op = event.surfaceOp
    if (op === 'append') {
      return {
        tokens,
        commit(target) {
          target.surface.push({ seq: event.seq, tokens })
          target.surfaceTokens += tokens
        },
      }
    }

    const startIdx = state.surface.findIndex(node => node.seq === op.start)
    const endIdx = state.surface.findIndex(node => node.seq === op.end)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      throw new Error(
        `token meter: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`,
      )
    }
    const removedTokens = state.surface
      .slice(startIdx, endIdx + 1)
      .reduce((total, node) => total + node.tokens, 0)
    return {
      tokens,
      commit(target) {
        target.surface.splice(startIdx, endIdx - startIdx + 1, { seq: event.seq, tokens })
        target.surfaceTokens += tokens - removedTokens
      },
    }
  }

  /** Price one current surface event exactly as it projects to a request. */
  private _estimateSurfaceEvent(session: Session, event: SurfaceEvent): number {
    const message = session.deriveEventMessage(event)
    return message === null ? 0 : this.estimateMessage(message)
  }

  /**
   * Reassemble provider output from exact chunk provenance for a usage anchor.
   * Missing legacy provenance conservatively treats the durable output as the
   * provider output; explicit empty provenance prices a known empty stream.
   */
  private _estimateProviderAssistant(
    session: Session,
    event: SessionEvent<'assistant/message'>,
    durableEventTokens: number,
  ): number {
    const sourceSeqs = event.sourceEventSeqs
    if (sourceSeqs === undefined) return durableEventTokens

    const assembler = new BlockAssembler()
    const seen = new Set<number>()
    for (const seq of sourceSeqs) {
      if (seq >= event.seq) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not earlier`)
      }
      if (seen.has(seq)) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} repeats source seq ${seq}`)
      }
      seen.add(seq)
      // Session construction validates contiguous seqs, and the explicit
      // earlier-than-assistant check above therefore guarantees existence.
      const source = session.events[seq]
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const sourceEvent = source!
      if (sourceEvent.type !== 'assistant/chunk') {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not assistant/chunk`)
      }
      if (sourceEvent.data.turn !== event.data.turn || sourceEvent.data.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} belongs to another step`)
      }
      assembler.push(sourceEvent.data.chunk)
    }
    const providerContent = assembler.blocks()
    return providerContent.length === 0 ? 0 : this._estimateContent(providerContent) + ROLE_OVERHEAD
  }

  /** Price content blocks recursively under the fixed density heuristic. */
  private _estimateContent(blocks: readonly ContentBlock[]): number {
    let tokens = 0
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
          break
        case 'tool-call':
          tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
            + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
            + BLOCK_OVERHEAD
          break
        case 'tool-result':
          tokens += this._estimateContent(block.content) + BLOCK_OVERHEAD
          break
        default:
          // ContentBlockMap is merge-extensible; unknown blocks retain a
          // conservative structural JSON price under the fixed heuristic.
          tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
      }
    }
    return tokens
  }

  /** Price the canonical non-surface request envelope. */
  private _estimateHeader(header: EpochHeader | undefined): number {
    if (header === undefined) return 0
    let tokens = 0
    if (header.system !== undefined) {
      tokens += Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
    }
    if (header.tools !== undefined && header.tools.length > 0) {
      tokens += Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    }
    return tokens
  }
}

export default TokenMeterService
