/**
 * Vitest-wide invariant host. Ordinary Cordis roots receive the invariant
 * service with global enablement plus the current test package's companion.
 * One topology test mounts every companion; focused invariant tests own their
 * service topology explicitly.
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
  readonly default?: unknown
  apply(ctx: Context): Promise<() => void>
}

/** Every package companion, discovered eagerly so coverage observes each registration. */
export const testInvariantCompanions: Readonly<Record<string, TestInvariantCompanion>> =
  import.meta.glob<TestInvariantCompanion>('../packages/*/*/src/invariant.ts', { eager: true })

/** Manual-topology suites whose names cannot follow the focused invariant convention. */
const MANUAL_INVARIANT_TEST_EXCEPTIONS = [
  '/packages/support/invariants/tests/service.spec.ts',
  '/packages/examples/agent-spine-demo/tests/agent-core.spec.ts',
] as const

interface InvariantHost {
  readonly fibers: readonly PluginFiber[]
  readonly byCallback: ReadonlyMap<unknown, PluginFiber>
  readonly ready: Promise<void>
}

type PluginFiber = ReturnType<RegistryService['plugin']>

const hosts = new WeakMap<Context, InvariantHost>()
// eslint-disable-next-line @typescript-eslint/unbound-method -- every call below supplies its RegistryService receiver explicitly.
const originalPlugin = RegistryService.prototype.plugin

RegistryService.prototype.plugin = function(plugin: Plugin, config?: unknown, getOuterStack?: () => string[]) {
  const testPath = expect.getState().testPath ?? ''
  if (usesManualInvariantTree(testPath)) return originalPlugin.call(this, plugin, config, getOuterStack)

  const root = this.ctx.root
  const host = hosts.get(root) ?? startInvariantHost(root)
  const callback = this.resolve(plugin)
  const existing = callback === undefined ? undefined : host.byCallback.get(callback)
  if (existing !== undefined) {
    return this.ctx === root ? joinInvariantStartup(existing, host.ready) : existing
  }

  const fiber = originalPlugin.call(this, plugin, config, getOuterStack)
  // A root-level await is the test's composition boundary. Nested plugin
  // fibers must not await their own companion parent through the global host.
  if (this.ctx !== root) return fiber
  return joinInvariantStartup(fiber, host.ready)
}

/**
 * Detect focused suites that construct service selection or companion lifecycle explicitly.
 * @param testPath - absolute or repo-relative Vitest file path.
 * @returns whether the global invariant host must leave the root untouched.
 */
export function usesManualInvariantTree(testPath: string): boolean {
  const normalized = testPath.replaceAll('\\', '/')
  if (/\/packages\/[^/]+\/[^/]+\/tests\/[^/]*invariant[^/]*\.spec\.ts$/.test(normalized)) return true
  return MANUAL_INVARIANT_TEST_EXCEPTIONS.some(path => normalized.endsWith(path))
}

const ALL_COMPANION_TESTS = ['/scripts/test-invariants.spec.ts'] as const

/**
 * Select the package companions that an ordinary test root must register.
 * Package tests receive their owner's checks; the dedicated topology test
 * receives every owner so coverage and exhaustive runtime registration remain
 * independently enforced.
 * @param testPath - absolute or repo-relative normalized Vitest file path.
 * @returns sorted `import.meta.glob` keys for companions to mount.
 */
export function testInvariantCompanionPaths(testPath: string): string[] {
  const normalized = testPath.replaceAll('\\', '/')
  const allPaths = Object.keys(testInvariantCompanions).sort()
  if (ALL_COMPANION_TESTS.some(path => normalized.endsWith(path))) return allPaths

  const owner = normalized.match(/\/packages\/([^/]+)\/([^/]+)\/tests\//)
  if (owner === null) return []
  const companionPath = `../packages/${owner[1]}/${owner[2]}/src/invariant.ts`
  if (testInvariantCompanions[companionPath] === undefined) {
    throw new Error(`test invariants: package test has no companion at ${companionPath}`)
  }
  return [companionPath]
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
  const testPath = expect.getState().testPath ?? ''
  const companionPaths = testInvariantCompanionPaths(testPath)
  for (const path of companionPaths) {
    const companion = testInvariantCompanions[path]
    if (companion === undefined) {
      throw new Error(`test invariants: selected companion vanished at ${path}`)
    }
    if (!companion.inject.includes('invariants')) {
      throw new Error(`test invariants: ${path} must inject the invariant service`)
    }
    mount(companion)
  }

  const [serviceFiber, ...companionFibers] = fibers
  if (serviceFiber === undefined) throw new Error('test invariants: service fiber was not mounted')
  // A companion is initially PENDING on the invariant service, and Cordis
  // Fiber.await() only joins work already in flight. Wait for the service to
  // activate its dependants before joining their startup and failures.
  const ready = serviceFiber.await()
    .then(() => Promise.all(companionFibers.map(fiber => fiber.await())))
    .then(() => undefined)
  const host = { fibers, byCallback, ready }
  hosts.set(root, host)
  return host
}

function joinInvariantStartup(fiber: PluginFiber, invariantReady: Promise<void>): PluginFiber {
  const readiness = fiber.await().then(async (loaded) => {
    await invariantReady
    return loaded
  })
  const joined = Object.create(fiber) as PluginFiber
  joined.then = readiness.then.bind(readiness)
  return joined
}
