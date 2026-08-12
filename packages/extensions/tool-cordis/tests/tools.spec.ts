import { describe, expect, it, vi } from 'vitest'
import { AGENT, CONSUMER_CODE, LISTENER_CODE, PROVIDER_CODE, REVERSE_TOOL_CODE, call, defineAndRun, setup, setupWithBrowser, text } from './helpers.ts'

/**
 * The five model-facing tools driven through the real registry pipeline: define
 * records and mints, run starts and reports, stop and undefine unwind, and every
 * refusal reaches the model as a tool error carrying the runner's teaching text.
 * The runner's own semantics are covered by its package; here the subject is the
 * model-facing contract (arguments, canonical values, rendered text, metadata).
 */

describe('cordis_define', () => {
  it('records a definition and carries the minted id in its value and its presentation metadata', async () => {
    const ctx = await setup()

    const result = await call(ctx, 'cordis_define', {
      name: 'greeter',
      purpose: 'greets by name',
      code: PROVIDER_CODE,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected cordis_define success')
    expect(result.value).toEqual({
      id: 'dyn-1',
      name: 'greeter',
      purpose: 'greets by name',
      hasHostHalf: true,
      hasClientHalf: false,
    })
    // The card addresses run/stop by this id, and only the durable metadata
    // carries it (the model never wrote it).
    expect(result.meta).toEqual({ id: 'dyn-1' })
    expect(text(result)).toBe(
      'Dynamic package dyn-1 ("greeter") is defined with a host half and is NOT running yet. '
      + 'Run it with cordis_run id:"dyn-1", or let the user press start on its card.',
    )
    // Nothing ran: the provided service is absent until cordis_run.
    expect(ctx.get('greeter')).toBeUndefined()
  })

  it('names both halves in the rendered summary', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_define', {
      name: 'dual',
      purpose: 'both halves',
      code: PROVIDER_CODE,
      client: 'return () => {}',
    })
    expect(text(result)).toContain('is defined with a host + browser half')
  })

  it('reports a parse failure as a tool error and records nothing', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_define', {
      name: 'broken',
      purpose: 'p',
      code: 'return { name: \'ts\' as const }',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('plain JavaScript, not TypeScript')
    expect(text(await call(ctx, 'cordis_runtime_inspect', { what: 'temporary' })))
      .toContain('No dynamic packages are defined in this session')
  })

  it('refuses a definition with neither half', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_define', { name: 'empty', purpose: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('needs `code` (host half), `client` (browser half), or both')
  })
})

describe('cordis_run', () => {
  it('starts the host half and reports what it provides', async () => {
    const ctx = await setup()
    const { value } = await call(ctx, 'cordis_define', { name: 'greeter', purpose: 'p', code: PROVIDER_CODE }) as { value: { id: string } }

    const result = await call(ctx, 'cordis_run', { id: value.id })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected cordis_run success')
    expect(result.value).toEqual({ id: 'dyn-1', rev: 1, provides: ['greeter'], waitingFor: [] })
    expect(text(result)).toContain('is running at rev 1: host half is running (provides: greeter)')
    expect(ctx.get('greeter')).toBeDefined()
  })

  it('keeps a package whose host half waits for a service, naming what it waits for', async () => {
    const ctx = await setup()
    const { value } = await call(ctx, 'cordis_define', { name: 'consumer', purpose: 'p', code: CONSUMER_CODE }) as { value: { id: string } }

    const result = await call(ctx, 'cordis_run', { id: value.id })

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('host half is pending (missing services: greeter)')
    expect(ctx.tools.get('greet')).toBeUndefined()
  })

  it('lets the agent give ITSELF a tool, callable on the next step', async () => {
    const ctx = await setup()
    await defineAndRun(ctx, REVERSE_TOOL_CODE)

    expect(ctx.tools.get('reverse_text')).toBeDefined()
    expect(text(await call(ctx, 'reverse_text', { text: 'abc' }))).toBe('cba')
  })

  it('runs a host-only package again without re-evaluating its host half', async () => {
    const ctx = await setup()
    const id = await defineAndRun(ctx, PROVIDER_CODE)

    // Re-evaluating would collide on the provided service; binding a live host
    // half is what lets a second call succeed at all.
    const again = await call(ctx, 'cordis_run', { id })

    expect(again.isError).toBe(false)
    if (again.isError) throw new Error('expected the re-run to succeed')
    expect(again.value).toMatchObject({ id, rev: 1 })
  })

  it('reports a sandbox failure as a tool error, leaving nothing running', async () => {
    const ctx = await setup()
    const { value } = await call(ctx, 'cordis_define', {
      name: 'boom',
      purpose: 'p',
      code: 'throw new Error(\'host half exploded\')',
    }) as { value: { id: string } }

    const result = await call(ctx, 'cordis_run', { id: value.id })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('host half exploded')
    expect(text(await call(ctx, 'cordis_runtime_inspect', { what: 'temporary' }))).toContain('[defined, not running]')
  })

  it('answers an unknown id with the memory-only explanation', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_run', { id: 'dyn-99' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('definitions live in memory only')
  })
})

