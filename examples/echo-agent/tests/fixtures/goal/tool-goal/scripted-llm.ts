/** Deterministic adapter that creates, reads, then pauses one goal. */

import type { Context } from 'cordis'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

interface GoalState {
  readonly id: string
  readonly revision: number
}

/** Text from the latest ordinary user message, excluding raw goal-state context. */
function latestPrompt(messages: readonly Message[]): { index: number; text: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = message.content
      .filter(block => block.type === 'text' && !block.text.startsWith('<goal_state>'))
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    if (text.length > 0) return { index, text }
  }
  return { index: -1, text: '' }
}

/** Parse the latest domain snapshot rendered into history. */
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

/** Names of tool calls recorded after the latest ordinary prompt. */
function callsAfter(messages: readonly Message[], index: number): string[] {
  return messages.slice(index + 1).flatMap(message => message.content)
    .filter(block => block.type === 'tool-call')
    .map(block => block.type === 'tool-call' ? block.name : '')
}

/** Emit one tool-call response. */
async function* toolCall(name: string, args: object): AsyncIterable<StreamChunk> {
  const id = CallId(`call-${name}`)
  const raw = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Emit one terminal text response. */
async function* textReply(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class GoalScriptAdapter extends LlmAdapter {
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = latestPrompt(options.messages)
    const calls = callsAfter(options.messages, prompt.index)
    if (prompt.text === 'start' && !calls.includes('create_goal')) {
      return toolCall('create_goal', { objective: 'Finish the composed goal-tool proof', max_goal_rounds: 7 })
    }
    if (prompt.text === 'start' && !calls.includes('get_goal')) return toolCall('get_goal', {})
    if (prompt.text === 'start') return textReply('GOAL CREATED')
    if (prompt.text === 'pause' && !calls.includes('update_goal')) {
      const goal = latestGoal(options.messages)
      if (goal === undefined) throw new Error('scripted goal state missing')
      return toolCall('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'pause' })
    }
    if (prompt.text === 'pause') return textReply('UNEXPECTED CONTINUATION AFTER PAUSE')
    return textReply('UNEXPECTED PROMPT')
  }
}

export const name = 'goal-tool-scripted-llm'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['goal-script'], new GoalScriptAdapter())
}
