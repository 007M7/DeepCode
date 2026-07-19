import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { packageInvariantOwners } from './package-invariants.ts'
import {
  MANUAL_INVARIANT_TESTS,
  testInvariantCompanionPaths,
  testInvariantCompanions,
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

  it('executes each companion registration with its owning package name', async () => {
    const owners = new Map(packageInvariantOwners(process.cwd()).map(owner => [owner.sourcePath, owner.packageName]))
    const registrations = new Map<string, string>()
    const register = vi.fn((_packageName: string, installer: InvariantInstaller) => {
      expect(typeof installer).toBe('function')
      return () => {}
    })
    const fakeContext = { invariants: { register } } as unknown as Context
    for (const [rawPath, companion] of Object.entries(testInvariantCompanions)) {
      const path = rawPath.replace(/^\.\.\//, '')
      await companion.apply(fakeContext)
      const call = register.mock.calls.at(-1)
      if (call === undefined) throw new Error(`${path}: companion did not register`)
      registrations.set(path, call[0])
    }
    expect(registrations).toEqual(owners)
  })

  it('limits manual composition to focused invariant topology tests', () => {
    expect(MANUAL_INVARIANT_TESTS).toEqual([
      '/packages/support/invariants/tests/service.spec.ts',
      '/packages/core/session/tests/invariant.spec.ts',
      '/packages/core/agent/tests/invariant.spec.ts',
      '/packages/core/scope/tests/invariant.spec.ts',
      '/packages/core/agent-loop/tests/invariant.spec.ts',
      '/packages/examples/agent-spine-demo/tests/agent-core.spec.ts',
    ])
  })
})
