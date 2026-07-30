import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { packageInvariantOwners } from './package-invariants.ts'
import {
  testInvariantCompanionPaths,
  testInvariantCompanions,
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
})
