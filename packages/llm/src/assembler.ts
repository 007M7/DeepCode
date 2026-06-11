/**
 * Incremental chunk-to-message assembler. This is the single canonical assembly
 * algorithm used by both the agent loop and the LLM service convenience views.
 *
 * @module @deepseek-ai/dsh-llm/assembler
 */

import { CallId } from './brand.ts'
import type { ContentBlock, FinishReason, GenerateResult, Message, StreamChunk, TokenUsage } from './types.ts'

interface PartialBlock {
  blockType: string
  text: string
  toolCallId?: CallId
  toolCallName?: string
  toolCallArguments: string
  /** Set by `block-end` — authoritative, and freezes the partial. */
  block?: ContentBlock
}

/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant {@link Message}.
 *
 * This is the single shared assembly implementation: the agent loop feeds it
 * while logging raw chunks for replay fidelity, and `LlmService.generate()` /
 * `streamBlocks()` use it to offer assembled views of the same stream.
 *
 * Tolerant of delta-only protocols (no block-start/end); deltas arriving for
 * an index already closed by `block-end` are ignored (malformed stream) so a
 * misbehaving adapter cannot grow memory or corrupt a completed block.
 */
export class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  private order: number[] = []
  private flushed = 0
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined

  /**
   * Feed one chunk. Returns the completed block when the chunk closes one
   * (an explicit `block-end`), otherwise undefined.
   */
  push(chunk: StreamChunk): ContentBlock | undefined {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        partial.block = chunk.block
        return chunk.block
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        return
      }
    }
  }

  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? CallId(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** Invariant accessor: every index in `order` has a partial. */
  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  /** Assemble all blocks seen so far, in stream order. */
  blocks(): ContentBlock[] {
    return this.order.map(index => this.assemble(this.mustGet(index), index))
  }

  /**
   * Streaming flush: returns (once) every block that is complete AND has no
   * incomplete block before it in stream order. Call after each `push()`;
   * blocks come out strictly in stream order, so a streaming consumer sees
   * exactly the sequence `blocks()` would produce.
   */
  flushReady(): ContentBlock[] {
    const ready: ContentBlock[] = []
    while (this.flushed < this.order.length) {
      const index = this.order[this.flushed]
      /* v8 ignore next 3 -- noUncheckedIndexedAccess guard: loop condition guarantees index exists in a non-empty array */
      if (index === undefined) break
      const partial = this.mustGet(index)
      if (!partial.block) break
      ready.push(partial.block)
      this.flushed += 1
    }
    return ready
  }

  /**
   * End-of-stream flush: returns (once) all not-yet-flushed blocks, in stream
   * order, assembling still-open ones from their deltas (delta-only
   * protocols). After this, `flushReady()` + `flushRemaining()` together have
   * yielded exactly `blocks()`.
   */
  flushRemaining(): ContentBlock[] {
    const remaining: ContentBlock[] = []
    while (this.flushed < this.order.length) {
      const index = this.order[this.flushed]
      /* v8 ignore next 3 -- noUncheckedIndexedAccess guard: loop condition guarantees index exists */
      if (index === undefined) break
      remaining.push(this.assemble(this.mustGet(index), index))
      this.flushed += 1
    }
    return remaining
  }

  get usage(): TokenUsage | undefined {
    return this._usage
  }

  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /** The assembled assistant message. */
  message(): Message {
    return { role: 'assistant', content: this.blocks() }
  }

  /** The assembled non-streaming result. */
  result(): GenerateResult {
    return {
      message: this.message(),
      ...this._usage !== undefined ? { usage: this._usage } : {},
      finish: this.finish,
    }
  }
}
