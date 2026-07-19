/**
 * Vitest-wide invariant host. Ordinary Cordis roots receive the invariant
 * service with global enablement and every package companion before their first
 * plugin starts. Focused invariant tests own their service topology explicitly.
 */

import { expect } from 'vitest'
import { RegistryService } from 'cordis'
import type { Context, Plugin } from 'cordis'
import InvariantService from '@deepseek-ai/dsh-invariants'

declare global {
  interface ImportMeta {
    /** Eager Vite module-glob expansion used by the Vitest setup file. */
    glob<TModule>(pattern: string, options: { eager: true }): Record<string, TModule>
  }
}

/** Loader-safe shape shared by every package invariant companion. */
export interface TestInvariantCompanion {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: Context): Promise<() => void>
}

/** Every package companion, discovered eagerly so coverage observes each registration. */
export const testInvariantCompanions: Readonly<Record<string, TestInvariantCompanion>> =
  import.meta.glob<TestInvariantCompanion>('../packages/*/*/src/invariant.ts', { eager: true })

/** Tests that exercise selection or companion lifecycle with a deliberately hand-built service tree. */
export const MANUAL_INVARIANT_TESTS = [
  '/packages/support/invariants/tests/service.spec.ts',
  '/packages/core/session/tests/invariant.spec.ts',
  '/packages/core/agent/tests/invariant.spec.ts',
  '/packages/core/scope/tests/invariant.spec.ts',
  '/packages/core/agent-loop/tests/invariant.spec.ts',
  '/packages/examples/agent-spine-demo/tests/agent-core.spec.ts',
] as const

interface InvariantHost {
  readonly fibers: readonly PluginFiber[]
  readonly byCallback: ReadonlyMap<unknown, PluginFiber>
}

type PluginFiber = ReturnType<RegistryService['plugin']>

const hosts = new WeakMap<Context, InvariantHost>()
// eslint-disable-next-line @typescript-eslint/unbound-method -- every call below supplies its RegistryService receiver explicitly.
const originalPlugin = RegistryService.prototype.plugin

RegistryService.prototype.plugin = function(plugin: Plugin, config?: unknown, getOuterStack?: () => string[]) {
  if (usesManualInvariantTree()) return originalPlugin.call(this, plugin, config, getOuterStack)

  const root = this.ctx.root
  const host = hosts.get(root) ?? startInvariantHost(root)
  const callback = this.resolve(plugin)
  const existing = callback === undefined ? undefined : host.byCallback.get(callback)
  if (existing !== undefined) return existing

  const fiber = originalPlugin.call(this, plugin, config, getOuterStack)
  // A root-level await is the test's composition boundary. Nested plugin
  // fibers must not await their own companion parent through the global host.
  if (this.ctx !== root) return fiber
  return joinInvariantStartup(fiber, host.fibers)
}

function usesManualInvariantTree(): boolean {
  const testPath = expect.getState().testPath?.replaceAll('\\', '/') ?? ''
  return MANUAL_INVARIANT_TESTS.some(path => testPath.endsWith(path))
}

function startInvariantHost(root: Context): InvariantHost {
  const fibers: PluginFiber[] = []
  const byCallback = new Map<unknown, PluginFiber>()
  const mount = (plugin: Plugin, config?: unknown): void => {
    const fiber = originalPlugin.call(root.registry, plugin, config)
    const callback = root.registry.resolve(plugin)
    if (callback === undefined) throw new Error('test invariants: companion is not a valid Cordis plugin')
    fibers.push(fiber)
    byCallback.set(callback, fiber)
  }

  mount(InvariantService, { enabled: true })
  for (const [path, companion] of Object.entries(testInvariantCompanions).sort(([left], [right]) => left.localeCompare(right))) {
    if (!companion.inject.includes('invariants')) {
      throw new Error(`test invariants: ${path} must inject the invariant service`)
    }
    mount(companion)
  }

  const host = { fibers, byCallback }
  hosts.set(root, host)
  return host
}

function joinInvariantStartup(fiber: PluginFiber, invariantFibers: readonly PluginFiber[]): PluginFiber {
  const readiness = fiber.await().then(async (loaded) => {
    await Promise.all(invariantFibers.map(invariant => invariant.await()))
    return loaded
  })
  const joined = Object.create(fiber) as PluginFiber
  joined.then = readiness.then.bind(readiness)
  return joined
}
