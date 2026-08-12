import { describe, expect, it } from 'vitest'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FiberState } from '../src/fiber-state.ts'
import {
  describeApi, describeClient, describeDynamic, describeEvents, describePlugins, describeServices,
} from '../src/inspect.ts'
import type { ClientSlotEntry } from '../src/client-catalog.ts'
import { call, defineAndRun, LISTENER_CODE, setup, text } from './helpers.ts'

/** A single seat the shipped composition already occupies. */
const SEAT: ClientSlotEntry = {
  key: 'demo.seat',
  kind: 'single',
  scope: 'root',
  summary: 'A seat.',
  doc: 'A seat.',
  registerOptions: [],
  ownerProps: [],
  ownerPropsReferences: [],
  standardProps: ['useSessions: Hook'],
  keyDomain: '',
  hookContext: '',
  slotInject: '',
  declaredBy: 'the runtime itself (built in; always present)',
  occupants: ['client-demo DemoSeat'],
  replaceRisk: 'shadows-shipped-ui',
  example: 'return {}',
  // A hypothetical package: naming a real one would tie this fixture to a
  // surface it does not describe, and the real catalog carries the pointer.
  source: 'a demo client package, slots.ts:1',
}

/** An empty list seat: the additive-with-no-occupant wording and the detail block. */
const LIST_SEAT: ClientSlotEntry = {
  ...SEAT,
  key: 'demo.list',
  kind: 'list',
  summary: 'A list.',
  doc: 'A list.',
  registerOptions: [{ name: 'id', requirement: 'required', type: 'string', doc: 'Your cell key.' }],
  declaredBy: "an entry in 'demo.parent' (client-demo), so it exists while that entry is mounted",
  occupants: [],
  replaceRisk: 'none',
  example: "ctx.slots.register({ name: 'demo.list', id: 'mine' }, C)",
}

/** An occupied list seat: additive, but the report still names who is already there. */
const LIST_SEAT_OCCUPIED: ClientSlotEntry = {
  ...LIST_SEAT,
  key: 'demo.list.busy',
  occupants: ["client-demo DemoRow id 'shipped'"],
}

/** A keyed seat carrying every optional field, so each one's presence branch renders. */
const KEYED_SEAT: ClientSlotEntry = {
  ...SEAT,
  key: 'demo.keyed',
  kind: 'keyed',
  summary: 'A keyed seat.',
  doc: 'A keyed seat.',
  registerOptions: [{ name: 'key', requirement: 'required', type: 'string', doc: 'Your cell key.' }],
  ownerProps: ['export interface KeyedOwnerProps {\n  block: ToolCallBlock\n}'],
  ownerPropsReferences: ['ToolCallBlock'],
  keyDomain: 'open: any string the owner dispatches, already taken: bash',
  hookContext: 'ChatNodeContext',
  slotInject: 'ChatNodeInjected',
  occupants: ["client-demo DemoView key 'bash'"],
  replaceRisk: 'shadows-shipped-ui',
}

/**
 * The `cordis_runtime_inspect` sections: rendered against the real runtime through the
 * tool, plus direct renderer calls for the states a minimal harness cannot
 * reach (empty service store, same-named sibling fibers, a fully-live catalog).
 */

