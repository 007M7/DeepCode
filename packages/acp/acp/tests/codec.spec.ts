import { describe, expect, it } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { acpPromptToText, promptHasUnsupportedContent, turnEndToStopReason } from '../src/codec.ts'
import { agentOptions } from '../src/index.ts'

describe('ACP automation codec', () => {
  it('maps every known turn outcome to a legal stop reason', () => {
    const cases: [TurnEndReason, string][] = [
      [{ kind: 'completed' }, 'end_turn'],
      [{ kind: 'max-tokens' }, 'max_tokens'],
      [{ kind: 'aborted' }, 'cancelled'],
      [{ kind: 'disposed' }, 'cancelled'],
      [{ kind: 'rejected', reason: 'blocked' }, 'cancelled'],
      [{ kind: 'interrupted' }, 'cancelled'],
      [{ kind: 'error', step: 1, message: 'boom' }, 'end_turn'],
    ]
    for (const [reason, expected] of cases) expect(turnEndToStopReason(reason)).toBe(expected)
  })

  it('uses a legal fallback for merge-extensible future outcomes', () => {
    expect(turnEndToStopReason({ kind: 'future' } as unknown as TurnEndReason)).toBe('end_turn')
  })

  it('concatenates text and rejects every non-text block', () => {
    expect(acpPromptToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(acpPromptToText([{ type: 'resource_link', name: 'x', uri: 'file:///x' }])).toBe('')
    expect(promptHasUnsupportedContent([{ type: 'text', text: 'ok' }])).toBe(false)
    expect(promptHasUnsupportedContent([{ type: 'resource_link', name: 'x', uri: 'file:///x' }])).toBe(true)
  })

  it('copies only configured agent target fields', () => {
    expect(agentOptions({})).toEqual({})
    expect(agentOptions({ provider: 'deepseek' })).toEqual({ provider: 'deepseek' })
    expect(agentOptions({ model: 'model' })).toEqual({ model: 'model' })
    expect(agentOptions({ provider: 'deepseek', model: 'model' })).toEqual({ provider: 'deepseek', model: 'model' })
  })
})
