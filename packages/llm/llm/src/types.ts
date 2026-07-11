/**
 * Provider-neutral message and streaming vocabulary.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from './brand.ts'

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: CallId
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: CallId
  content: ContentBlock[]
  isError?: boolean
}

/**
 * All known content block shapes, keyed by their `type` tag.
 * Merge-extensible: plugins add new block types via declaration merging.
 *
 * The core set is deliberately limited to blocks every shipping path honors.
 * Multimodal content (images, audio, …) has no core block type: a feature
 * that needs one adds it via declaration merging in the same coordinated
 * change that maps it in the adapters, surfaces it in the UI bridges, and
 * prices it in compaction — a producer never lands without its consumers
 * (see docs/rfc/implemented/simplification/2026-07-04-drop-image-content-block.md).
 */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

/** The block `type` tag vocabulary; widens as plugins merge new shapes into {@link ContentBlockMap}. */
export type ContentBlockType = keyof ContentBlockMap
/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns (merge-extensible). */
export type ContentBlock = ContentBlockMap[ContentBlockType]

/** A single message in a conversation history. */
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
}

/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string }
}

/** Any known message source, derived from {@link MessageSourceMap}; switch on `kind` and fall through unknowns (merge-extensible). */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted' }
  'error': { kind: 'error'; message: string; code?: string }
}

/** Any known finish reason, derived from {@link FinishReasonMap}; switch on `kind` and fall through unknowns (merge-extensible). */
export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Raw streaming protocol emitted by adapters.
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}

/** A single model request, fully assembled. */
export interface GenerateOptions {
  model: string
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * `EpochHeader.messagePrefix` + the derived history (dsh-agent-loop); a
   * hand-built one-shot passes any list.
   */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[]
  signal?: AbortSignal
  /**
   * The id of the session this request belongs to — stamped by the agent loop from
   * `agent.session.id`.
   */
  sessionId?: Branded<'SessionId'>
}