describe('cordis_runtime_inspect', () => {
  it('reports all seven sections by default', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_runtime_inspect', {})
    expect(result.isError).toBe(false)
    const report = text(result)
    if (result.isError) throw new Error('expected cordis_runtime_inspect success')
    expect(result.value).toBe(report)
    for (const heading of ['services', 'plugins', 'tools', 'Dynamic Packages', 'api', 'events', 'client']) {
      expect(report).toContain(`## ${heading}`)
    }
    // The services section sees the real providers; the plugins list shows
    // this plugin and its dynamic group flat; the tools section lists the
    // cordis tools.
    expect(report).toContain('- tools (provided by ToolRegistry)')
    expect(report).toContain('- tool-cordis [active]')
    expect(report).toContain('- cordis_define')
    expect(report).toContain('No dynamic packages are defined in this session.')
  })

  it('limits the report to one section via `what`', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_runtime_inspect', { what: 'tools' })
    const report = text(result)
    expect(report).toContain('## tools')
    expect(report).not.toContain('## services')
    expect(report).not.toContain('## plugins')
  })

  it('shows a running dynamic package in its exact section and in the flat plugins list', async () => {
    const ctx = await setup()
    await defineAndRun(ctx, LISTENER_CODE, 'logger')
    const report = text(await call(ctx, 'cordis_runtime_inspect', {}))
    expect(report).toContain('## Dynamic Packages')
    expect(report).toContain('- dyn-1: logger [running, rev 1] (host) — spec fixture; provides: none; waiting for: none')
    // The group fiber and the package's own plugin are both live in the flat list.
    expect(report).toContain('- cordis-dynamic [active]')
    expect(report).toContain('- change-logger [active]')
  })

  it('shows a defined-but-not-running package, and the invoke methods a running one registered', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_define', { name: 'idle', purpose: 'waits to be started', code: 'return () => {}' })
    await defineAndRun(ctx, 'harness.handle(\'ping\', async () => \'pong\')\nreturn () => {}', 'handler')

    const report = text(await call(ctx, 'cordis_runtime_inspect', { what: 'temporary' }))

    expect(report).toContain('- dyn-1: idle [defined, not running] (host) — waits to be started')
    expect(report).toContain('host methods: ping')
  })

  it('renders the api section from the generated catalog intersected with the LIVE runtime', async () => {
    const ctx = await setup()
    const report = text(await call(ctx, 'cordis_runtime_inspect', { what: 'api' }))
    // Live catalogued services render summary + signatures.
    expect(report).toContain('- tools — Tool registry and execution pipeline.')
    expect(report).toContain('register(definition: ToolDefinition)')
    // The projection carries public METHODS only: state and symbol-keyed seams
    // between plugins are not calls a package can make.
    expect(report).not.toContain('store: Map<string, ToolDefinition>')
    expect(report).not.toContain('TOOL_REGISTRY_SCHEDULER')
    // Catalogued services with no live provider are listed tersely.
    expect(report).toMatch(/not running \(loadable services with no live provider\): .*bash/)
    // The type shapes the LIVE signatures reference follow, so a consumer can see
    // field types rather than only names.
    expect(report).toContain('type shapes (referenced by the signatures above')
    expect(report).toContain('export interface ToolDefinition')
    // A type only reachable through a NOT-live service (e.g. bash) is scoped out.
    expect(report).not.toContain('export interface BashRunResult')
    // The inherited ctx API closes the section.
    expect(report).toContain('inherited ctx API:')
    expect(report).toContain('- ctx.effect — ')
    // The broad report stays compact; exact-name lookup owns full JSDoc.
    expect(report).not.toContain('/**')
    expect(report).not.toContain('@param definition')
  })

  it('adds original method JSDoc only for an exact live api name', async () => {
    const ctx = await setup()
    const report = text(await call(ctx, 'cordis_runtime_inspect', { what: 'api', name: 'tools' }))
    expect(report).toContain('## api')
    expect(report).toContain('- tools — Tool registry and execution pipeline.')
    expect(report).toContain('/**')
    expect(report).toContain('Register globally or in the calling agent scope.')
    expect(report).toContain('@param definition - tool schema, execution, and optional')
    expect(report).toContain('@returns the exact disposer that unregisters the tool.')
    expect(report).toContain('register(definition: ToolDefinition)')
    expect(report).toContain('type shapes (referenced by the signatures above')
    expect(report).not.toContain('not running (loadable services')
    expect(report).not.toContain('inherited ctx API:')
  })

  it('renders the events section with mode badges, signatures, and the waterfall caution', async () => {
    const ctx = await setup()
    const report = text(await call(ctx, 'cordis_runtime_inspect', { what: 'events' }))
    expect(report).toContain('- tools/change [emit]')
    expect(report).toContain('- tools/pre-execute [waterfall]')
    expect(report).toMatch(/'tools\/change'\(/)
    expect(report).toContain('returning without next() short-circuits the chain')
    expect(report).not.toContain('/**')
    expect(report).not.toContain('@mode waterfall')
  })

  it('adds original event JSDoc only for an exact event name', async () => {
    const ctx = await setup()
    const report = text(await call(ctx, 'cordis_runtime_inspect', { what: 'events', name: 'tools/pre-execute' }))
    expect(report).toContain('## events')
    expect(report).toContain('- tools/pre-execute [waterfall]')
    expect(report).toContain('/**')
    expect(report).toContain('Allow, deny, or ask before dispatch.')
    expect(report).toContain('@param exec - the pending call')
    expect(report).toContain('@mode waterfall')
    expect(report).not.toContain('- tools/change [emit]')
  })

  it('fails loud for incompatible, unknown, and non-running names', async () => {
    const ctx = await setup()
    const incompatible = await call(ctx, 'cordis_runtime_inspect', { what: 'tools', name: 'tools' })
    expect(incompatible.isError).toBe(true)
    expect(text(incompatible)).toContain('name is valid only with what:"api", what:"events", or what:"client"')

    const unknownService = await call(ctx, 'cordis_runtime_inspect', { what: 'api', name: 'not-a-service' })
    expect(unknownService.isError).toBe(true)
    expect(text(unknownService)).toContain('no catalogued service named "not-a-service"')

    const nonRunning = await call(ctx, 'cordis_runtime_inspect', { what: 'api', name: 'bash' })
    expect(nonRunning.isError).toBe(true)
    expect(text(nonRunning)).toContain('catalogued service "bash" is not running')

    const unknownEvent = await call(ctx, 'cordis_runtime_inspect', { what: 'events', name: 'not/an-event' })
    expect(unknownEvent.isError).toBe(true)
    expect(text(unknownEvent)).toContain('no catalogued event named "not/an-event"')
  })
})

