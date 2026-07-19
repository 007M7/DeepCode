import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from 'cordis'
import InvariantService, {
  InvariantError,
  assertInvariant,
  observePluginInvariant,
  observeServiceInvariant,
  serviceShapeViolation,
  type Config,
  type InvariantInstaller,
  type PluginInvariantContract,
} from '@deepseek-ai/dsh-invariants'

declare module 'cordis' {
  interface Context {
    invariantProbe: InvariantProbeService
    watchedInvariantProbe: WatchedInvariantProbeService
  }

  interface Events {
    'invariants-test/ping'(): void
  }
}

class InvariantProbeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'invariantProbe')
  }
}

class WatchedInvariantProbeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'watchedInvariantProbe')
  }
}

interface RuntimeRegistration extends PromiseLike<() => void> {
  (): void | Promise<void>
}

interface InstalledRegistration {
  dispose(): Promise<void>
}

function runtimeRegistration(registration: () => void): RuntimeRegistration {
  return registration as RuntimeRegistration
}

async function setup(config: Config = {}): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(InvariantService, config)
  return { ctx, fiber }
}

async function registerProbe(
  ctx: Context,
  packageName: string,
  probe: () => void,
): Promise<InstalledRegistration> {
  const registration = runtimeRegistration(ctx.invariants.register(packageName, (child) => {
    child.on('invariants-test/ping', probe, { global: true })
  }))
  await registration
  return {
    async dispose() { await registration() },
  }
}

