import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { codingHarness, finalText, SYSTEM_PROMPT, waitForIdle } from './harness.ts'

/**
 * The first place a REAL model meets the REAL bash tool: the cheap canary
 * before the coding-task e2e. Key-gated (see vitest.e2e.config.ts).
 */

let ctx: Context | undefined

afterEach(async () => {
  // Always dispose the harness, even on failure/retry/timeout: agent-loop
  // teardown stops the loop and LocalBashExecutor teardown kills any
  // process the model left behind.
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('full loop: real model + real bash tool', () => {
  it('runs a bash command on request and reports its output', async () => {
    ctx = await codingHarness(process.cwd())
    const agent = ctx.agentLoop.create(AgentId('e2e-loop'), {
      model: 'deepseek-v4-flash',
      systemPrompt: SYSTEM_PROMPT,
    })

    agent.send([{ type: 'text', text: 'Run `echo e2e-ok` with the bash tool and tell me its exact output.' }])
    await waitForIdle(ctx, agent)

    const events = [...agent.session.events]
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some(event => event.data.name === 'bash')).toBe(true)

    const results = events.filter(event => event.type === 'tool/result')
    const resultTexts = results.flatMap(event =>
      event.data.content.filter(block => block.type === 'text').map(block => block.text))
    expect(resultTexts.some(text => text.includes('e2e-ok'))).toBe(true)

    expect(finalText(events)).toContain('e2e-ok')
  }, 120_000)
})
