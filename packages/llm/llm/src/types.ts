/**
 * Provider-neutral message and streaming vocabulary.
 *
 * This is the canonical language spoken by the agent loop, session logs, and
 * every plugin. Adapters translate it to provider wire formats (DeepSeek V4
 * first); nothing outside an adapter should ever see a provider-specific
 * shape.
 *
 * Extensibility: the unions in this file are derived from interfaces
 * (`ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap`) so that plugins
 * can extend them via declaration merging:
 *
 * ```ts
 * declare module '@deepseek-ai/dsh-llm' {
 *   interface ContentBlockMap {
 *     video: { type: 'video'; url: string }
 *   }
 * }
 * ```
 */

import type { CallId } from './brand.ts'

/** Cache hint attached to a content block (provider-interpreted). */
export type CacheHint = 'ephemeral'

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
  cache?: CacheHint
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
  cache?: CacheHint
}

/** An image, by URL or data URL. */
export interface ImageBlock {
  type: 'image'
  url: string
  mimeType?: string
  cache?: CacheHint
}

/**
 * All known content block shapes, keyed by their `type` tag.
 * Merge-extensible: plugins add new block types via declaration merging.
 */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
  'image': ImageBlock
}

export type ContentBlockType = keyof ContentBlockMap
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
  agent: { kind: 'agent'; agentId: string }
}

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
 *
 * A streaming response interleaves several typed blocks (text, reasoning,
 * multiple tool calls); `index` ties each delta to its block, and `block-end`
 * carries the fully-assembled ContentBlock so consumers don't have to
 * re-assemble deltas themselves (use {@link BlockAssembler} when they do).
 *
 * Adapter contract — every adapter MUST obey these, and every consumer may
 * rely on them:
 * - Emit `usage` BEFORE `finish`, and nothing after `finish` (defer both to
 *   the provider's end-of-stream marker so trailing usage-only chunks can't
 *   violate this).
 * - Tool-call `arguments` stay RAW JSON strings end-to-end; partial fragments
 *   stream via `argumentsDelta` (providers that hand back parsed objects
 *   re-stringify at `block-end`).
 * - Failures may either THROW from `stream()` (transport/protocol errors) or
 *   end the stream with `finish {kind:'error'|'aborted'}` (provider in-band
 *   errors, for adapters that can't throw mid-stream); consumers must handle
 *   both. The agent loop translates a finish-error/aborted into a turn error —
 *   it never logs a normal completed assistant message for a failed step.
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
  strict?: boolean
}

/** A single model request, fully assembled. */
export interface GenerateOptions {
  model: string
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  /** Assistant prefix continuation (prefill). */
  prefill?: ContentBlock[]
  temperature?: number
  maxTokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[]
  signal?: AbortSignal
}

/** Non-streaming result, assembled from the chunk stream. */
export interface GenerateResult {
  message: Message
  usage?: TokenUsage
  finish: FinishReason
}
