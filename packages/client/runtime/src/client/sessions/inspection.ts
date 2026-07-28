// Session inspection read models. These projections preserve durable request
// and prompt semantics for diagnostic UIs without making the conversation fold
// or the core SessionSurface own inspection-only history.

import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ConversationNode } from './conversation.ts'

/** Request configuration recorded in the effective header for one assistant response. */
export interface AssistantRequestConfig {
  provider: string
  model: string
  purpose?: string
  thinking?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

/** Stable provider/model identity attached to one assistant response. */
export interface AssistantProvenanceView {
  provider: string
  model: string
}

/** Operation that started a new append-only model context. */
export type ConversationContextOriginKind = 'compaction' | 'rewind' | 'rewrite'

/** Latest complete model request header in force within one context generation. */
export interface ConversationPromptSnapshot {
  /** Provider/model and sampling configuration from the latest effective request header. */
  config?: AssistantRequestConfig
  /** Rendered system prompt text; empty when the request had no system prompt. */
  system: string
  /** Complete tool catalog sent with the request, including tools that were never called. */
  tools: readonly ToolSchema[]
}

/** One system-prompt/tool-catalog state that became effective in the request timeline. */
export interface ConversationPromptChange {
  /** Sequence of the request/header event that introduced this state. */
  seq: number
  /** Unix epoch ms from the request/header event. */
  time: number
  /** How the model-visible system configuration differs from the prior recorded state. */
  kind: 'initial' | 'system' | 'tools' | 'system-and-tools'
  /** Complete state effective from this event onward. */
  prompt: ConversationPromptSnapshot
  /** State immediately before this change; absent for the initial header. */
  previous?: ConversationPromptSnapshot
}

/** One immutable model-context generation reconstructed from surface replacements. */
export interface ConversationContext {
  /** Zero-based generation within the session; stable across later appends. */
  id: number
  /** Previous generation in this session; absent for the initial context. */
  parentId?: number
  /** Why this generation exists; absent for the initial context. */
  origin?: ConversationContextOriginKind
  /** Event seq of the replacement that created this generation. */
  originSeq?: number
  /** Unix epoch ms of the replacement that created this generation. */
  createdAt?: number
  /** Latest request header observed in this generation, inherited until a later header replaces it. */
  prompt?: ConversationPromptSnapshot
  /** Final frozen nodes for historical generations, or current folded nodes for the tail. */
  nodes: readonly ConversationNode[]
}

/** One auxiliary compaction model request reconstructed from its durable lifecycle events. */
export interface CompactionRequestView {
  startSeq: number
  turn: number
  startedAt: number
  completedAt: number | null
  status: 'running' | 'complete' | 'error'
  error?: string
  summarySeq?: number
  replacementSeq?: number
  summary?: readonly ContentBlock[]
  rawOutput?: readonly ContentBlock[]
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  usage?: unknown
}

/** One ordinary provider-request attempt reconstructed from a durable step boundary. */
export interface ModelRequestView {
  /** Sequence of the step/start event that opened this attempt. */
  startSeq: number
  turn: number
  step: number
  /** Unix epoch ms from step/start. */
  startedAt: number
  /** Assistant completion time, or the failed step/end time when no response completed. */
  completedAt: number | null
  status: 'running' | 'complete' | 'error'
  error?: string
  /** Assistant/message sequence when this attempt completed successfully. */
  resultSeq?: number
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  usage?: unknown
  /** Retry ordinal scheduled after this failed attempt. */
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
}

/** Stable inspection substructures attached to a conversation snapshot. */
export interface SessionInspectionSnapshot {
  compactionRequests: readonly CompactionRequestView[]
  requestAttempts: readonly ModelRequestView[]
  promptChanges: readonly ConversationPromptChange[]
  callSchemas: ReadonlyMap<string, ToolSchema>
}

interface RetryEvent {
  type: 'llm/retry'
  seq: number
  time: number
  data: {
    turn: number
    step: number
    retry: number
    maxRetries: number
    delayMs: number
    failure: { message: string }
  }
}

interface CompactionStartEvent {
  type: 'compact/start'
  seq: number
  time: number
  data: { turn: number }
}

interface CompactionSummaryEvent {
  type: 'compact/summary'
  seq: number
  time: number
  data: {
    summary: readonly ContentBlock[]
    rawOutput?: readonly ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
    usage?: unknown
  }
}

interface CompactionEndEvent {
  type: 'compact/end'
  seq: number
  time: number
  data: { turn: number; error?: string }
}

/**
 * Own incremental invalidation and call-time schema capture for inspection
 * read models. Conversation state delegates events here but owns no request
 * reconstruction details.
 */
export class SessionInspection {
  private activeToolSchemas = new Map<string, ToolSchema>()
  private callSchemas = new Map<string, ToolSchema>()
  private callSchemasRev = 0
  private callSchemasCache: { rev: number; value: ReadonlyMap<string, ToolSchema> } | null = null
  private modelRequestsRev = 0
  private modelRequestsCache: {
    rev: number
    value: readonly ModelRequestView[]
  } | null = null
  private compactionRequestsRev = 0
  private compactionRequestsCache: {
    rev: number
    value: readonly CompactionRequestView[]
  } | null = null
  private promptChangesRev = 0
  private promptChangesCache: {
    rev: number
    value: readonly ConversationPromptChange[]
  } | null = null

