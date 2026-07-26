import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'

/** Durable payload recorded before one transient model-request retry wait. */
export interface LlmRetryEventData {
  turn: number
  step: number
  retry: number
  maxRetries: number
  delayMs: number
  failure: LlmFailure
}
