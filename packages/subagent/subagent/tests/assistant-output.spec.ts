import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantMessageOutput, finalAssistantOutput } from '../src/assistant-output.ts'

function message(content: ContentBlock[]): SessionEvent {
  return { type: 'assistant/message', data: { message: { content } } } as SessionEvent
}

function textDelta(text: string): SessionEvent {
  return { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } } as SessionEvent
}

function reasoningDelta(text: string): SessionEvent {
  return { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } } as SessionEvent
}

describe('assistantMessageOutput', () => {
  it('returns content only for a non-empty assistant message', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'answer' }]
    expect(assistantMessageOutput(message(content))).toBe(content)
    expect(assistantMessageOutput(message([]))).toBeUndefined()
    expect(assistantMessageOutput(textDelta('chunk'))).toBeUndefined()
  })
})

describe('finalAssistantOutput', () => {
  it('selects the last non-empty message past a later empty usage-only message', () => {
    const events = [
      message([{ type: 'text', text: 'step one' }]),
      message([{ type: 'text', text: 'step two' }]),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'step two' }])
  })

  it('prefers a non-empty message over the streamed text', () => {
    const events = [
      textDelta('streamed '),
      textDelta('text'),
      message([{ type: 'text', text: 'complete answer' }]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'complete answer' }])
  })

  it('falls back to accumulated text deltas when no non-empty message exists', () => {
    const events = [
      reasoningDelta('thinking'),
      textDelta('partial '),
      textDelta('answer'),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('returns undefined when the child produced neither messages nor text', () => {
    expect(finalAssistantOutput([])).toBeUndefined()
    expect(finalAssistantOutput([reasoningDelta('thinking'), message([])])).toBeUndefined()
  })
})
