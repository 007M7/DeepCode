import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold, finalAssistantOutput } from '../src/assistant-output.ts'

function message(content: ContentBlock[]): SessionEvent {
  return { type: 'assistant/message', data: { message: { content } } } as SessionEvent
}

function textDelta(text: string): SessionEvent {
  return { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } } as SessionEvent
}

function reasoningDelta(text: string): SessionEvent {
  return { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } } as SessionEvent
}

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

describe('AssistantOutputFold', () => {
  it('folds raw text pieces into the same streamed fallback (ACP chunk transport)', () => {
    const fold = new AssistantOutputFold()
    fold.pushText('partial ')
    fold.pushText('')
    fold.pushText('answer')
    expect(fold.collect()).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('collects undefined until any output is folded', () => {
    expect(new AssistantOutputFold().collect()).toBeUndefined()
  })
})
