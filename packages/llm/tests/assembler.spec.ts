import { describe, expect, it } from 'vitest'
import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'

describe('BlockAssembler', () => {
  it('assembles interleaved text, reasoning, and tool-call deltas', () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking…' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello' },
      { type: 'text-delta', index: 1, text: ' world' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'echo', argumentsDelta: '{"text":' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '"hi"}' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: 'Hello world' },
      { type: 'tool-call', id: 'call-1', name: 'echo', arguments: '{"text":"hi"}' },
    ])
    expect(assembler.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.message().role).toBe('assistant')
  })

  it('returns the completed block from push() on block-end', () => {
    const assembler = new BlockAssembler()
    expect(assembler.push({ type: 'block-start', index: 0, blockType: 'text' })).toBeUndefined()
    expect(assembler.push({ type: 'text-delta', index: 0, text: 'hi' })).toBeUndefined()
    const block = assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })
    expect(block).toEqual({ type: 'text', text: 'hi' })
  })

  it('tolerates deltas without explicit block-start/end', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'text-delta', index: 0, text: 'implicit' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'implicit' }])
    expect(assembler.finish).toEqual({ kind: 'stop' })
  })
})
