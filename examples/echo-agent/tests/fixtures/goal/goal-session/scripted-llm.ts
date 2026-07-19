/** Deterministic model for the same-session goal-round composition proof. */

import type { Context } from 'cordis'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

interface GoalState {
  readonly id: string
  readonly revision: number
}

/** Text and position of the latest human or goal-round prompt. */
function latestPrompt(messages: readonly Message[]): { index: number; text: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = message.content
      .filter(block => block.type === 'text' && !block.text.startsWith('<goal_state>'))
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    if (text.includes('<goal_round>') || text === 'start') return { index, text }
  }
  return { index: -1, text: '' }
}

/** Parse the latest durable goal snapshot retained in request history. */
function latestGoal(messages: readonly Message[]): GoalState | undefined {
  for (const message of [...messages].reverse()) {
    for (const block of [...message.content].reverse()) {
      if (block.type !== 'text' || !block.text.startsWith('<goal_state>')) continue
      const json = block.text.slice('<goal_state>'.length, -'</goal_state>'.length)
      const value = JSON.parse(json) as { goal?: GoalState }
      if (value.goal !== undefined) return value.goal
    }
  }
  return undefined
}

/** Tool names already recorded after the prompt that owns this physical turn. */
function callsAfter(messages: readonly Message[], index: number): string[] {
  return messages.slice(index + 1).flatMap(message => message.content)
    .filter(block => block.type === 'tool-call')
    .map(block => block.type === 'tool-call' ? block.name : '')
}

/** Emit one deterministic tool call, optionally with visible progress text. */
async function* toolCall(name: string, args: object, text?: string): AsyncIterable<StreamChunk> {
  let index = 0
  if (text !== undefined) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
    index += 1
  }
  const id = CallId(`call-${name}`)
  const raw = JSON.stringify(args)
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id, name, argumentsDelta: raw }
  yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: raw } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Emit one terminal text response. */
async function* textReply(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class GoalSessionScriptAdapter extends LlmAdapter {
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = latestPrompt(options.messages)
    const calls = callsAfter(options.messages, prompt.index)
    if (prompt.text === 'start' && !calls.includes('create_goal')) {
      return toolCall('create_goal', {
        objective: 'Complete two deterministic same-session rounds',
        max_goal_rounds: 2,
      })
    }
    if (prompt.text === 'start') return textReply('GOAL CREATED')
    if (prompt.text.includes('Round: 1/2')) return textReply('ROUND ONE')
    if (prompt.text.includes('Round: 2/2') && !calls.includes('get_goal')) {
      return toolCall('get_goal', {})
    }
    if (prompt.text.includes('Round: 2/2') && !calls.includes('update_goal')) {
      const goal = latestGoal(options.messages)
      if (goal === undefined) throw new Error('scripted goal state missing')
      return toolCall('update_goal', {
        goal_id: goal.id,
        revision: goal.revision,
        action: 'complete',
      }, 'ROUND TWO COMPLETE')
    }
    return textReply('UNEXPECTED GOAL-SESSION REQUEST')
  }
}

export const name = 'goal-session-scripted-llm'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['goal-session-script'], new GoalSessionScriptAdapter())
}
