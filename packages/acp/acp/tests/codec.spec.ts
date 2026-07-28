import { describe, expect, it } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { acpPromptToText, promptHasUnsupportedContent, turnEndToStopReason } from '../src/codec.ts'

describe('ACP automation codec', () => {
  it('maps every known turn outcome to a legal stop reason', () => {
    const cases: [TurnEndReason, string][] = [
      [{ kind: 'completed' }, 'end_turn'],
      [{ kind: 'max-tokens' }, 'max_tokens'],
      [{ kind: 'aborted' }, 'cancelled'],
      [{ kind: 'disposed' }, 'cancelled'],
      [{ kind: 'interrupted' }, 'cancelled'],
      [{ kind: 'error', step: 1, message: 'boom' }, 'end_turn'],
    ]
    for (const [reason, expected] of cases) expect(turnEndToStopReason(reason)).toBe(expected)
  })

  it('uses a legal fallback for merge-extensible future outcomes', () => {
    expect(turnEndToStopReason({ kind: 'future' } as unknown as TurnEndReason)).toBe('end_turn')
  })

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
