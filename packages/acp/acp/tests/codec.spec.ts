import { describe, expect, it } from 'vitest'
import { acpPromptToText, promptHasUnsupportedContent } from '../src/codec.ts'

describe('ACP automation codec', () => {
  it('flattens baseline blocks and rejects everything richer', () => {
    expect(acpPromptToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(acpPromptToText([
      { type: 'text', text: 'see' },
      { type: 'resource_link', name: 'x', uri: 'file:///x' },
    ])).toBe('see\n[resource_link name="x" uri="file:///x"]\n')
    expect(acpPromptToText([{ type: 'image', data: '', mimeType: 'image/png' }])).toBe('')
    expect(promptHasUnsupportedContent([
      { type: 'text', text: 'ok' },
      { type: 'resource_link', name: 'x', uri: 'file:///x' },
    ])).toBe(false)
    expect(promptHasUnsupportedContent([
      { type: 'image', data: '', mimeType: 'image/png' },
    ])).toBe(true)
  })
})