describe('InvariantService selection', () => {
  it('applies defaults when constructed directly without schema normalization', async () => {
    const ctx = new Context()
    const service = new InvariantService(ctx)
    const probe = vi.fn()
    const registration = runtimeRegistration(service.register('@deepseek-ai/dsh-session', (child) => {
      child.on('invariants-test/ping', probe, { global: true })
    }))
    await registration
    ctx.emit('invariants-test/ping')
    expect(probe).toHaveBeenCalledOnce()
    await registration()
  })

  it('enables registrations by default and treats empty lists as admit-all and exclude-none', async () => {
    for (const config of [{}, { package_allowlist: [], package_blocklist: [] }]) {
      const { ctx } = await setup(config)
      const probe = vi.fn()
      await registerProbe(ctx, '@deepseek-ai/dsh-session', probe)
      ctx.emit('invariants-test/ping')
      expect(probe).toHaveBeenCalledOnce()
    }
  })

  it('disables every installer while still reserving package ownership', async () => {
    const { ctx } = await setup({ enabled: false })
    const probe = vi.fn()
    const registration = await registerProbe(ctx, '@deepseek-ai/dsh-session', probe)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-session', () => {}))
      .toThrow(/already registered/)
    ctx.emit('invariants-test/ping')
    expect(probe).not.toHaveBeenCalled()
    await registration.dispose()
  })

  it('uses unanchored, case-sensitive JavaScript regex sources', async () => {
    const unanchored = await setup({ package_allowlist: ['session'] })
    const unanchoredProbe = vi.fn()
    await registerProbe(unanchored.ctx, '@deepseek-ai/dsh-session-extra', unanchoredProbe)
    unanchored.ctx.emit('invariants-test/ping')
    expect(unanchoredProbe).toHaveBeenCalledOnce()

    const anchored = await setup({ package_allowlist: ['^@deepseek-ai/dsh-session$'] })
    const anchoredProbe = vi.fn()
    await registerProbe(anchored.ctx, '@deepseek-ai/dsh-session-extra', anchoredProbe)
    anchored.ctx.emit('invariants-test/ping')
    expect(anchoredProbe).not.toHaveBeenCalled()

    const caseSensitive = await setup({ package_allowlist: ['Session'] })
    const caseProbe = vi.fn()
    await registerProbe(caseSensitive.ctx, '@deepseek-ai/dsh-session', caseProbe)
    caseSensitive.ctx.emit('invariants-test/ping')
    expect(caseProbe).not.toHaveBeenCalled()
  })

  it('lets the blocklist override an allowlist match', async () => {
    const { ctx } = await setup({
      package_allowlist: ['^@deepseek-ai/dsh-'],
      package_blocklist: ['session'],
    })
    const sessionProbe = vi.fn()
    const agentProbe = vi.fn()
    await registerProbe(ctx, '@deepseek-ai/dsh-session', sessionProbe)
    await registerProbe(ctx, '@deepseek-ai/dsh-agent', agentProbe)
    ctx.emit('invariants-test/ping')
    expect(sessionProbe).not.toHaveBeenCalled()
    expect(agentProbe).toHaveBeenCalledOnce()
  })

  it('accepts zero-match patterns for packages registered later', async () => {
    const { ctx } = await setup({ package_allowlist: ['^@later/invariants$'] })
    const now = vi.fn()
    const later = vi.fn()
    await registerProbe(ctx, '@deepseek-ai/dsh-session', now)
    await registerProbe(ctx, '@later/invariants', later)
    ctx.emit('invariants-test/ping')
    expect(now).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledOnce()
  })

  it('allows the same source in both lists and applies blocklist precedence', async () => {
    const { ctx } = await setup({ package_allowlist: ['agent'], package_blocklist: ['agent'] })
    const probe = vi.fn()
    await registerProbe(ctx, '@deepseek-ai/dsh-agent', probe)
    ctx.emit('invariants-test/ping')
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('InvariantService validation', () => {
  it.each([
    [{ package_allowlist: [''] }, /non-blank/],
    [{ package_allowlist: [' '] }, /non-blank/],
    [{ package_allowlist: [' session'] }, /surrounding whitespace/],
    [{ package_blocklist: ['session '] }, /surrounding whitespace/],
    [{ package_allowlist: ['session', 'session'] }, /duplicate regex/],
    [{ package_blocklist: ['agent', 'agent'] }, /duplicate regex/],
    [{ package_allowlist: ['['] }, /invalid regex/],
    [{ package_blocklist: ['('] }, /invalid regex/],
  ])('rejects malformed filter config %#', async (config, message) => {
    await expect((async () => {
      const ctx = new Context()
      await ctx.plugin(InvariantService, config)
    })()).rejects.toThrow(message)
  })

  it.each(['', ' ', ' package', 'pack age', 'package\n'])('rejects malformed package name %j', async (packageName) => {
    const { ctx } = await setup()
    expect(() => ctx.invariants.register(packageName, () => {})).toThrow(/packageName/)
  })
})

describe('InvariantService lifecycle', () => {
  it('honors the installer dependency surface in its child fiber', async () => {
    const { ctx } = await setup()
    await ctx.plugin(InvariantProbeService)
    let registration!: RuntimeRegistration
    await ctx.plugin({
      inject: ['invariants', 'invariantProbe'],
      apply(child: Context) {
        const installer = Object.assign((installerCtx: Context) => {
          expect(Object.keys(installerCtx.fiber.inject)).toContain('invariantProbe')
          expect(Object.keys(installerCtx.fiber.store ?? {})).toContain('invariantProbe')
          expect(installerCtx.invariantProbe).toBeInstanceOf(InvariantProbeService)
        }, { inject: ['invariantProbe'] })
        expect(installer.inject).toEqual(['invariantProbe'])
        registration = runtimeRegistration(child.invariants.register('@deepseek-ai/dsh-probe', installer))
        return Promise.resolve(registration)
      },
    })
    await registration
  })

  it('attributes failures to the registering package with the stable code', async () => {
    const { ctx } = await setup()
    const registration = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-session', (child, fail) => {
      child.on('invariants-test/ping', () => fail('seq must strictly increase'), { global: true })
    }))
    await registration
    let caught: unknown
    try {
      ctx.emit('invariants-test/ping')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvariantError)
    expect(caught).toMatchObject({
      name: 'InvariantError',
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session',
      message: 'invariant violated by "@deepseek-ai/dsh-session": seq must strictly increase',
    })
  })

  it('disposes the child fiber completely and permits HMR re-registration', async () => {
    const { ctx } = await setup()
    const first = vi.fn()
    const firstRegistration = await registerProbe(ctx, '@deepseek-ai/dsh-session', first)
    ctx.emit('invariants-test/ping')
    await firstRegistration.dispose()
    ctx.emit('invariants-test/ping')
    expect(first).toHaveBeenCalledOnce()

    const second = vi.fn()
    await registerProbe(ctx, '@deepseek-ai/dsh-session', second)
    ctx.emit('invariants-test/ping')
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('reserves ownership until asynchronous child disposal completes', async () => {
    const { ctx } = await setup()
    let finishDisposal!: () => void
    const disposalBarrier = new Promise<void>((resolve) => { finishDisposal = resolve })
    const registration = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-session', (child) => {
      child.effect(() => async () => { await disposalBarrier })
    }))
    await registration

    const disposing = registration()
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-session', () => {}))
      .toThrow(/already registered/)
    finishDisposal()
    await disposing

    const replacement = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-session', () => {}))
    await replacement
    await replacement()
  })

  it('rolls back listeners and ownership atomically when an installer fails', async () => {
    const { ctx } = await setup()
    const leaked = vi.fn()
    const failed = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-session', (child) => {
      child.on('invariants-test/ping', leaked, { global: true })
      throw new Error('installer failed')
    }))
    await expect(Promise.resolve(failed)).rejects.toThrow('installer failed')
    ctx.emit('invariants-test/ping')
    expect(leaked).not.toHaveBeenCalled()

    const retry = vi.fn()
    await registerProbe(ctx, '@deepseek-ai/dsh-session', retry)
    ctx.emit('invariants-test/ping')
    expect(retry).toHaveBeenCalledOnce()
  })

  it('joins asynchronous checks and rolls back their effects on failure', async () => {
    const { ctx } = await setup()
    const leaked = vi.fn()
    const failed = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-async-probe', async (child, fail) => {
      child.on('invariants-test/ping', leaked, { global: true })
      await Promise.resolve()
      fail('asynchronous check failed')
    }))
    await expect(Promise.resolve(failed)).rejects.toThrow(/asynchronous check failed/)
    ctx.emit('invariants-test/ping')
    expect(leaked).not.toHaveBeenCalled()

    const retry = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-async-probe', async () => {
      await Promise.resolve()
    }))
    await retry
    await retry()
  })

  it('releases a synchronous reservation if the service fiber is already inactive', async () => {
    const { ctx, fiber } = await setup()
    const service = ctx.invariants
    await fiber.dispose()
    expect(() => service.register('@deepseek-ai/dsh-session', () => {})).toThrow(/inactive/i)
  })
})

