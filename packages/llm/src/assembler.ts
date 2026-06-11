import type { ContentBlock, FinishReason, GenerateResult, Message, StreamChunk, TokenUsage } from './types.ts'

/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant {@link Message}.
 *
 * This is the single shared assembly implementation: the agent loop feeds it
 * while logging raw chunks for replay fidelity, and `LlmService.generate()` /
 * `streamBlocks()` use it to offer assembled views of the same stream.
 */
export class BlockAssembler {
  private partials = new Map<number, {
    blockType: string
    text: string
    toolCallId?: string
    toolCallName?: string
    toolCallArguments: string
    block?: ContentBlock
  }>()

  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined

  /**
   * Feed one chunk. Returns the completed block when the chunk closes one
   * (either an explicit `block-end` or an implicit close), otherwise undefined.
   */
  push(chunk: StreamChunk): ContentBlock | undefined {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) this.order.push(chunk.index)
        this.partials.set(chunk.index, {
          blockType: chunk.blockType,
          text: '',
          toolCallArguments: '',
        })
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
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

  private ensure(index: number, blockType: string) {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  /** Assemble all blocks seen so far, in stream order. */
  blocks(): ContentBlock[] {
    return this.order.map((index) => {
      const partial = this.partials.get(index)!
      if (partial.block) return partial.block
      switch (partial.blockType) {
        case 'text': return { type: 'text', text: partial.text }
        case 'reasoning': return { type: 'reasoning', text: partial.text }
        case 'tool-call': return {
          type: 'tool-call',
          id: partial.toolCallId ?? `call-${index}`,
          name: partial.toolCallName ?? '',
          arguments: partial.toolCallArguments,
        }
        default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
      }
    })
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
    return { message: this.message(), usage: this._usage, finish: this.finish }
  }
}
