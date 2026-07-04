import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { Config } from '@deepseek-ai/dsh-llm-pi-ai'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { assemble, type AssembledResult } from './assemble.ts'

/**
 * Real-API e2e for the pi-ai-backed adapter: V4 Flash + V4 Pro across all
 * reasoning levels the adapter exposes (off / high / xhigh→wire 'max').
 * Mirrors the llm-deepseek matrix so the two independent implementations
 * verify the same StreamChunk contract. Key-gated.
 */

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'
const contexts: Context[] = []

async function harness(model: string, config: Partial<Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmPiAi, { models: [model], ...config })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text }] }]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function blockKinds(result: AssembledResult): string[] {
  return result.message.content.map(block => block.type)
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

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('llm-pi-ai e2e (real API)', () => {
  it.each([FLASH, PRO])('%s + reasoning off: plain text generation', async (model) => {
    const ctx = await harness(model, { reasoning: 'off' })
    const result = await assemble(ctx,{
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(false)
  })

  it.each([FLASH, PRO])('%s + reasoning high: reasoning blocks present', async (model) => {
    const ctx = await harness(model, { reasoning: 'high' })
    const result = await assemble(ctx,{
      model,
      messages: ask('Which is larger, 9.11 or 9.8? Answer with just the number.'),
      maxTokens: 2000,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(true)
    expect(textOf(result)).toContain('9.8')
  })

  it('pro + reasoning xhigh (wire max): tool-call round trip', async () => {
    const ctx = await harness(PRO, { reasoning: 'xhigh' })

    const first = await assemble(ctx,{
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

    const second = await assemble(ctx,{
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
  })

  it('produces the same block structure as llm-deepseek for the same prompt', async () => {
    // Loose structural equivalence between the two independent adapters:
    // same block KINDS in the same order for a deterministic prompt — the
    // cross-implementation check that the StreamChunk design holds.
    const deepseekCtx = new Context()
    contexts.push(deepseekCtx)
    await deepseekCtx.plugin(LlmService)
    await deepseekCtx.plugin(LlmDeepSeek, { models: [FLASH], thinking: 'disabled' })

    const piCtx = await harness(FLASH, { reasoning: 'off' })

    const prompt = ask('Reply with exactly the word: pong')
    const [fromDeepSeek, fromPiAi] = await Promise.all([
      assemble(deepseekCtx, { model: FLASH, messages: prompt, maxTokens: 50 }),
      assemble(piCtx, { model: FLASH, messages: prompt, maxTokens: 50 }),
    ])
    expect(blockKinds(fromPiAi)).toEqual(blockKinds(fromDeepSeek))
    expect(fromPiAi.finish.kind).toBe(fromDeepSeek.finish.kind)
  })
})
