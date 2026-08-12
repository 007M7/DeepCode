import { describe, expect, it } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { AGENT, call, setup, text } from './helpers.ts'

const HOST = 'return { apply() {} }'

async function preStep(ctx: Awaited<ReturnType<typeof setup>>, messages: UserMessage[]) {
  return await agentEvents(ctx, AGENT).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

describe('versioned Cordis tools', () => {
  it('defines Host and Client code under one code object and returns Host-minted identities', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'clock' },
      name: 'Clock',
      purpose: 'show time',
      code: { host: HOST, client: 'return { apply() {} }' },
    })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      pluginId: 'clock-1',
      packageId: 'pkg-1',
      hasHostHalf: true,
      hasClientHalf: true,
    })
    expect(result.meta).toEqual({ pluginId: 'clock-1', packageId: 'pkg-1' })
    expect(text(result)).toContain('clock-1/pkg-1')
  })

  it('runs an exact Package and persists Plugin, Package, and Plugin Run metadata', async () => {
    const ctx = await setup()
    const defined = await call(ctx, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'clock' },
      name: 'Clock',
      purpose: 'show time',
      code: { host: HOST },
    })
    const { pluginId, packageId } = defined.value as { pluginId: string; packageId: string }

    const result = await call(ctx, 'cordis_run', { pluginId, packageId, mode: 'run' })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ pluginId, packageId, pluginRunId: 'run-1' })
    expect(result.meta).toEqual({ pluginId, packageId, pluginRunId: 'run-1' })
  })

  it('injects a source-free Package reference and exposes source only through package inspection', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_define', {
      plugin: { kind: 'new', idPrefix: 'clock' },
      name: 'Clock',
      purpose: 'show time',
      code: { host: HOST },
    })
    const prompt = createUserMessage({
      content: [{ type: 'text', text: '请修改 @clock-1 的显示' }],
      source: { kind: 'user' },
    })

    const decision = await preStep(ctx, [prompt])

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const injected = decision.messages.at(-1)?.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    expect(injected).toContain('"pluginId": "clock-1"')
    expect(injected).toContain('"packageId": "pkg-1"')
    expect(injected).not.toContain(HOST)
    expect(injected).toContain('cordis_package_inspect')
    expect(injected).toContain('plugin.kind="existing"')
    expect(injected).toContain('Do not create a new Plugin')

    const inspected = await call(ctx, 'cordis_package_inspect', {
      pluginId: 'clock-1',
      packageId: 'pkg-1',
    })
    expect(inspected.isError).toBe(false)
    expect(inspected.value).toMatchObject({
      pluginId: 'clock-1',
      packageId: 'pkg-1',
      name: 'Clock',
      purpose: 'show time',
      code: { host: HOST },
    })
    expect(text(inspected)).toContain(HOST)
  })

  it('exposes Package inspection through the runtime API catalog', async () => {
    const ctx = await setup()
    const report = text(await call(ctx, 'cordis_runtime_inspect', {
      what: 'api',
      name: 'dynamicCordisRunner',
    }))

    expect(report).toContain('inspectPackage(')
    expect(report).toContain('DynamicCordisPackageInspection')
  })
})