describe('package-owned invariant helpers', () => {
  interface InvariantDisposer {
    (): void | Promise<void>
  }

  async function registerInstaller(
    ctx: Context,
    packageName: string,
    installer: InvariantInstaller,
  ): Promise<InvariantDisposer> {
    const registration = runtimeRegistration(ctx.invariants.register(packageName, installer))
    const dispose = await Promise.resolve(registration)
    return dispose
  }

  function effectPlugin(options: {
    name?: string
    inject?: string[]
    effect?: string
    service?: string
  } = {}) {
    return {
      name: options.name ?? 'effect-probe',
      inject: options.inject ?? [],
      apply(ctx: Context) {
        if (options.service !== undefined) ctx.provide(options.service, {})
        if (options.effect !== undefined) {
          ctx.effect(() => {
            ctx.effect(() => () => {}, `${options.effect}.child`)
            return () => {}
          }, options.effect)
        }
      },
    }
  }

  async function expectPluginViolation(
    contract: PluginInvariantContract,
    plugin: ReturnType<typeof effectPlugin>,
    message: RegExp,
  ): Promise<void> {
    const { ctx } = await setup()
    await registerInstaller(ctx, `@deepseek-ai/${contract.name}`, (child, fail) => {
      observePluginInvariant(child, fail, contract)
    })
    await expect(Promise.resolve(ctx.plugin(plugin))).rejects.toThrow(message)
  }

  it('checks existing and later plugin fibers, including nested effects and alternatives', async () => {
    const { ctx } = await setup()
    await ctx.plugin(InvariantProbeService)
    const plugin = effectPlugin({
      inject: ['invariantProbe'],
      effect: 'probe.effect',
      service: 'pluginProbe',
    })
    await ctx.plugin(plugin)
    const validated = vi.fn(() => undefined)
    await registerInstaller(ctx, '@deepseek-ai/dsh-existing-probe', (child, fail) => {
      observePluginInvariant(child, fail, {
        plugin,
        name: 'effect-probe',
        inject: ['invariantProbe'],
        effects: [['missing.effect', 'probe.effect.child']],
        services: ['pluginProbe'],
        validate: validated,
      })
    })
    expect(validated).toHaveBeenCalledOnce()

    const later = effectPlugin({ name: 'later-probe', effect: 'later.effect' })
    await registerInstaller(ctx, '@deepseek-ai/dsh-later-probe', (child, fail) => {
      observePluginInvariant(child, fail, {
        plugin: later,
        name: 'later-probe',
        effects: ['later.effect'],
      })
    })
    await ctx.plugin(later)
  })

  it('matches package plugins by Cordis name without importing their callback', async () => {
    const { ctx } = await setup()
    const plugin = {
      name: 'name-only-probe',
      apply(pluginCtx: Context) {
        pluginCtx.effect(() => () => {}, 'name-only.effect')
        pluginCtx.inject([], () => {})
      },
    }
    await registerInstaller(ctx, '@deepseek-ai/dsh-name-only-probe', (child, fail) => {
      observePluginInvariant(child, fail, {
        name: 'name-only-probe',
        effects: ['name-only.effect'],
      })
    })
    await ctx.plugin(plugin)
  })

  it('multiplexes same-runtime plugin checks through one root listener pair and disposes each owner', async () => {
    const { ctx } = await setup()
    const firstValidation = vi.fn(() => undefined)
    const secondValidation = vi.fn(() => undefined)
    const first = await registerInstaller(ctx, '@deepseek-ai/dsh-shared-plugin-first', (child, fail) => {
      observePluginInvariant(child, fail, { name: 'shared-plugin-probe', validate: firstValidation })
    })
    const second = await registerInstaller(ctx, '@deepseek-ai/dsh-shared-plugin-second', (child, fail) => {
      observePluginInvariant(child, fail, { name: 'shared-plugin-probe', validate: secondValidation })
    })
    const rootEffectLabels = ctx.fiber.getEffects().map(effect => effect.label)
    expect(rootEffectLabels.filter(label => label === 'ctx.on("internal/plugin")')).toHaveLength(1)
    expect(rootEffectLabels.filter(label => label === 'ctx.on("internal/status")')).toHaveLength(1)

    const plugin = effectPlugin({ name: 'shared-plugin-probe' })
    const firstFiber = await ctx.plugin(plugin)
    expect(firstValidation).toHaveBeenCalledOnce()
    expect(secondValidation).toHaveBeenCalledOnce()

    await first()
    await firstFiber.dispose()
    const secondFiber = await ctx.plugin(plugin)
    expect(firstValidation).toHaveBeenCalledOnce()
    expect(secondValidation).toHaveBeenCalledTimes(2)

    await second()
    await secondFiber.dispose()
    await ctx.plugin(plugin)
    expect(firstValidation).toHaveBeenCalledOnce()
    expect(secondValidation).toHaveBeenCalledTimes(2)
  })

  it('rejects a contract that does not identify a plugin', async () => {
    const { ctx } = await setup()
    const registration = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-invalid-plugin', (child, fail) => {
      observePluginInvariant(child, fail, {
        plugin: {} as never,
        name: 'invalid-plugin',
      })
    }))
    await expect(Promise.resolve(registration)).rejects.toThrow(/does not identify a Cordis plugin/)
  })

  it('rejects wrong plugin names, missing injections, effects, services, and custom checks', async () => {
    const wrongName = effectPlugin({ name: 'actual-name', effect: 'probe.effect' })
    await expectPluginViolation({
      plugin: wrongName,
      name: 'expected-name',
    }, wrongName, /plugin name must be "expected-name"/)

    const missingInjection = effectPlugin({ effect: 'probe.effect' })
    await expectPluginViolation({
      plugin: missingInjection,
      name: 'effect-probe',
      inject: ['missingService'],
    }, missingInjection, /must inject "missingService"/)

    const missingEffect = effectPlugin()
    await expectPluginViolation({
      plugin: missingEffect,
      name: 'effect-probe',
      effects: [['first.effect', 'second.effect']],
    }, missingEffect, /must own effect "first.effect" or "second.effect"/)

    const missingService = effectPlugin({ effect: 'probe.effect' })
    await expectPluginViolation({
      plugin: missingService,
      name: 'effect-probe',
      services: ['missingService'],
    }, missingService, /must provide service "missingService"/)

    const invalidCustom = effectPlugin({ effect: 'probe.effect' })
    await expectPluginViolation({
      plugin: invalidCustom,
      name: 'effect-probe',
      validate: () => 'custom plugin contract failed',
    }, invalidCustom, /custom plugin contract failed/)
  })

  it('checks existing and future service implementations while ignoring unrelated changes', async () => {
    const existing = await setup()
    await existing.ctx.plugin(WatchedInvariantProbeService)
    await registerInstaller(existing.ctx, '@deepseek-ai/dsh-existing-service', (child, fail) => {
      observeServiceInvariant(child, fail, 'watchedInvariantProbe', value => (
        value instanceof WatchedInvariantProbeService ? undefined : 'wrong watched service'
      ))
    })

    const future = await setup()
    await registerInstaller(future.ctx, '@deepseek-ai/dsh-future-service', (child, fail) => {
      observeServiceInvariant(child, fail, 'watchedInvariantProbe', value => (
        value instanceof WatchedInvariantProbeService ? undefined : 'wrong watched service'
      ))
    })
    await future.ctx.plugin(InvariantProbeService)
    await future.ctx.plugin(WatchedInvariantProbeService)

    const invalid = await setup()
    await registerInstaller(invalid.ctx, '@deepseek-ai/dsh-invalid-service', (child, fail) => {
      observeServiceInvariant(child, fail, 'watchedInvariantProbe', () => 'wrong watched service')
    })
    await expect(Promise.resolve(invalid.ctx.plugin(WatchedInvariantProbeService)))
      .rejects.toThrow(/wrong watched service/)
  })

  it('multiplexes same-name service checks through one root listener and disposes each owner', async () => {
    const { ctx } = await setup()
    const firstValidation = vi.fn(() => undefined)
    const secondValidation = vi.fn(() => undefined)
    const first = await registerInstaller(ctx, '@deepseek-ai/dsh-shared-service-first', (child, fail) => {
      observeServiceInvariant(child, fail, 'watchedInvariantProbe', firstValidation)
    })
    const second = await registerInstaller(ctx, '@deepseek-ai/dsh-shared-service-second', (child, fail) => {
      observeServiceInvariant(child, fail, 'watchedInvariantProbe', secondValidation)
    })
    const rootEffectLabels = ctx.fiber.getEffects().map(effect => effect.label)
    expect(rootEffectLabels.filter(label => label === 'ctx.on("internal/service")')).toHaveLength(1)

    const firstFiber = await ctx.plugin(WatchedInvariantProbeService)
    expect(firstValidation).toHaveBeenCalledOnce()
    expect(secondValidation).toHaveBeenCalledOnce()

    await first()
    const firstCallsAfterDisposal = firstValidation.mock.calls.length
    const secondCallsBeforeRemount = secondValidation.mock.calls.length
    await firstFiber.dispose()
    const secondFiber = await ctx.plugin(WatchedInvariantProbeService)
    expect(firstValidation).toHaveBeenCalledTimes(firstCallsAfterDisposal)
    expect(secondValidation.mock.calls.length).toBeGreaterThan(secondCallsBeforeRemount)

    await second()
    const firstCallsAfterBothDisposals = firstValidation.mock.calls.length
    const secondCallsAfterBothDisposals = secondValidation.mock.calls.length
    await secondFiber.dispose()
    await ctx.plugin(WatchedInvariantProbeService)
    expect(firstValidation).toHaveBeenCalledTimes(firstCallsAfterBothDisposals)
    expect(secondValidation).toHaveBeenCalledTimes(secondCallsAfterBothDisposals)
  })

  it('reports synchronous package assertions through the bound failure reporter', async () => {
    const { ctx } = await setup()
    const valid = await registerInstaller(ctx, '@deepseek-ai/dsh-valid-assertion', (_child, fail) => {
      assertInvariant(fail, true, 'must stay true')
    })
    await valid()

    const invalid = runtimeRegistration(ctx.invariants.register('@deepseek-ai/dsh-invalid-assertion', (_child, fail) => {
      assertInvariant(fail, false, 'must stay true')
    }))
    await expect(Promise.resolve(invalid)).rejects.toThrow(/must stay true/)
  })

  it('accepts structural service implementations and test doubles', () => {
    expect(serviceShapeViolation({ kind: 'probe', run() {} }, {
      methods: ['run'],
      stringProperties: ['kind'],
    })).toBeUndefined()
    expect(serviceShapeViolation(Object.assign(() => {}, { run() {} }), {
      methods: ['run'],
    })).toBeUndefined()
  })

  it.each([
    { value: null, message: 'service implementation must be an object' },
    { value: 42, message: 'service implementation must be an object' },
    { value: {}, message: 'service implementation must expose method "run"' },
    { value: { run() {}, kind: '' }, message: 'service implementation must expose non-empty string "kind"' },
  ])('rejects invalid structural service implementations: $message', ({ value, message }) => {
    expect(serviceShapeViolation(value, {
      methods: ['run'],
      stringProperties: ['kind'],
    })).toBe(message)
  })
})
