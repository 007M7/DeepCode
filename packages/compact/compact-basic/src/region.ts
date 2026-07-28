/**
 * Surface retention selection and the log-recorded compaction transaction.
 *
 * @module @deepseek-ai/dsh-compact-basic/region
 */

import { isDeepStrictEqual } from 'node:util'
import {
  COMPACT_CHECKPOINT_SOURCE,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compact'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement, TokenMeterService } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { frameSummary } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'

interface RegionDependencies {
  readonly meter: TokenMeterService
  summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>
}

/**
 * Resolve the next head-anchored range while retaining a priced recent tail
 * and never splitting an assistant tool-call/result pair.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): { start: number; end: number } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null

  while (keepFromIdx > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const first = surfaceNodes[0]!
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const cutoff = surfaceNodes[keepFromIdx - 1]!
  return { start: first, end: cutoff }
}

/**
 * Validate and compact one positional surface span.
 * @param dependencies - conversation meter and dynamically dispatched summarizer hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(
  dependencies: RegionDependencies,
  session: Session,
  start: number,
  end: number,
  agent: Agent,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }

  const tail = inspectTurnTail(session.events)
  if (tail.compactionInProgress) throw new Error('compaction already in progress')
  if (tail.turn === null) {
    throw new Error('compactRegion: no open turn — compaction events must be enclosed in a turn')
  }

  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
  const startEvent = session.append('compact/start', { turn: tail.turn })
  try {
    // Capture after the lock event so a later surface mutation invalidates the
    // async selection before replacement. Unrelated log-only facts may append.
    const lockedMeasurement = dependencies.meter.measure(session)
    const selected = lockedMeasurement.nodes.slice(startIdx, endIdx + 1)
    if (selected.length !== shadowedSeqs.length
      || selected.some((node, index) => node.seq !== shadowedSeqs[index])) {
      throw new Error('compaction: selected surface changed before summarization began')
    }
    const shadowedTokenCount = selected.reduce((total, node) => total + node.tokens, 0)
    const summarizationInput = buildSummarizationInput(session, shadowedSeqs)
    const { summary, provider, model, maxTokens } = await dependencies.summarize(summarizationInput, agent, signal)

    const currentMeasurement = dependencies.meter.measure(session)
    if (!isDeepStrictEqual(currentMeasurement.nodes, lockedMeasurement.nodes)) {
      throw new Error('compaction: session surface changed during summarization')
    }
    const framedSummary = frameSummary(summary)
    const checkpointMessage = createUserMessage({
      content: framedSummary,
      source: COMPACT_CHECKPOINT_SOURCE,
    })
    const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage)
    if (framedSummaryTokenCount >= shadowedTokenCount) {
      throw new Error(
        `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${shadowedTokenCount})`,
      )
    }

    const summaryEvent = session.append('compact/summary', {
      summary,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount,
      provider,
      model,
      ...maxTokens === undefined ? {} : { maxTokens },
    })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    const endEvent = session.append('compact/end', { turn: tail.turn })
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
    const message = error instanceof Error ? error.message : String(error)
    session.append('compact/end', { turn: tail.turn, error: message })
    throw error
  }
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: its system prompt and tool schemas, then the region's own derived
 * messages in surface order. The summarizer appends only the compaction
 * instruction after this, so the call is a genuine prefix of the conversation
 * and reuses the provider's KV cache.
 * @param session - session supplying the request header and per-node projection.
 * @param shadowedSeqs - the surface-node seqs, in order, being compacted.
 * @returns the replayed conversation prefix to condense.
 */
function buildSummarizationInput(
  session: Session,
  shadowedSeqs: readonly number[],
): SummarizationInput {
  const header = session.requestHeader()
  const events = session.events
  const regionMessages = shadowedSeqs
    // shadowedSeqs are current surface seqs, so each is a valid log index.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    .map(seq => session.deriveEventMessage(events[seq]!))
    .filter((message): message is Message => message !== null)
  return {
    ...header?.system === undefined ? {} : { system: header.system },
    ...header?.tools === undefined ? {} : { tools: header.tools },
    messages: regionMessages,
  }
}

/** Inspect the current turn boundary and latest compaction bracket once. */
function inspectTurnTail(
  events: readonly SessionEvent[],
): { turn: number | null; compactionInProgress: boolean } {
  let compactionInProgress = false
  let compactionStateKnown = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const event = events[index]!
    if (!compactionStateKnown) {
      if (event.type === 'compact/start') {
        compactionInProgress = true
        compactionStateKnown = true
      } else if (event.type === 'compact/end') {
        compactionStateKnown = true
      }
    }
    if (event.type === 'turn/start') return { turn: event.data.turn, compactionInProgress }
    if (event.type === 'turn/end') return { turn: null, compactionInProgress }
  }
  return { turn: null, compactionInProgress }
}
