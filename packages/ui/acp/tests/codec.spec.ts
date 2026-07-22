import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSessionReferenceUri, formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import {
  acpPromptToReferencedPrompt,
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
    expect(turnEndToStopReason({ kind: 'aborted' })).toBe('cancelled')
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

  it('returns undefined for non-text blocks (reasoning / plugin-added)', () => {
    expect(harnessBlockToAcpContent({ type: 'reasoning', text: 'think' })).toBeUndefined()
    expect(harnessBlockToAcpContent({ type: 'chart', data: 'x' } as unknown as ContentBlock)).toBeUndefined()
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

describe('acpPromptToReferencedPrompt', () => {
  it('extracts resource links and inline mentions while preserving ordinary links', () => {
    const sessionId = SessionId('source/会话')
    const prompt: AcpContentBlock[] = [
      { type: 'text', text: `compare ${formatSessionReferenceMention({ sessionId, label: 'inline' })} with ` },
      { type: 'resource_link', uri: encodeSessionReferenceUri(sessionId), name: 'linked' },
      { type: 'resource_link', uri: 'file:///x', name: 'x' },
    ]
    expect(acpPromptToReferencedPrompt(prompt)).toEqual({
      text: 'compare @inline with @linked\n[resource_link name="x" uri="file:///x"]\n',
      references: [{ sessionId, label: 'inline' }, { sessionId, label: 'linked' }],
    })
  })

  it('rejects malformed session resource links', () => {
    expect(() => acpPromptToReferencedPrompt([
      { type: 'resource_link', uri: 'dsh-session:%%%', name: 'bad' },
    ])).toThrow(/invalid session reference URI/)
  })

  it('uses the decoded id for an empty resource name and ignores unsupported direct inputs', () => {
    const sessionId = SessionId('source')
    expect(acpPromptToReferencedPrompt([
      { type: 'resource_link', uri: encodeSessionReferenceUri(sessionId), name: '' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' },
    ])).toEqual({ text: '@source', references: [{ sessionId, label: 'source' }] })
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