describe('inspect renderers (direct)', () => {
  it('describeServices reports an empty store as such, and labels a non-active provider', () => {
    const empty = { reflect: { store: {} } } as unknown as Context
    expect(describeServices(empty, [])).toEqual(['(no services provided)'])

    const pendingFiber = { state: FiberState.PENDING, name: 'half-loaded' } as unknown as Fiber
    const store: Record<symbol, unknown> = {}
    store[Symbol('impl')] = { name: 'thing', fiber: pendingFiber }
    const ctx = { reflect: { store } } as unknown as Context
    const lines = describeServices(ctx, [])
    // A service the catalog does not cover still appears, with its owner and the
    // non-active lifecycle label; only the summary is missing.
    expect(lines).toEqual(['- thing (provided by half-loaded, pending)'])
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
    const lines = describeApi(ctx, [{
      key: 'tools',
      summary: 'The registry.',
      description: 'The registry.',
      methods: [{
        signature: 'register(x): void',
        description: 'Register x.',
        parameters: [{ name: 'x', description: 'Value to register.' }],
      }],
    }], undefined, [], [])
    expect(lines[0]).toBe('- tools — The registry.')
    expect(lines[1]).toBe('    register(x): void')
    expect(lines.join('\n')).not.toContain('not running')
    expect(lines.join('\n')).not.toContain('type shapes')
  })

  it('expands the shapes a service names transitively, listing each one once', async () => {
    const ctx = await setup()
    const lines = describeApi(ctx, [{
      key: 'tools',
      summary: 'The registry.',
      description: 'The registry.',
      methods: [{
        signature: 'register(definition: ToolDefinition): void',
        description: '',
        parameters: [],
      }],
    }], 'tools', [], [
      { name: 'ToolDefinition', declaration: 'export interface ToolDefinition {\n  schema: ToolSchema\n}' },
      { name: 'ToolSchema', declaration: 'export interface ToolSchema {\n  owner: ToolDefinition\n}' },
    ]).join('\n')
    // The signature names one shape, that shape names the second, and the two
    // reference each other back: a reader gets both, each exactly once.
    expect(lines.match(/export interface ToolDefinition/g)).toHaveLength(1)
    expect(lines.match(/export interface ToolSchema/g)).toHaveLength(1)
  })

  it('describeEvents renders an empty catalog as just the waterfall caution', () => {
    expect(describeEvents([])).toEqual([
      'waterfall listeners receive a trailing next() and MUST call it to delegate — returning without next() short-circuits the chain.',
    ])
  })

  it('describeApi reports a live service with no catalogued signature as still injectable', async () => {
    const ctx = await setup()
    const lines = describeApi(ctx, []).join('\n')
    // The framework tier is exactly this case: reachable through inject, but
    // with no projected signature — the report must not read as "absent".
    expect(lines).toContain('running, but this catalog has no signature for it')
    expect(lines).toContain('still reaches it')
  })

  it('describeClient lists every seat with what registering there costs', () => {
    const lines = describeClient([SEAT, LIST_SEAT, LIST_SEAT_OCCUPIED], ['one rule']).join('\n')
    expect(lines).toContain('- demo.seat [single, root] — A seat.')
    expect(lines).toContain('OCCUPIED — registering here REPLACES: client-demo DemoSeat')
    expect(lines).toContain('- demo.list [list, root]')
    expect(lines).toContain('additive (no shipped entries)')
    // Additive does not mean empty: an id already in use is still a takeover.
    expect(lines).toContain("additive (beside: client-demo DemoRow id 'shipped')")
    expect(lines).toContain('- one rule')
    // The compact listing must not spend context on per-seat detail.
    expect(lines).not.toContain('register options besides name:')
    expect(lines).not.toContain('framework props for this scope:')
  })

  it('describeClient expands the optional contract fields only where a seat has them', () => {
    const keyed = describeClient([KEYED_SEAT], [], 'demo.keyed').join('\n')
    expect(keyed).toContain('key domain: open: any string the owner dispatches, already taken: bash')
    expect(keyed).toContain('owner props (the shapes the owner passes down):')
    // Owner props expand one level; referenced shapes are named, not inlined.
    expect(keyed).toContain('shapes those fields reference, not expanded here: ToolCallBlock')
    expect(keyed).toContain('slot-level inject face every entry receives: ChatNodeInjected')
    expect(keyed).toContain('per-render-site hook context: ChatNodeContext')
    expect(keyed).toContain('key (required, string)')

    // A seat without them says nothing about them.
    const plain = describeClient([SEAT], [], 'demo.seat').join('\n')
    expect(plain).toContain('owner props: none')
    expect(plain).toContain('register options besides name: none')
    expect(plain).not.toContain('key domain:')
    expect(plain).not.toContain('slot-level inject face')
    expect(plain).not.toContain('per-render-site hook context')
    expect(plain).not.toContain('shapes those fields reference')
  })

  it('describeClient expands one seat into its full register contract', () => {
    const lines = describeClient([SEAT, LIST_SEAT], ['one rule'], 'demo.list').join('\n')
    expect(lines).toContain('exists: an entry in \'demo.parent\'')
    expect(lines).toContain('id (required, string) — Your cell key.')
    expect(lines).toContain('owner props: none')
    expect(lines).toContain('useSessions: Hook')
    expect(lines).toContain('minimal browser half:')
    expect(lines).toContain('ctx.slots.register(')
    // A narrowed report is one seat only, and carries no cross-cutting rules.
    expect(lines).not.toContain('demo.seat')
    expect(lines).not.toContain('one rule')
  })

  it('describeDynamic tells the model whether a failed browser half is still on the page', () => {
    const row = (abdicated: boolean): unknown => ({
      id: 'dyn-1',
      name: 'panel',
      purpose: 'ui',
      hasHostHalf: false,
      hasClientHalf: true,
      run: { rev: 1, handlers: [] },
      renderFailure: { slot: 'settings.section', message: 'useX is not a function', abdicated },
    })
    const ctxFor = (abdicated: boolean): Context => ({
      dynamicCordisRunner: { snapshot: () => [row(abdicated)] },
      reflect: { store: {} },
      get: () => undefined,
    } as unknown as Context)

    const gone = describeDynamic(ctxFor(true), {} as unknown as Agent).join('\n')
    expect(gone).toContain('BROWSER HALF FAILED TO RENDER at slot settings.section: useX is not a function')
    // The two states differ in the one fact the author needs: is my UI there?
    expect(gone).toContain('that seat was handed back to the shipped UI')
    const kept = describeDynamic(ctxFor(false), {} as unknown as Agent).join('\n')
    expect(kept).toContain('that seat is still yours, so what the page shows may be incomplete')
  })

  it('describeClient names the shipped neighbours when an occupied list seat is expanded', () => {
    const lines = describeClient([LIST_SEAT_OCCUPIED], [], 'demo.list.busy').join('\n')
    expect(lines).toContain("additive (beside: client-demo DemoRow id 'shipped')")
  })

  it('describeDynamic renders a browser-only row, a half-loaded host half, and a fiberless run', () => {
    // Rows a host-only harness cannot produce: the runner's own shapes are the
    // contract this renderer reads, so they are supplied directly.
    const pending = { state: FiberState.PENDING, name: 'half-loaded', inject: {} } as unknown as Fiber
    const rows = [
      { id: 'dyn-1', name: 'browser only', purpose: 'ui', hasHostHalf: false, hasClientHalf: true },
      { id: 'dyn-2', name: 'no fiber', purpose: 'client half only', hasHostHalf: false, hasClientHalf: true, run: { rev: 1, handlers: [] } },
      { id: 'dyn-3', name: 'waiting', purpose: 'both halves', hasHostHalf: true, hasClientHalf: true, run: { rev: 2, fiber: pending, handlers: ['ping'] } },
    ]
    const ctx = {
      dynamicCordisRunner: { snapshot: () => rows },
      reflect: { store: {} },
      get: () => undefined,
    } as unknown as Context
    // No agent means no definition space to report, not an empty registry.
    expect(describeDynamic(ctx)).toEqual([
      'No dynamic packages are defined in this session. Definitions live only in this process\'s memory, so a DSH restart clears them.',
    ])
    const lines = describeDynamic(ctx, {} as unknown as Agent)
    expect(lines[0]).toBe('- dyn-1: browser only [defined, not running] (browser) — ui')
    expect(lines[1]).toBe('- dyn-2: no fiber [running, rev 1] (browser) — client half only; provides: none; waiting for: none')
    expect(lines[2]).toBe('- dyn-3: waiting [pending, rev 2] (host+browser) — both halves; provides: none; waiting for: none; host methods: ping')
  })

  it('describeClient refuses an unknown slot key instead of answering emptily', () => {
    expect(() => describeClient([SEAT], [], 'nope.seat')).toThrow('no catalogued client slot named "nope.seat"')
  })
})
