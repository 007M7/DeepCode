import { describe, expect, it } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import {
  acpPromptToText,
  harnessBlockToAcpContent,
  promptHasUnsupportedContent,
  turnEndToStopReason,
} from '../src/codec.ts'

describe('turnEndToStopReason', () => {
  // The SDK rejects an unknown stopReason, so this must be total over every
  // TurnEndReason kind and always produce a legal wire value.
  it('maps every known TurnEndReason kind to a legal StopReason', () => {
    expect(turnEndToStopReason({ kind: 'completed' })).toBe('end_turn')
    expect(turnEndToStopReason({ kind: 'max-tokens' })).toBe('max_tokens')
    expect(turnEndToStopReason({ kind: 'aborted', reason: 'x' })).toBe('cancelled')
    expect(turnEndToStopReason({ kind: 'disposed' })).toBe('cancelled')
    expect(turnEndToStopReason({ kind: 'rejected', reason: 'blocked by hook' })).toBe('cancelled')
    expect(turnEndToStopReason({ kind: 'error', step: 1, message: 'boom' })).toBe('end_turn')
  })

  it('falls back to end_turn for an unknown (merge-extensible) future kind', () => {
    // A plugin-added TurnEndReason variant the bridge does not yet know about
    // must still produce a legal wire value, not throw into the SDK.
    const future = { kind: 'refusal' } as unknown as TurnEndReason
    expect(turnEndToStopReason(future)).toBe('end_turn')
  })
})

describe('harnessBlockToAcpContent', () => {
  it('maps a text block to ACP text content', () => {
    expect(harnessBlockToAcpContent({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' })
  })

  it('returns undefined for non-text blocks (reasoning/tool/image)', () => {
    expect(harnessBlockToAcpContent({ type: 'reasoning', text: 'think' })).toBeUndefined()
    expect(harnessBlockToAcpContent({ type: 'image', url: 'https://x/y.png', mimeType: 'image/png' })).toBeUndefined()
  })
})

describe('acpPromptToText', () => {
  it('concatenates text blocks and renders resource links explicitly', () => {
    const prompt: AcpContentBlock[] = [
      { type: 'text', text: 'hello ' },
      { type: 'resource_link', uri: 'file:///x', name: 'x' },
      { type: 'text', text: 'world' },
    ]
    expect(acpPromptToText(prompt)).toBe('hello \n[resource_link name="x" uri="file:///x"]\nworld')
  })

  it('returns empty string for a prompt with no text blocks', () => {
    expect(acpPromptToText([{ type: 'image', mimeType: 'image/png', data: 'AA==' }])).toBe('')
  })
})

describe('promptHasUnsupportedContent', () => {
  it('detects image, audio, and embedded resource blocks', () => {
    expect(promptHasUnsupportedContent([{ type: 'image', mimeType: 'image/png', data: 'AA==' }])).toBe(true)
    expect(promptHasUnsupportedContent([{ type: 'audio', mimeType: 'audio/wav', data: 'AA==' }])).toBe(true)
    expect(promptHasUnsupportedContent([{ type: 'resource', resource: { uri: 'file:///x', text: 'x' } }])).toBe(true)
  })

  it('passes baseline text and resource_link prompt blocks', () => {
    expect(promptHasUnsupportedContent([{ type: 'text', text: 'hi' }])).toBe(false)
    expect(promptHasUnsupportedContent([{ type: 'resource_link', uri: 'file:///x', name: 'x' }])).toBe(false)
  })
})
