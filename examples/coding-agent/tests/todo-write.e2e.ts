import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { codingHarness, TODO_SYSTEM_PROMPT, waitForIdle } from './harness.ts'

/**
 * A REAL model drives the REAL todo_write tool: verify the WORLD (the session
 * log gains a todo/write event whose snapshot the model actually produced), not
 * the agent's self-report. Key-gated (see vitest.e2e.config.ts).
 */

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('todo_write: real model records a plan', () => {
  it('appends a todo/write event with the model-produced task list', async () => {
    ctx = await codingHarness(process.cwd(), { persona: TODO_SYSTEM_PROMPT })
    const agent = ctx.agentLoop.create(AgentId('e2e-todo'), { model: 'deepseek-v4-flash' })

    agent.send([{ type: 'text', text:
      'Use the todo_write tool to record a plan of exactly two steps: first '
      + '"inspect the failing test" (in_progress), then "apply the fix" (pending). '
      + 'Send both in one todo_write call, then reply with the single word DONE.' }])
    await waitForIdle(ctx, agent)

    const events = [...agent.session.events]

    // The model actually called the tool.
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.some(event => event.data.name === 'todo_write')).toBe(true)

    // And the tool wrote a todo/write event to the log — verify the WORLD.
    const todoEvents = events.filter(event => event.type === 'todo/write')
    expect(todoEvents.length).toBeGreaterThan(0)

    const todos = (todoEvents.at(-1)!).data.todos
    expect(todos).toEqual([
      { content: 'inspect the failing test', status: 'in_progress' },
      { content: 'apply the fix', status: 'pending' },
    ])
  }, 120_000)
})