describe('cordis_stop', () => {
  it('unwinds the package\'s registrations before it returns, and keeps the definition runnable', async () => {
    const ctx = await setup()
    const id = await defineAndRun(ctx, REVERSE_TOOL_CODE)

    const result = await call(ctx, 'cordis_stop', { id })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected cordis_stop success')
    expect(result.value).toEqual({ id })
    expect(text(result)).toContain('is stopped; its definition remains')
    expect(ctx.tools.get('reverse_text')).toBeUndefined()

    // Runnable again on a fresh revision, with no code re-sent.
    const again = await call(ctx, 'cordis_run', { id })
    expect(again.isError).toBe(false)
    expect(ctx.tools.get('reverse_text')).toBeDefined()
  })

  it('refuses to stop a package that is not running', async () => {
    const ctx = await setup()
    const { value } = await call(ctx, 'cordis_define', { name: 'idle', purpose: 'p', code: PROVIDER_CODE }) as { value: { id: string } }

    const result = await call(ctx, 'cordis_stop', { id: value.id })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not running')
  })
})

describe('cordis_undefine', () => {
  it('stops a running package, forgets it, and invalidates its id', async () => {
    const ctx = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = await defineAndRun(ctx, LISTENER_CODE)

    const result = await call(ctx, 'cordis_undefine', { id })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected cordis_undefine success')
    expect(result.value).toEqual({ id, wasRunning: true })
    expect(text(result)).toContain('is stopped and undefined')
    const calls = log.mock.calls.length
    ctx.tools.register({
      name: 'post_undefine_trigger',
      description: 'test trigger',
      parameters: { type: 'object' as const, properties: {} },
      output: { schema: { type: 'null' as const }, render: () => [] },
      execute: async (): Promise<null> => null,
    })
    expect(log).toHaveBeenCalledTimes(calls)
    expect((await call(ctx, 'cordis_run', { id })).isError).toBe(true)
    vi.restoreAllMocks()
  })

  it('forgets a defined-but-never-run package', async () => {
    const ctx = await setup()
    const { value } = await call(ctx, 'cordis_define', { name: 'idle', purpose: 'p', code: PROVIDER_CODE }) as { value: { id: string } }

    const result = await call(ctx, 'cordis_undefine', { id: value.id })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected cordis_undefine success')
    expect(result.value).toEqual({ id: value.id, wasRunning: false })
  })
})

describe('session scope', () => {
  it('hides another session\'s package from every verb', async () => {
    const ctx = await setup()
    const id = await defineAndRun(ctx, PROVIDER_CODE)

    // A call from a different agent addresses a different definition space.
    const other = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'call-other' as never,
      name: 'cordis_run',
      arguments: { id },
      agent: { ...AGENT, id: 'S-other' } as never,
    })

    expect(other.isError).toBe(true)
    expect(text(other)).toContain('no dynamic package')
  })

  it('refuses a dynamic-package call that arrives without an agent', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'call-agentless' as never,
      name: 'cordis_define',
      arguments: { name: 'x', purpose: 'p', code: PROVIDER_CODE },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('need a session')
  })
})

describe('cordis_run with a browser half', () => {
  it('reports what each half provides and waits for once a page carried it out', async () => {
    const ctx = await setupWithBrowser(['someClientService'])
    const defined = await call(ctx, 'cordis_define', {
      name: 'both halves',
      purpose: 'host + browser',
      code: 'return { name: \'both-host\', apply(ctx) { ctx.provide(\'dynBoth\', {}) } }',
      client: 'return () => {}',
    })
    if (defined.isError) throw new Error('define failed')
    const result = await call(ctx, 'cordis_run', { id: (defined.value as { id: string }).id })
    if (result.isError) throw new Error(text(result))
    const value = result.value as { rev: number; provides: string[]; clientWaitingFor?: string[] }
    expect(value.rev).toBe(1)
    expect(value.provides).toEqual(['dynBoth'])
    // The answering page's own parked services ride back to the model.
    expect(value.clientWaitingFor).toEqual(['someClientService'])
    expect(text(result)).toContain('browser half is pending (missing services: someClientService)')
  })

  it('reports a browser-only package as running even though no host fiber exists', async () => {
    const ctx = await setupWithBrowser()
    const defined = await call(ctx, 'cordis_define', {
      name: 'browser only',
      purpose: 'ui only',
      client: 'return () => {}',
    })
    if (defined.isError) throw new Error('define failed')
    const result = await call(ctx, 'cordis_run', { id: (defined.value as { id: string }).id })
    if (result.isError) throw new Error(text(result))
    const value = result.value as { rev: number; provides: string[]; waitingFor: string[] }
    // No host half means no fiber to read provides/waits from — not an error.
    expect(value.provides).toEqual([])
    expect(value.waitingFor).toEqual([])
    expect(text(result)).toContain('host half is running (provides: none)')
  })
})

describe('cordis_undefine refusals', () => {
  it('fails loud for an id the registry never minted', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_undefine', { id: 'dyn-99' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('dyn-99')
  })
})
