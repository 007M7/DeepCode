import { describe, expect, it } from 'vitest'
import { call, CONSUMER_CODE, CONTENT_OUTPUT_CODE, PROVIDER_CODE, setup, text } from './helpers.ts'

/**
 * Cross-mount composition through ordinary cordis provide/inject semantics:
 * one mount provides a service, another injects it, and mount ids stay the
 * lifecycle handles. Every assertion is against the WORLD — the registry, the
 * service store, real tool dispatch — not the tool's own summary line.
 */

describe('cross-mount provide/inject', () => {
  it('provider first: the consumer activates immediately and its tool reaches the provided service', async () => {
    const ctx = await setup()
    const provider = await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })
    expect(text(provider)).toContain('state: active')

    const consumer = await call(ctx, 'cordis_mount', { code: CONSUMER_CODE })
    expect(consumer.isError).toBe(false)
    expect(text(consumer)).toContain('state: active')

    // The vm-realm service value is callable across mounts, and the result
    // normalizes into the host realm like any dynamic tool result.
    const greeted = await call(ctx, 'greet', { name: 'harness' })
    expect(greeted.isError).toBe(false)
    expect(text(greeted)).toBe('hi harness')
  })

  it('consumer first: stays pending naming the missing service, then activates when the provider mounts', async () => {
    const ctx = await setup()
    const consumer = await call(ctx, 'cordis_mount', { code: CONSUMER_CODE })
    expect(consumer.isError).toBe(false)
    expect(text(consumer)).toContain('state: pending')
    expect(text(consumer)).toContain('waiting for service(s): greeter')
    expect(text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))).toContain('waiting for: greeter')
    expect(ctx.tools.get('greet')).toBeUndefined()

    await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })
    expect(ctx.tools.get('greet')).toBeDefined()
    expect(text(await call(ctx, 'greet', { name: 'late' }))).toBe('hi late')
  })

  it('unmounting the provider sends the consumer back to pending and unwinds its registrations', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })   // dyn-1
    await call(ctx, 'cordis_mount', { code: CONSUMER_CODE })   // dyn-2
    expect(ctx.tools.get('greet')).toBeDefined()

    const unmounted = await call(ctx, 'cordis_unmount', { id: 'dyn-1' })
    expect(unmounted.isError).toBe(false)
    expect(ctx.tools.get('greet')).toBeUndefined()
    const report = text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))
    expect(report).toContain('dyn-2: greeter-consumer [pending] — waiting for: greeter')
  })

  it('re-providing the service re-runs the consumer through the same guard (active again, tool back)', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })   // dyn-1
    await call(ctx, 'cordis_mount', { code: CONSUMER_CODE })   // dyn-2
    await call(ctx, 'cordis_unmount', { id: 'dyn-1' })
    expect(ctx.tools.get('greet')).toBeUndefined()

    await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })   // dyn-3
    expect(ctx.tools.get('greet')).toBeDefined()
    expect(text(await call(ctx, 'greet', { name: 'again' }))).toBe('hi again')
    expect(text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))).toContain('dyn-2: greeter-consumer [active]')
  })

  it('a duplicate provide fails loud with the owning fiber named, and the failed mount is disposed', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })
    const duplicate = await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })
    expect(duplicate.isError).toBe(true)
    expect(text(duplicate)).toContain('has been registered')
    const report = text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))
    expect(report).toContain('dyn-1: greeter-provider')
    expect(report).not.toContain('dyn-2')
  })

  it('inspect surfaces the linkage: provides on the provider row, the service in services and api sections', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })
    await call(ctx, 'cordis_mount', { code: CONSUMER_CODE })

    const dynamic = text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))
    expect(dynamic).toContain('dyn-1: greeter-provider [active] — provides: greeter')

    const services = text(await call(ctx, 'cordis_inspect', { what: 'services' }))
    expect(services).toContain('- greeter (provided by greeter-provider)')

    const api = text(await call(ctx, 'cordis_inspect', { what: 'api' }))
    expect(api).toContain('- greeter (provided by greeter-provider, no catalog entry)')
  })

  it('a primitive (or null) provided value passes through the façade unwrapped, on both read paths', async () => {
    const ctx = await setup()
    const provider = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'answer-provider',
          apply(ctx) {
            ctx.provide('answer', 42)
            ctx.provide('nothing', null)
          },
        }
      `,
    })
    expect(provider.isError).toBe(false)

    const consumer = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'answer-consumer',
          inject: ['answer', 'nothing', 'tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'answer',
              description: 'Read the provided primitive services.',
              parameters: {},
              ${CONTENT_OUTPUT_CODE}
              async execute() {
                return [{ type: 'text', text: ctx.answer + '/' + ctx.get('answer') + '/' + ctx.nothing }]
              },
            }))
          },
        }
      `,
    })
    expect(consumer.isError).toBe(false)
    expect(text(consumer)).toContain('state: active')
    expect(text(await call(ctx, 'answer', {}))).toBe('42/42/null')
  })

  it('unmounting the consumer leaves the provider and its service intact', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', { code: PROVIDER_CODE })   // dyn-1
    await call(ctx, 'cordis_mount', { code: CONSUMER_CODE })   // dyn-2
    await call(ctx, 'cordis_unmount', { id: 'dyn-2' })

    expect(ctx.tools.get('greet')).toBeUndefined()
    const services = text(await call(ctx, 'cordis_inspect', { what: 'services' }))
    expect(services).toContain('- greeter (provided by greeter-provider)')
    expect(text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))).toContain('dyn-1: greeter-provider [active]')
  })
})
