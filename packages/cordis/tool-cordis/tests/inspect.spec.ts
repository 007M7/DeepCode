import { describe, expect, it } from 'vitest'
import type { Context, Fiber } from 'cordis'
import { FiberState } from '../src/fiber-state.ts'
import { describeApi, describeEvents, describePlugins, describeServices } from '../src/inspect.ts'
import { call, LISTENER_CODE, setup, text } from './helpers.ts'

/**
 * The `cordis_inspect` sections: rendered against the real runtime through the
 * tool, plus direct renderer calls for the states a minimal harness cannot
 * reach (empty service store, same-named sibling fibers, a fully-live catalog).
 */

describe('cordis_inspect', () => {
  it('reports all six sections by default', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_inspect', {})
    expect(result.isError).toBe(false)
    const report = text(result)
    for (const heading of ['services', 'plugins', 'tools', 'dynamic', 'api', 'events']) {
      expect(report).toContain(`## ${heading}`)
    }
    // The services section sees the real providers; the plugins list shows
    // this plugin and its dynamic group flat; the tools section lists the
    // cordis tools.
    expect(report).toContain('- tools (provided by ToolRegistry)')
    expect(report).toContain('- tool-cordis [active]')
    expect(report).toContain('- cordis-dynamic [active]')
    expect(report).toContain('- cordis_mount')
    expect(report).toContain('(no dynamic plugins mounted)')
  })

  it('limits the report to one section via `what`', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_inspect', { what: 'tools' })
    const report = text(result)
    expect(report).toContain('## tools')
    expect(report).not.toContain('## services')
    expect(report).not.toContain('## plugins')
  })

  it('shows a mount in the dynamic section and in the flat plugins list', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', { code: LISTENER_CODE })
    const report = text(await call(ctx, 'cordis_inspect', {}))
    expect(report).toContain('- dyn-1: change-logger [active]')
    expect(report).toContain('- change-logger [active]')
  })

  it('renders the api section from the generated catalog intersected with the LIVE runtime', async () => {
    const ctx = await setup()
    const report = text(await call(ctx, 'cordis_inspect', { what: 'api' }))
    // Live catalogued services render summary + signatures.
    expect(report).toContain('- tools — ')
    expect(report).toContain('register(definition: ToolDefinition)')
    expect(report).toContain('- systemPrompt — ')
    // Catalogued services with no live provider are listed tersely.
    expect(report).toMatch(/not running \(loadable services with no live provider\): .*bash/)
    // The type shapes the LIVE signatures reference follow (closure over the
    // generated TYPE_API — a consumer can see field types, not just names).
    expect(report).toContain('type shapes (referenced by the signatures above')
    expect(report).toContain('export interface ToolExecution')
    // A type only reachable through a NOT-live service (e.g. bash) is scoped out.
    expect(report).not.toContain('export interface BashRunResult')
    // The inherited ctx surface closes the section.
    expect(report).toContain('inherited ctx API:')
    expect(report).toContain('- ctx.effect — ')
  })

  it('renders the events section with mode badges, signatures, and the waterfall caution', async () => {
    const ctx = await setup()
    const report = text(await call(ctx, 'cordis_inspect', { what: 'events' }))
    expect(report).toContain('- tools/change [emit]')
    expect(report).toContain('- tools/pre-execute [waterfall]')
    expect(report).toMatch(/'agent\/status'\(/)
    expect(report).toContain('returning without next() vetoes the chain')
  })
})

describe('inspect renderers (direct)', () => {
  it('describeServices reports an empty store as such, and labels a non-active provider', () => {
    const empty = { reflect: { store: {} } } as unknown as Context
    expect(describeServices(empty)).toEqual(['(no services provided)'])

    const pendingFiber = { state: FiberState.PENDING, name: 'half-loaded' } as unknown as Fiber
    const store: Record<symbol, unknown> = {}
    store[Symbol('impl')] = { name: 'thing', fiber: pendingFiber }
    const ctx = { reflect: { store } } as unknown as Context
    expect(describeServices(ctx)).toEqual(['- thing (provided by half-loaded, pending)'])
  })

  it('describePlugins lists every fiber flat, sorted by name, one line per instance', () => {
    const fiber = (name: string): Fiber => ({ name, state: FiberState.ACTIVE }) as unknown as Fiber
    const ctx = {
      registry: { values: () => [{ fibers: [fiber('beta'), fiber('alpha')] }, { fibers: [fiber('alpha')] }] },
    } as unknown as Context
    expect(describePlugins(ctx)).toEqual([
      '- alpha [active]',
      '- alpha [active]',
      '- beta [active]',
    ])
  })

  it('describeApi omits the not-running line and type shapes when nothing applies', async () => {
    const ctx = await setup()
    const lines = describeApi(ctx, [{ key: 'tools', summary: 'The registry.', methods: ['register(x): void'] }], [], [])
    expect(lines[0]).toBe('- tools — The registry.')
    expect(lines[1]).toBe('    register(x): void')
    expect(lines.join('\n')).not.toContain('not running')
    expect(lines.join('\n')).not.toContain('type shapes')
  })

  it('describeEvents renders an empty catalog as just the waterfall caution', () => {
    expect(describeEvents([])).toEqual([
      'waterfall listeners receive a trailing next() and MUST call it to delegate — returning without next() vetoes the chain.',
    ])
  })
})