  /**
   * Invalidate projections before replaying a rebuilt history window.
   * @returns Nothing.
   */
  reset(): void {
    this.activeToolSchemas = new Map()
    this.callSchemas = new Map()
    this.callSchemasRev++
    this.modelRequestsRev++
    this.compactionRequestsRev++
    this.promptChangesRev++
  }

  /**
   * Apply inspection-specific incremental state for one durable event.
   * @param event - Event entering the current history window.
   * @returns Nothing.
   */
  applyEvent(event: SessionEvent): void {
    if (affectsModelRequests(event)) this.modelRequestsRev++
    if (affectsCompactionRequests(event)) this.compactionRequestsRev++
    if (event.type === 'request/header') {
      this.promptChangesRev++
      this.activeToolSchemas = new Map(
        (event.data.header.tools ?? []).map(schema => [schema.name, schema]),
      )
      return
    }
    if (event.type === 'tool/call') {
      this.captureCallSchema(String(event.data.callId), event.data.name)
    }
  }

  /**
   * Preserve the schema active when one native or nested call starts.
   * @param callId - Durable or synthetic call identifier.
   * @param name - Tool name used to resolve the active catalog entry.
   * @returns Nothing.
   */
  captureCallSchema(callId: string, name: string): void {
    if (this.callSchemas.has(callId)) return
    const schema = this.activeToolSchemas.get(name)
    if (schema === undefined) return
    this.callSchemas.set(callId, schema)
    this.callSchemasRev++
  }

