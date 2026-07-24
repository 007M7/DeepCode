import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WEB_DEFAULT_SECTION, WEB_PLAN_SECTION, apply, inject } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-plan node plugin', () => {
  it('mounts the Web policy and stable exit tool for the selected feature lifecycle', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(UserInteractionService)
    const feature = ctx.plugin({ inject: [...inject], apply })
    await feature.await()

    expect(ctx.get('planMode')).toBeDefined()
    expect(ctx.tools.get(EXIT_PLAN_MODE)).toBeDefined()
    expect(WEB_PLAN_SECTION).toContain('Stay in plan mode until exit_plan_mode succeeds')
    expect(WEB_PLAN_SECTION).toContain('Do not edit or write files')
    expect(WEB_PLAN_SECTION).toContain('Make exit_plan_mode the only and final tool call')
    expect(WEB_DEFAULT_SECTION).toContain('default mode, not plan mode')
    expect(WEB_DEFAULT_SECTION).toContain('Do not call exit_plan_mode in default mode')
    expect((await ctx.systemPrompt.assemble()).sections)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'plan:default-policy', text: '' }),
        expect.objectContaining({ name: 'plan:policy', text: '' }),
      ]))

    await feature.dispose()
    expect(ctx.get('planMode')).toBeUndefined()
    expect(ctx.tools.get(EXIT_PLAN_MODE)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .toEqual(expect.not.arrayContaining(['plan:default-policy', 'plan:policy']))
  })

  it('states the exact Web collaboration mode at every agent assembly', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(UserInteractionService)
    const feature = ctx.plugin({ inject: [...inject], apply })
    await feature.await()

    const events: SessionEvent[] = []
    const agent = { session: { events } } as unknown as Agent
    let sections = (await ctx.systemPrompt.assemble({ agent })).sections
    expect(sections.find(section => section.name === 'plan:default-policy')?.text)
      .toBe(WEB_DEFAULT_SECTION)
    expect(sections.find(section => section.name === 'plan:policy')?.text).toBe('')

    events.push({
      type: 'plan/mode',
      seq: 0,
      time: 1,
      data: { active: true },
    })
    sections = (await ctx.systemPrompt.assemble({ agent })).sections
    expect(sections.find(section => section.name === 'plan:default-policy')?.text).toBe('')
    expect(sections.find(section => section.name === 'plan:policy')?.text)
      .toBe(WEB_PLAN_SECTION)
  })
})
