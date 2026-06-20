import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateResult, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { Config } from '@deepseek-ai/dsh-llm-deepseek'

/**
 * Real-API e2e for the hand-rolled adapter: V4 Flash + V4 Pro across
 * thinking modes and both official effort levels. Key-gated — skips
 * entirely without $DEEPSEEK_API_KEY (see vitest.e2e.config.ts).
 */

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'
const contexts: Context[] = []

async function harness(model: string, config: Partial<Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmDeepSeek, { models: [model], ...config })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text }] }]
}

function textOf(result: GenerateResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

const weatherTool: ToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('llm-deepseek e2e (real API)', () => {
  it('flash + thinking disabled: plain text generation', async () => {
    const ctx = await harness(FLASH, { thinking: 'disabled' })
    const result = await ctx.llm.generate({
      model: FLASH,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(result.usage?.inputTokens).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('flash + thinking enabled (effort high): reasoning blocks + reasoning tokens', async () => {
    const ctx = await harness(FLASH, { thinking: 'enabled', reasoningEffort: 'high' })
    const result = await ctx.llm.generate({
      model: FLASH,
      messages: ask('Which is larger, 9.11 or 9.8? Answer with just the number.'),
      maxTokens: 2000,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(true)
    expect(textOf(result)).toContain('9.8')
    expect(result.usage?.reasoningTokens).toBeGreaterThan(0)
  })

  it.each(['high', 'max'] as const)(
    'pro + thinking enabled (effort %s): tool-call round trip with reasoning passback',
    async (effort) => {
      const ctx = await harness(PRO, { thinking: 'enabled', reasoningEffort: effort })

      // Turn 1: the model must call the tool (and think before it).
      const first = await ctx.llm.generate({
        model: PRO,
        messages: ask('What is the weather in Paris right now? Use the get_weather tool.'),
        tools: [weatherTool],
        maxTokens: 2000,
      })
      expect(first.finish.kind).toBe('tool-calls')
      const call = first.message.content.find(block => block.type === 'tool-call')
      expect(call).toBeDefined()
      expect(call!.name).toBe('get_weather')
      expect(JSON.parse(call!.arguments)).toMatchObject({ city: expect.stringMatching(/paris/i) as string })

      // Turn 2: send the tool result back WITH the assistant's reasoning
      // block in history (the official thinking+tools passback rule).
      const second = await ctx.llm.generate({
        model: PRO,
        messages: [
          ...ask('What is the weather in Paris right now? Use the get_weather tool.'),
          { role: 'assistant', content: first.message.content },
          {
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: CallId(call!.id),
              content: [{ type: 'text', text: 'Sunny, 22°C' }],
            }],
          },
        ],
        tools: [weatherTool],
        maxTokens: 2000,
      })
      expect(second.finish.kind).toBe('stop')
      expect(textOf(second).toLowerCase()).toMatch(/sunny|22/)
    },
  )

  it('pro + thinking disabled: plain generation without reasoning blocks', async () => {
    const ctx = await harness(PRO, { thinking: 'disabled' })
    const result = await ctx.llm.generate({
      model: PRO,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(false)
  })

  it('streams raw chunks in protocol order', async () => {
    const ctx = await harness(FLASH, { thinking: 'disabled' })
    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      model: FLASH,
      messages: ask('Count from 1 to 5, digits only.'),
      maxTokens: 50,
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds[0]).toBe('block-start')
    expect(kinds.at(-1)).toBe('finish')
    expect(kinds.filter(kind => kind === 'finish')).toHaveLength(1)
    // usage precedes finish (deferred-emit contract)
    expect(kinds.indexOf('usage')).toBeLessThan(kinds.indexOf('finish'))
  })
})
