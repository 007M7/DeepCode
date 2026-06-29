import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import UserInteractionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-interaction'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'

interface OptionSchemaShape {
  properties: {
    options: {
      items: {
        properties: Record<string, { type: string }>
      }
    }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(toolAskUser)
  return ctx
}

describe('ask_user_question tool', () => {
  it('registers a model-facing tool schema', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'ask_user_question')

    expect(schema).toMatchObject({
      name: 'ask_user_question',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array' },
          allow_custom: { type: 'boolean' },
        },
        required: ['question'],
      },
    })
    const parameters = schema?.parameters as unknown as OptionSchemaShape
    expect(parameters.properties.options.items.properties).toMatchObject({
      description: { type: 'string' },
      recommended: { type: 'boolean' },
    })
    expect(parameters.properties.options.items.properties).not.toHaveProperty('desc')
  })

  it('asks the registered user-interaction provider and returns the answer text', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userInteraction.registerProvider({
      async ask(request) {
        seen.push(request)
        const option = request.options?.[0]
        return option === undefined ? { answer: 'Use pnpm' } : { answer: 'Use pnpm', option }
      },
    })

    const result = await ctx.tools.execute({
      callId: CallId('ask-1'),
      name: 'ask_user_question',
      arguments: {
        question: 'Which package manager should I use?',
        options: [{ label: 'pnpm', value: 'Use pnpm', recommended: true }],
        allow_custom: false,
      },
    })

    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'Use pnpm' }],
    })
    expect(seen).toMatchObject([{
      question: 'Which package manager should I use?',
      options: [{ label: 'pnpm', value: 'Use pnpm', recommended: true }],
      allowCustom: false,
    }])
  })

  it('passes the tool abort signal to the user-interaction request', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userInteraction.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answer: 'ok' }
      },
    })
    const controller = new AbortController()

    await ctx.tools.execute({
      callId: CallId('ask-2'),
      name: 'ask_user_question',
      arguments: { question: 'Continue?' },
      signal: controller.signal,
    })

    expect(seen[0]?.signal).toBe(controller.signal)
  })

  it('passes optional header and agent through to the user-interaction request', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userInteraction.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answer: 'ok' }
      },
    })
    const agent = { id: 'main' } as unknown as Agent

    const result = await ctx.tools.execute({
      callId: CallId('ask-3'),
      name: 'ask_user_question',
      arguments: { header: 'Confirm', question: 'Continue?' },
      agent,
    })

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(seen[0]).toMatchObject({ header: 'Confirm', agent })
  })

  it('returns structured user-interaction errors through tool execution', async () => {
    const ctx = await setup()

    const result = await ctx.tools.execute({
      callId: CallId('ask-no-provider'),
      name: 'ask_user_question',
      arguments: { question: 'Continue?' },
    })

    expect(result).toMatchObject({
      isError: true,
      error: { name: 'UserInteractionError', code: 'NO_PROVIDER' },
    })
  })

  it('uses an option label when the selected option has no explicit value', async () => {
    const ctx = await setup()
    ctx.userInteraction.registerProvider({
      async ask(request) {
        const option = request.options?.[0]
        if (option === undefined) throw new Error('missing option')
        return { answer: option.label, option }
      },
    })

    const result = await ctx.tools.execute({
      callId: CallId('ask-4'),
      name: 'ask_user_question',
      arguments: {
        question: 'Pick one',
        options: [{ label: 'Fallback label' }],
      },
    })

    expect(result.content).toEqual([{ type: 'text', text: 'Fallback label' }])
  })

  it('returns the provider-computed answer even when option metadata is present', async () => {
    const ctx = await setup()
    ctx.userInteraction.registerProvider({
      async ask(request) {
        const option = request.options?.[0]
        if (option === undefined) throw new Error('missing option')
        return { answer: `selected ${option.value}`, option }
      },
    })

    const result = await ctx.tools.execute({
      callId: CallId('ask-5'),
      name: 'ask_user_question',
      arguments: {
        question: 'Pick one',
        options: [{ label: 'A', value: 'a' }],
      },
    })

    expect(result.content).toEqual([{ type: 'text', text: 'selected a' }])
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(UserInteractionService)
    const fiber = await ctx.plugin(toolAskUser)
    expect(ctx.tools.get('ask_user_question')).toBeDefined()

    await fiber.dispose()

    expect(ctx.tools.get('ask_user_question')).toBeUndefined()
  })
})