  /**
   * Materialize reference-stable inspection projections for the current log.
   * @param events - Current contiguous client history window.
   * @returns Inspection projections with stable unchanged substructure references.
   */
  snapshot(events: readonly SessionEvent[]): SessionInspectionSnapshot {
    if (this.callSchemasCache === null || this.callSchemasCache.rev !== this.callSchemasRev) {
      this.callSchemasCache = { rev: this.callSchemasRev, value: new Map(this.callSchemas) }
    }
    if (
      this.modelRequestsCache === null
      || this.modelRequestsCache.rev !== this.modelRequestsRev
    ) {
      this.modelRequestsCache = {
        rev: this.modelRequestsRev,
        value: deriveModelRequests(events),
      }
    }
    if (
      this.compactionRequestsCache === null
      || this.compactionRequestsCache.rev !== this.compactionRequestsRev
    ) {
      this.compactionRequestsCache = {
        rev: this.compactionRequestsRev,
        value: deriveCompactionRequests(events),
      }
    }
    if (
      this.promptChangesCache === null
      || this.promptChangesCache.rev !== this.promptChangesRev
    ) {
      this.promptChangesCache = {
        rev: this.promptChangesRev,
        value: derivePromptChanges(events),
      }
    }
    return {
      callSchemas: this.callSchemasCache.value,
      requestAttempts: this.modelRequestsCache.value,
      compactionRequests: this.compactionRequestsCache.value,
      promptChanges: this.promptChangesCache.value,
    }
  }
}

function modelRequestKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

function affectsModelRequests(event: SessionEvent): boolean {
  switch (event.type) {
    case 'request/header':
    case 'step/start':
    case 'assistant/message':
    case 'step/end':
      return true
    case 'turn/end':
      return event.data.reason.kind === 'error'
    default:
      return (event.type as string) === 'llm/retry'
  }
}

function affectsCompactionRequests(event: SessionEvent): boolean {
  const type = event.type as string
  return type === 'compact/start'
    || type === 'compact/summary'
    || type === 'compact/end'
    || (event.type === 'user/message' && isCompactionSource(event.data.source))
}

/** Project every durable step into one provider request, retaining failed retry attempts. */
function deriveModelRequests(events: readonly SessionEvent[]): readonly ModelRequestView[] {
  const requests: ModelRequestView[] = []
  const byStep = new Map<string, number>()
  let activeStep: string | undefined
  let activeConfig: ConversationPromptSnapshot['config']

  const update = (key: string, change: Partial<ModelRequestView>): void => {
    const index = byStep.get(key)
    if (index === undefined) return
    const request = requests[index]
    if (request !== undefined) requests[index] = { ...request, ...change }
  }

  for (const sourceEvent of events) {
    if (sourceEvent.type === 'request/header') {
      activeConfig = sourceEvent.data.header.config
      if (activeStep !== undefined) update(activeStep, { requestConfig: activeConfig })
      continue
    }
    if (sourceEvent.type === 'step/start') {
      const { turn, step } = sourceEvent.data
      const key = modelRequestKey(turn, step)
      byStep.set(key, requests.length)
      requests.push({
        startSeq: sourceEvent.seq,
        turn,
        step,
        startedAt: sourceEvent.time,
        completedAt: null,
        status: 'running',
        ...(activeConfig === undefined ? {} : { requestConfig: activeConfig }),
      })
      activeStep = key
      continue
    }
    if (sourceEvent.type === 'assistant/message') {
      const key = modelRequestKey(sourceEvent.data.turn, sourceEvent.data.step)
      update(key, {
        completedAt: sourceEvent.time,
        status: 'complete',
        resultSeq: sourceEvent.seq,
        provenance: {
          provider: sourceEvent.data.provenance.provider,
          model: sourceEvent.data.provenance.model,
        },
        ...(sourceEvent.data.usage === undefined ? {} : { usage: sourceEvent.data.usage }),
      })
      continue
    }
    if (sourceEvent.type === 'step/end') {
      const key = modelRequestKey(sourceEvent.data.turn, sourceEvent.data.step)
      const index = byStep.get(key)
      const request = index === undefined ? undefined : requests[index]
      if (index !== undefined && request !== undefined && request.status === 'running') {
        requests[index] = {
          ...request,
          completedAt: sourceEvent.time,
          status: 'error',
        }
      }
      if (activeStep === key) activeStep = undefined
      continue
    }
    if ((sourceEvent.type as string) === 'llm/retry') {
      const event = sourceEvent as unknown as RetryEvent
      update(modelRequestKey(event.data.turn, event.data.step), {
        status: 'error',
        error: event.data.failure.message,
        retry: event.data.retry,
        maxRetries: event.data.maxRetries,
        retryDelayMs: event.data.delayMs,
      })
      continue
    }
    if (sourceEvent.type !== 'turn/end' || sourceEvent.data.reason.kind !== 'error') continue
    const reason = sourceEvent.data.reason
    update(modelRequestKey(sourceEvent.data.turn, reason.step), {
      status: 'error',
      error: 'failure' in reason ? reason.failure.message : reason.message,
    })
  }
  return requests
}

/** Project log-only compaction request brackets without coupling the client runtime to one backend package. */
function deriveCompactionRequests(events: readonly SessionEvent[]): readonly CompactionRequestView[] {
  const requests: CompactionRequestView[] = []
  let active: CompactionRequestView | undefined
  for (const sourceEvent of events) {
    const type = sourceEvent.type as string
    if (type === 'compact/start') {
      const event = sourceEvent as unknown as CompactionStartEvent
      active = {
        startSeq: event.seq,
        turn: event.data.turn,
        startedAt: event.time,
        completedAt: null,
        status: 'running',
      }
      continue
    }
    if (type === 'compact/summary' && active !== undefined) {
      const event = sourceEvent as unknown as CompactionSummaryEvent
      active = {
        ...active,
        summarySeq: event.seq,
        summary: event.data.summary,
        ...(event.data.rawOutput === undefined ? {} : { rawOutput: event.data.rawOutput }),
        provenance: {
          provider: event.data.provider,
          model: event.data.model,
        },
        requestConfig: {
          provider: event.data.provider,
          model: event.data.model,
          purpose: 'compaction',
          ...(event.data.maxTokens === undefined ? {} : { maxTokens: event.data.maxTokens }),
        },
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      }
      continue
    }
    if (
      sourceEvent.type === 'user/message'
      && active?.summarySeq !== undefined
      && isCompactionSource(sourceEvent.data.source)
    ) {
      active = { ...active, replacementSeq: sourceEvent.seq }
      continue
    }
    if (type !== 'compact/end' || active === undefined) continue
    const event = sourceEvent as unknown as CompactionEndEvent
    active = {
      ...active,
      completedAt: event.time,
      status: event.data.error === undefined ? 'complete' : 'error',
      ...(event.data.error === undefined ? {} : { error: event.data.error }),
    }
    requests.push(active)
    active = undefined
  }
  if (active !== undefined) requests.push(active)
  return requests
}

/** Project request headers into model-visible system/tool changes only. */
function derivePromptChanges(events: readonly SessionEvent[]): readonly ConversationPromptChange[] {
  const changes: ConversationPromptChange[] = []
  let previous: ConversationPromptSnapshot | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const prompt: ConversationPromptSnapshot = {
      config: event.data.header.config,
      system: event.data.header.system ?? '',
      tools: event.data.header.tools ?? [],
    }
    const systemChanged = previous !== undefined && previous.system !== prompt.system
    const toolsChanged = previous !== undefined
      && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
    if (previous === undefined || systemChanged || toolsChanged) {
      changes.push({
        seq: event.seq,
        time: event.time,
        kind: previous === undefined
          ? 'initial'
          : systemChanged && toolsChanged
            ? 'system-and-tools'
            : systemChanged
              ? 'system'
              : 'tools',
        prompt,
        ...(previous === undefined ? {} : { previous }),
      })
    }
    previous = prompt
  }
  return changes
}

function isCompactionSource(source: unknown): boolean {
  return typeof source === 'object'
    && source !== null
    && 'kind' in source
    && source.kind === 'plugin'
    && 'plugin' in source
    && source.plugin === 'compact'
}
