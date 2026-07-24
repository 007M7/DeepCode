import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import { WEB_PLAN_SECTION, apply, inject } from '../src/index.ts'

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
    expect((await ctx.systemPrompt.assemble()).sections)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'plan:policy', text: '' })]))

    await feature.dispose()
    expect(ctx.get('planMode')).toBeUndefined()
    expect(ctx.tools.get(EXIT_PLAN_MODE)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('plan:policy')
  })
})
