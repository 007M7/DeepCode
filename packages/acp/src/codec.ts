/**
 * Pure translation between harness vocabulary and ACP wire types. No I/O, no
 * Cordis context — every function here is total and unit-testable in isolation.
 * Keeping the mapping pure is deliberate: the SDK rejects an unknown
 * `stopReason`, so the {@link turnEndToStopReason} total function (with its
 * exhaustive test over every `TurnEndReason` kind) is the guard that a turn
 * always settles to a legal wire value.
 *
 * @module @deepseek-ai/dsh-acp/codec
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock as AcpContentBlock, StopReason } from '@agentclientprotocol/sdk'

/**
 * Map a harness {@link TurnEndReason} to the ACP `StopReason` wire enum.
 *
 * The mapping is total over the kinds the loop actually produces today
 * (`completed`/`aborted`/`error`/`disposed`/`max-tokens`). `TurnEndReason` is
 * merge-extensible, so an unknown future kind falls through to `end_turn` —
 * the safest default (the turn DID end; we just lack a more specific wire
 * reason) — rather than throwing into the SDK, which would reject an unknown
 * `stopReason` and break the prompt RPC. When a new kind gains a dedicated ACP
 * reason (e.g. a future `refusal` → `refusal`), add an explicit case here.
 *
 * - `completed` → `end_turn` (the model chose to stop)
 * - `max-tokens` → `max_tokens` (cut off at the output-token ceiling)
 * - `aborted`   → `cancelled` (an `agent.abort()`, e.g. from `session/cancel`)
 * - `error`     → `end_turn` (defensive fallback only: the bridge REJECTS the
 *                 `session/prompt` RPC on an error turn BEFORE calling this, so
 *                 a client sees a JSON-RPC error, not a stop reason — see
 *                 `rejectPrompt` in index.ts. This case keeps the function total
 *                 for any non-bridge caller / property test.)
 * - `disposed`  → `cancelled` (the agent was torn down mid-turn — closest to a
 *                 cancellation from the client's perspective)
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'aborted':
      return 'cancelled'
    case 'disposed':
      return 'cancelled'
    case 'error':
      return 'end_turn'
    // Merge-extensible: an unknown future TurnEndReason kind still has to
    // produce a legal wire value (the SDK rejects unknown stopReason), so
    // default to end_turn rather than assertNever. Add an explicit case when a
    // new kind gains a dedicated ACP reason.
    default:
      return 'end_turn'
  }
}

/**
 * Translate a harness {@link ContentBlock} from a prompt into ACP content for
 * replay, or `undefined` for block kinds the bridge does not surface to the
 * client as message content. Today only `text` maps (text-only
 * `promptCapabilities`); `reasoning` is surfaced via `agent_thought_chunk`
 * streaming rather than as a message block, and `tool-call`/`tool-result`/
 * `image` are handled by the tool-call update path or not advertised.
 */
export function harnessBlockToAcpContent(block: ContentBlock): AcpContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    // reasoning → streamed as agent_thought_chunk, not a message block
    // tool-call / tool-result → the tool_call / tool_call_update path
    // image → not advertised (text-only promptCapabilities)
    default:
      return undefined
  }
}

/**
 * Extract plain text from an ACP prompt's content blocks, concatenating every
 * `text` block. Non-text blocks are ignored here; the caller rejects a prompt
 * carrying image/audio per the advertised text-only capabilities BEFORE
 * calling this, so dropping them here only affects `resource`/`resource_link`
 * (which carry no inline text to forward in the MVP).
 */
export function acpPromptToText(prompt: readonly AcpContentBlock[]): string {
  return prompt
    .filter((block): block is AcpContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Whether an ACP prompt contains any content the text-only bridge cannot
 * accept — i.e. ANY non-`text` block (image, audio, `resource`, `resource_link`,
 * …). The caller rejects such a prompt up front rather than silently dropping
 * the unsupported parts: a prompt like `[text, resource_link]` carries context
 * the model would otherwise never see, so running it text-only would be silent
 * data loss. When richer block kinds are supported, narrow this.
 */
export function promptHasUnsupportedContent(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some(block => block.type !== 'text')
}
