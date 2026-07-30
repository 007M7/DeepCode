import { describe, expect, it, vi } from 'vitest'
import { Context, FiberState, Service } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import InvariantService from '@deepseek-ai/dsh-invariants'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { packageInvariantOwners } from './package-invariants.ts'
import {
  TEST_INVARIANT_READY_SERVICE,
  testInvariantCompanionPaths,
  testInvariantCompanions,
  type TestInvariantCompanion,
  usesManualInvariantTree,
} from './test-invariants.ts'

declare module 'cordis' {
  interface Context {
    testInvariantProbe: TestInvariantProbe
  }
}

class TestInvariantProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'testInvariantProbe')
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function withFakeCompanions(
  create: (path: string, index: number) => () => Promise<TestInvariantCompanion>,
  run: () => Promise<void>,
): Promise<void> {
  const mutable = testInvariantCompanions as Record<string, () => Promise<TestInvariantCompanion>>
  const originals = Object.entries(mutable)
  for (const [index, [path]] of originals.entries()) {
    mutable[path] = create(path, index)
  }
  try {
    await run()
  } finally {
    for (const [path, load] of originals) {
      mutable[path] = load
    }
  }
}

describe('global test invariant host', () => {
  it('uses one exhaustive topology to reserve every package name with enabled checks', async () => {
    const ctx = new Context()
    await ctx.plugin(TestInvariantProbe)

    const owners = packageInvariantOwners(process.cwd())
    expect(Object.keys(testInvariantCompanions)).toHaveLength(owners.length)
    const unreserved: string[] = []
    for (const owner of owners) {
      try {
        const dispose = ctx.invariants.register(owner.packageName, () => {})
        unreserved.push(owner.packageName)
        dispose()
      } catch (error) {
        expect(error).toHaveProperty(
          'message',
          `invariants: package "${owner.packageName}" is already registered`,
        )
      }
    }
    expect(unreserved).toEqual([])
  })

  it('mounts the owning package companion while leaving non-package roots service-only', () => {
    expect(testInvariantCompanionPaths('/repo/packages/core/tools/tests/tools.spec.ts'))
      .toEqual(['../packages/core/tools/src/invariant.ts'])
    expect(testInvariantCompanionPaths('/repo/examples/echo-agent/tests/echo.spec.ts')).toEqual([])
    expect(testInvariantCompanionPaths('/repo/scripts/test-invariants.spec.ts'))
      .toEqual(Object.keys(testInvariantCompanions).sort())
  })

  it('loads and executes every source companion through the real Loader shape', async () => {
    const owners = new Map(packageInvariantOwners(process.cwd()).map(owner => [owner.sourcePath, owner.packageName]))
    const registrations = new Map<string, string>()
    const loader = Object.create(Loader.prototype) as Loader
    const register = vi.fn((_packageName: string, installer: InvariantInstaller) => {
      expect(typeof installer).toBe('function')
      return () => {}
    })
    const fakeContext = { invariants: { register } } as unknown as Context
    for (const [rawPath, load] of Object.entries(testInvariantCompanions)) {
      const companion = await load()
      const path = rawPath.replace(/^\.\.\//, '')
      expect(companion.default, path).toBeUndefined()
      const unwrapped = loader.unwrapExports(companion) as typeof companion
      expect(unwrapped, path).toBe(companion)
      expect(typeof unwrapped.name, path).toBe('string')
      expect(unwrapped.inject, path).toContain('invariants')
      expect(typeof unwrapped.apply, path).toBe('function')
      await unwrapped.apply(fakeContext)
      const call = register.mock.calls.at(-1)
      if (call === undefined) throw new Error(`${path}: companion did not register`)
      registrations.set(path, call[0])
    }
    expect(registrations).toEqual(owners)
  })

  it('recognizes focused invariant suites without a package inventory', () => {
    expect(usesManualInvariantTree('/repo/packages/core/session/tests/invariant.spec.ts')).toBe(true)
    expect(usesManualInvariantTree('/repo/packages/core/session/tests/request-invariant-hmr.spec.ts')).toBe(true)
    expect(usesManualInvariantTree('C:\\repo\\packages\\support\\invariants\\tests\\service.spec.ts')).toBe(true)
    expect(usesManualInvariantTree('/repo/packages/examples/agent-spine-demo/tests/agent-core.spec.ts')).toBe(true)
    expect(usesManualInvariantTree('/repo/packages/core/session/tests/session.spec.ts')).toBe(false)
  })

  it('holds a root plugin until every lazy companion is active, then permits nested startup', async () => {
    const delayedStarted = deferred()
    const releaseDelayed = deferred()
    const order: string[] = []
    let delayedCompanion: TestInvariantCompanion | undefined

    await withFakeCompanions(
      (path, index) => async () => {
        const companion: TestInvariantCompanion = {
          name: `test-invariant-${index}`,
          inject: ['invariants'],
          async apply() {
            order.push(`companion-start:${path}`)
            if (index === 0) {
              delayedStarted.resolve()
              await releaseDelayed.promise
            }
            order.push(`companion-active:${path}`)
            return () => {}
          },
        }
        if (index === 0) delayedCompanion = companion
        return companion
      },
      async () => {
        const ctx = new Context()
        ctx.provide('testInvariantTargetDependency', true)
        let nestedFiber: ReturnType<Context['plugin']> | undefined
        const nestedApply = vi.fn(function nestedApply() {
          order.push('nested')
        })
        const targetApply = Object.assign(vi.fn(function targetApply(targetCtx: Context) {
          order.push('target')
          nestedFiber = targetCtx.plugin(nestedApply)
        }), {
          inject: ['testInvariantTargetDependency'],
        })

        const targetFiber = ctx.plugin(targetApply)
        expect(ctx.registry.get(targetApply)?.callback).toBe(targetApply)
        expect(targetFiber.inject).toEqual({
          testInvariantTargetDependency: null,
          [TEST_INVARIANT_READY_SERVICE]: null,
        })

        await delayedStarted.promise
        await Promise.resolve()
        await Promise.resolve()
        expect(targetApply).not.toHaveBeenCalled()

        releaseDelayed.resolve()
        await targetFiber
        if (nestedFiber === undefined) throw new Error('target did not register its nested plugin')
        await nestedFiber

        expect(targetFiber.state).toBe(FiberState.ACTIVE)
        expect(targetApply).toHaveBeenCalledOnce()
        expect(nestedApply).toHaveBeenCalledOnce()
        const targetIndex = order.indexOf('target')
        expect(targetIndex).toBeGreaterThan(-1)
        expect(order.slice(0, targetIndex)).toHaveLength(Object.keys(testInvariantCompanions).length * 2)
        expect(order.at(-1)).toBe('nested')

        if (delayedCompanion === undefined) throw new Error('delayed companion did not load')
        await ctx.plugin(InvariantService, { enabled: true })
        await ctx.plugin(delayedCompanion)
        expect(ctx.registry.get(InvariantService)?.fibers).toHaveLength(1)
        expect(ctx.registry.get(delayedCompanion)?.fibers).toHaveLength(1)
      },
    )
  })

  it.each(['load', 'startup'] as const)(
    'rejects a target when a lazy companion fails during %s without starting the target',
    async (phase) => {
      const failure = new Error(`test invariant companion ${phase} failed`)
      await withFakeCompanions(
        (_path, index) => phase === 'load' && index === 0
          ? async () => { throw failure }
          : async () => ({
            name: `test-invariant-${index}`,
            inject: ['invariants'],
            async apply() {
              if (phase === 'startup' && index === 0) throw failure
              return () => {}
            },
          }),
        async () => {
          const ctx = new Context()
          const targetApply = vi.fn(function targetApply() {})
          const targetFiber = ctx.plugin(targetApply)

          await expect(targetFiber).rejects.toBe(failure)
          expect(targetApply).not.toHaveBeenCalled()
          expect(targetFiber.state).toBe(FiberState.PENDING)
          await expect(targetFiber.dispose()).resolves.toBeUndefined()
          expect(targetFiber.state).toBe(FiberState.DISPOSED)
        },
      )
    },
  )

  it('disposes a pending target without waiting for companion readiness', async () => {
    const delayedStarted = deferred()
    const releaseDelayed = deferred()

    await withFakeCompanions(
      (_path, index) => async () => ({
        name: `test-invariant-${index}`,
        inject: ['invariants'],
        async apply() {
          if (index === 0) {
            delayedStarted.resolve()
            await releaseDelayed.promise
          }
          return () => {}
        },
      }),
      async () => {
        const ctx = new Context()
        const targetApply = vi.fn(function targetApply() {})
        const targetFiber = ctx.plugin(targetApply)

        await delayedStarted.promise
        await expect(targetFiber.dispose()).resolves.toBeUndefined()
        expect(targetFiber.state).toBe(FiberState.DISPOSED)
        expect(targetApply).not.toHaveBeenCalled()

        releaseDelayed.resolve()
        await targetFiber
        expect(targetApply).not.toHaveBeenCalled()
      },
    )
  })
})
