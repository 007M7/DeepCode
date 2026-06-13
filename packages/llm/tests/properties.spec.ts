/**
 * Property-based tests for the BlockAssembler (RFC 001 → ADR 0013).
 *
 * The assembler is protocol-shaped: arbitrary interleavings of block-start,
 * deltas, block-end, usage, and finish — valid and malformed (duplicate
 * indices, stragglers after block-end, missing block-start, delta-only). The
 * invariants below are the contract the agent loop and LlmService rely on.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'

// A small pool of indices so collisions (duplicate-index bugs) are common.
const indexArb = fc.integer({ min: 0, max: 4 })

const blockEndArb = (index: number): fc.Arbitrary<StreamChunk> => fc.oneof(
  fc.record({ text: fc.string() }).map((r): StreamChunk => (
    { type: 'block-end', index, block: { type: 'text', text: r.text } }
  )),
  fc.record({ text: fc.string() }).map((r): StreamChunk => (
    { type: 'block-end', index, block: { type: 'reasoning', text: r.text } }
  )),
  fc.record({ id: fc.string({ minLength: 1 }), name: fc.string(), args: fc.string() }).map((r): StreamChunk => (
    { type: 'block-end', index, block: { type: 'tool-call', id: CallId(r.id), name: r.name, arguments: r.args } }
  )),
)

/** One arbitrary chunk over the small index pool — valid and malformed mixes. */
const chunkArb: fc.Arbitrary<StreamChunk> = indexArb.chain(index => fc.oneof(
  fc.constant<StreamChunk>({ type: 'block-start', index, blockType: 'text' }),
  fc.constant<StreamChunk>({ type: 'block-start', index, blockType: 'reasoning' }),
  fc.constant<StreamChunk>({ type: 'block-start', index, blockType: 'tool-call' }),
  fc.string().map((text): StreamChunk => ({ type: 'text-delta', index, text })),
  fc.string().map((text): StreamChunk => ({ type: 'reasoning-delta', index, text })),
  fc.record({ id: fc.string({ minLength: 1 }), argumentsDelta: fc.string() })
    .map((r): StreamChunk => ({ type: 'tool-call-delta', index, id: CallId(r.id), argumentsDelta: r.argumentsDelta })),
  blockEndArb(index),
  fc.constant<StreamChunk>({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }),
))

/** A stream is a list of chunks; we add the terminal `finish` ourselves. */
const streamArb = fc.array(chunkArb, { maxLength: 30 })

/** Feed a fresh assembler, return it. */
function feed(chunks: StreamChunk[]): BlockAssembler {
  const a = new BlockAssembler()
  for (const chunk of chunks) a.push(chunk)
  return a
}

describe('BlockAssembler properties', () => {
  it('flushReady() ++ flushRemaining() === blocks(), in order', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const streaming = new BlockAssembler()
      const flushed: ContentBlock[] = []
      for (const chunk of chunks) {
        streaming.push(chunk)
        flushed.push(...streaming.flushReady())
      }
      flushed.push(...streaming.flushRemaining())

      const oneShot = feed(chunks).blocks()
      expect(flushed).toEqual(oneShot)
    }))
  })

  it('streamBlocks-style flush never yields a block before an earlier open one', () => {
    // flushReady is strict-order: once it stops at an open index, no later
    // index may be emitted until that one closes. We assert the flushed prefix
    // is always a prefix of the final blocks() order.
    fc.assert(fc.property(streamArb, (chunks) => {
      const streaming = new BlockAssembler()
      const flushed: ContentBlock[] = []
      for (const chunk of chunks) {
        streaming.push(chunk)
        flushed.push(...streaming.flushReady())
      }
      const finalSoFar = streaming.blocks()
      // Everything flushed mid-stream is a prefix of the full ordered blocks.
      expect(finalSoFar.slice(0, flushed.length)).toEqual(flushed)
    }))
  })

  it('partials map size never exceeds the number of distinct indices seen', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const distinct = new Set<number>()
      for (const chunk of chunks) {
        if ('index' in chunk) distinct.add(chunk.index)
      }
      const a = feed(chunks)
      // blocks() length equals the number of distinct indices that became
      // partials (block-bearing chunks). It can never exceed distinct indices.
      expect(a.blocks().length).toBeLessThanOrEqual(distinct.size)
    }))
  })

  it('re-assembly is idempotent: blocks() is stable across repeated calls', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const a = feed(chunks)
      expect(a.blocks()).toEqual(a.blocks())
      // And message().content mirrors blocks().
      expect(a.message().content).toEqual(a.blocks())
    }))
  })

  it('blocks() never throws and yields only valid content-block tags', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const blocks = feed(chunks).blocks()
      for (const block of blocks) {
        expect(['text', 'reasoning', 'tool-call', 'tool-result', 'image']).toContain(block.type)
      }
    }))
  })

  it('result().finish defaults to stop when no finish chunk arrives', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const a = feed(chunks)
      const hasFinish = chunks.some(c => c.type === 'finish')
      if (!hasFinish) expect(a.finish).toEqual({ kind: 'stop' })
    }))
  })
})
