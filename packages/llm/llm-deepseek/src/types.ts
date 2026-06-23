/**
 * DeepSeek chat-completions wire format (OpenAI-compatible). Types only.
 *
 * Source of truth: the official API docs at
 * `~/repos/deepsuite-docs/apps/docs/docs` (api/create-chat-completion,
 * guides/thinking_mode.mdx, guides/tool_calls.md), cross-checked against
 * live streams from the internal endpoint (2026-06).
 *
 * @module dsh-llm-deepseek/types
 */

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  /** Thinking-mode toggle (top level, NOT inside extra_body on the wire). */
  thinking?: { type: 'enabled' | 'disabled' }
  /** Thinking effort (official levels; low/medium map to high server-side). */
  reasoning_effort?: 'high' | 'max'
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  /**
   * Stop sequences (OpenAI `stop`): generation halts as soon as the model
   * produces any one of these strings. Mapped from `GenerateOptions.stop`.
   */
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** User-role message: a single string of user input. */
export interface WireUserMessage {
  role: 'user'
  content: string
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

export interface WireAssistantMessage {
  role: 'assistant'
  content: string | null
  /**
   * CoT passback. REQUIRED on assistant turns that carried tool calls
   * (thinking mode); ignored on tool-call-free turns (we omit it there to
   * save tokens). See guides/thinking_mode.mdx § Tool Calls.
   */
  reasoning_content?: string
  tool_calls?: WireToolCall[]
}

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    /** Beta: strict schema adherence (official: requires the /beta base URL). */
    strict?: boolean
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
}

export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

export interface WireDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /**
   * Thinking-mode CoT. The FIRST chunk carries an empty string (must not
   * open a reasoning block); absent entirely in non-thinking mode.
   */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Present on the first delta of each call only. */
  id?: string
  type?: 'function'
  function?: {
    /** Present on the first delta of each call only. */
    name?: string
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string
  }
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}
