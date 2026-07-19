/**
 * Configurable registry for package-owned runtime invariant contributions.
 * Every workspace package registers checks from a `./invariant` companion;
 * ordinary package entrypoints stay independent of diagnostics.
 *
 * @module @deepseek-ai/dsh-invariants
 */

import { Context, FiberState, Service } from 'cordis'
import type { Fiber, Inject, Plugin } from 'cordis'
import z from 'schemastery'
import type Schema from 'schemastery'

/** Runtime invariant selection configured on the service plugin. */
export interface Config {
  /** Global switch; defaults to `true`. */
  readonly enabled?: boolean
  /** Case-sensitive JavaScript regex sources that admit package names; empty admits all. */
  readonly package_allowlist?: string[]
  /** Case-sensitive JavaScript regex sources that exclude package names after allowlist matching. */
  readonly package_blocklist?: string[]
}

/**
 * Throw a package-attributed invariant failure.
 * @param message - violated package contract without the standard prefix.
 * @returns never because reporting a violation throws.
 */
export type InvariantFailure = (message: string) => never

/** Install one package's checks into the registration's child context. */
export interface InvariantInstaller {
  /**
   * Install the package contribution.
   * @param ctx - child context owned by this invariant registration.
   * @param fail - reporter bound to the registering package name.
   * @returns nothing, or a promise settling after asynchronous checks finish.
   */
  (ctx: Context, fail: InvariantFailure): void | Promise<void>
  /** Services the child installer fiber may access. */
  readonly inject?: Inject
}

/** Runtime facts one package expects from its Cordis plugin fiber. */
export interface PluginInvariantContract {
  /** Exact plugin value when checking it does not preload an unrelated runtime; otherwise matching uses `name`. */
  readonly plugin?: Plugin
  /** Exact Cordis display name for the plugin fiber. */
  readonly name: string
  /** Required service injections that must be present when the fiber activates. */
  readonly inject?: readonly string[]
  /** Required owned effect labels; an inner array means at least one alternative must exist. */
  readonly effects?: readonly (string | readonly string[])[]
  /** Services the active fiber must provide. */
  readonly services?: readonly string[]
  /** Optional package-owned validation after the structural checks pass. */
  readonly validate?: (fiber: Fiber, effectLabels: ReadonlySet<string>) => string | undefined
}

/** Collect all live effect labels below a plugin fiber. */
function collectEffectLabels(fiber: Fiber): ReadonlySet<string> {
  const labels = new Set<string>()
  const visit = (effects: ReturnType<Fiber['getEffects']>): void => {
    for (const effect of effects) {
      labels.add(effect.label)
      visit(effect.children)
    }
  }
  visit(fiber.getEffects())
  return labels
}

/** One package check routed by a root-shared plugin lifecycle dispatcher. */
interface PluginObservation {
  readonly callback: globalThis.Function | undefined
  readonly contract: PluginInvariantContract
  readonly fail: InvariantFailure
}

/** Indexed plugin checks and the two lifecycle listeners shared by one root. */
interface PluginObservationHub {
  readonly byCallback: Map<globalThis.Function, Set<PluginObservation>>
  readonly byName: Map<string, Set<PluginObservation>>
}

const pluginObservationHubs = new WeakMap<Context, PluginObservationHub>()

/** Check one already-matched active plugin fiber. */
function inspectPluginObservation(observation: PluginObservation, fiber: Fiber): void {
  if (fiber.state !== FiberState.ACTIVE || fiber.uid === null) return
  const { callback, contract, fail } = observation
  if (callback !== undefined && fiber.name !== contract.name) {
    fail(`active plugin name must be ${JSON.stringify(contract.name)}, got ${JSON.stringify(fiber.name)}`)
  }
  const injections = new Set(Object.keys(fiber.inject))
  for (const service of contract.inject ?? []) {
    if (!injections.has(service)) fail(`active plugin must inject ${JSON.stringify(service)}`)
  }

  const effectLabels = collectEffectLabels(fiber)
  for (const requirement of contract.effects ?? []) {
    const alternatives = typeof requirement === 'string' ? [requirement] : requirement
    if (!alternatives.some(label => effectLabels.has(label))) {
      fail(`active plugin must own effect ${alternatives.map(label => JSON.stringify(label)).join(' or ')}`)
    }
  }
  for (const service of contract.services ?? []) {
    const provided = Reflect.ownKeys(fiber.ctx.reflect.store).some((key) => {
      const implementation = fiber.ctx.reflect.store[key as symbol]
      return implementation?.fiber === fiber && implementation.name === service
    })
    if (!provided) fail(`active plugin must provide service ${JSON.stringify(service)}`)
  }
  const message = contract.validate?.(fiber, effectLabels)
  if (message !== undefined) fail(message)
}

/** Route one lifecycle notification only to checks that can match its runtime. */
function inspectObservedPlugin(hub: PluginObservationHub, fiber: Fiber): void {
  const callback = fiber.runtime?.callback
  if (callback !== undefined) {
    for (const observation of hub.byCallback.get(callback) ?? []) {
      inspectPluginObservation(observation, fiber)
    }
  }
  const runtimeName = fiber.runtime?.name
  if (runtimeName !== undefined) {
    for (const observation of hub.byName.get(runtimeName) ?? []) {
      inspectPluginObservation(observation, fiber)
    }
  }
}

/** Return the root's shared plugin dispatcher, creating its two listeners once. */
function pluginObservationHub(ctx: Context): PluginObservationHub {
  const root = ctx.root
  const existing = pluginObservationHubs.get(root)
  if (existing !== undefined) return existing

  const hub: PluginObservationHub = {
    byCallback: new Map(),
    byName: new Map(),
  }
  pluginObservationHubs.set(root, hub)
  root.on('internal/plugin', (fiber) => { inspectObservedPlugin(hub, fiber) }, { global: true })
  root.on('internal/status', (fiber) => { inspectObservedPlugin(hub, fiber) }, { global: true })
  return hub
}

/** Add one plugin observation to a typed exact-key index. */
function addIndexedPluginObservation<Key>(
  index: Map<Key, Set<PluginObservation>>,
  key: Key,
  observation: PluginObservation,
): () => void {
  const observations = index.get(key) ?? new Set<PluginObservation>()
  index.set(key, observations)
  observations.add(observation)
  return () => {
    observations.delete(observation)
    if (observations.size === 0) index.delete(key)
  }
}

/** Add one observation to its exact callback or runtime-name index. */
function addPluginObservation(hub: PluginObservationHub, observation: PluginObservation): () => void {
  if (observation.callback === undefined) {
    return addIndexedPluginObservation(hub.byName, observation.contract.name, observation)
  }
  return addIndexedPluginObservation(hub.byCallback, observation.callback, observation)
}

/**
 * Observe one package plugin and fail whenever an active fiber violates its
 * declared name, dependency, effect, service, or package-specific contract.
 * Existing fibers are checked immediately; later starts and HMR activations
 * are checked through two indexed lifecycle listeners shared by the root.
 * @param ctx - invariant child context that owns the observers.
 * @param fail - reporter bound to the package that owns the plugin.
 * @param contract - expected runtime facts for the package plugin.
 * @returns nothing after lifecycle observers are installed.
 */
export function observePluginInvariant(
  ctx: Context,
  fail: InvariantFailure,
  contract: PluginInvariantContract,
): void {
  const callback = contract.plugin === undefined ? undefined : ctx.registry.resolve(contract.plugin)
  if (contract.plugin !== undefined && callback === undefined) {
    fail('invariant contract does not identify a Cordis plugin')
  }

  const observation: PluginObservation = { callback, contract, fail }

  if (contract.plugin === undefined) {
    for (const runtime of ctx.registry.values()) {
      if (runtime.name !== contract.name) continue
      for (const fiber of runtime.fibers) inspectPluginObservation(observation, fiber)
    }
  } else {
    for (const fiber of ctx.registry.get(contract.plugin)?.fibers ?? []) {
      inspectPluginObservation(observation, fiber)
    }
  }
  const hub = pluginObservationHub(ctx)
  ctx.effect(
    () => addPluginObservation(hub, observation),
    `invariants.observePlugin(${JSON.stringify(contract.name)})`,
  )
}

/** One structural check routed by a root-shared service lifecycle dispatcher. */
interface ServiceObservation {
  readonly fail: InvariantFailure
  readonly validate: (value: unknown) => string | undefined
}

/** Service checks and the single service listener shared by one root. */
interface ServiceObservationHub {
  readonly byName: Map<string, Set<ServiceObservation>>
}

const serviceObservationHubs = new WeakMap<Context, ServiceObservationHub>()

/** Check one present service implementation. */
function inspectServiceObservation(observation: ServiceObservation, value: unknown): void {
  if (value === undefined) return
  const message = observation.validate(value)
  if (message !== undefined) observation.fail(message)
}

/** Return the root's shared service dispatcher, creating its listener once. */
function serviceObservationHub(ctx: Context): ServiceObservationHub {
  const root = ctx.root
  const existing = serviceObservationHubs.get(root)
  if (existing !== undefined) return existing

  const hub: ServiceObservationHub = { byName: new Map() }
  serviceObservationHubs.set(root, hub)
  root.on('internal/service', (name, value: unknown) => {
    for (const observation of hub.byName.get(name) ?? []) {
      inspectServiceObservation(observation, value)
    }
  }, { global: true })
  return hub
}

/** Add one service observation to its exact service-name index. */
function addServiceObservation(
  hub: ServiceObservationHub,
  serviceName: string,
  observation: ServiceObservation,
): () => void {
  const observations = hub.byName.get(serviceName) ?? new Set<ServiceObservation>()
  hub.byName.set(serviceName, observations)
  observations.add(observation)
  return () => {
    observations.delete(observation)
    if (observations.size === 0) hub.byName.delete(serviceName)
  }
}

/**
 * Validate every current and future implementation bound to one Cordis
 * service through the root's indexed shared service listener.
 * @param ctx - invariant child context that owns the service observer.
 * @param fail - reporter bound to the package that owns the service seam.
 * @param serviceName - Cordis service name to observe.
 * @param validate - returns the violated contract, or `undefined` for a valid implementation.
 * @returns nothing after the current binding is checked and the observer is installed.
 */
export function observeServiceInvariant(
  ctx: Context,
  fail: InvariantFailure,
  serviceName: string,
  validate: (value: unknown) => string | undefined,
): void {
  const observation: ServiceObservation = { fail, validate }
  const current: unknown = ctx.get(serviceName)
  inspectServiceObservation(observation, current)
  const hub = serviceObservationHub(ctx)
  ctx.effect(
    () => addServiceObservation(hub, serviceName, observation),
    `invariants.observeService(${JSON.stringify(serviceName)})`,
  )
}

/** Structural runtime surface required from a Cordis service implementation. */
export interface ServiceShapeInvariant {
  /** Members that must be callable. */
  readonly methods: readonly string[]
  /** Members that must be non-empty strings. */
  readonly stringProperties?: readonly string[]
}

/**
 * Describe the first missing member in a structural service implementation.
 * This deliberately accepts test doubles and third-party implementations that
 * satisfy the seam without inheriting the first-party abstract service class.
 * @param value - candidate service implementation.
 * @param shape - callable and string members owned by the service package.
 * @returns the violated shape, or `undefined` when the candidate conforms.
 */
export function serviceShapeViolation(
  value: unknown,
  shape: ServiceShapeInvariant,
): string | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return 'service implementation must be an object'
  }
  const record = value as Record<string, unknown>
  for (const method of shape.methods) {
    if (typeof record[method] !== 'function') return `service implementation must expose method ${JSON.stringify(method)}`
  }
  for (const property of shape.stringProperties ?? []) {
    if (typeof record[property] !== 'string' || record[property].length === 0) {
      return `service implementation must expose non-empty string ${JSON.stringify(property)}`
    }
  }
  return undefined
}

/**
 * Report a failed package-owned synchronous invariant.
 * @param fail - reporter bound to the package that owns the assertion.
 * @param condition - condition that must hold.
 * @param message - violated contract when `condition` is false.
 * @returns nothing when the condition holds.
 */
export function assertInvariant(
  fail: InvariantFailure,
  condition: unknown,
  message: string,
): void {
  if (!condition) fail(message)
}

/** Internal effect shape used to join child startup before a companion loads. */
interface PendingInvariantRegistration extends PromiseLike<() => void> {
  (): void | Promise<void>
}

/** Thrown when a package-owned runtime invariant is violated. */
export class InvariantError extends Error {
  /** Stable machine-readable invariant failure code. */
  readonly code = 'INVARIANT' as const
  /** Full npm package name that owns the violated invariant. */
  readonly packageName: string

  /**
   * Construct a package-attributed invariant failure.
   * @param packageName - full npm package name that registered the check.
   * @param message - violated contract, without the standard error prefix.
   */
  constructor(packageName: string, message: string) {
    super(`invariant violated by "${packageName}": ${message}`)
    this.name = 'InvariantError'
    this.packageName = packageName
  }
}

declare module 'cordis' {
  interface Context {
    invariants: InvariantService
  }
}

/** Compile and validate one package-filter list. */
function compilePatterns(field: 'package_allowlist' | 'package_blocklist', values: readonly string[]): RegExp[] {
  const seen = new Set<string>()
  return values.map((value) => {
    if (value.length === 0 || value.trim() !== value) {
      throw new Error(`invariants: ${field} entries must be non-blank and have no surrounding whitespace`)
    }
    if (seen.has(value)) {
      throw new Error(`invariants: ${field} contains duplicate regex ${JSON.stringify(value)}`)
    }
    seen.add(value)
    try {
      return new RegExp(value)
    } catch (cause) {
      throw new Error(`invariants: ${field} contains invalid regex ${JSON.stringify(value)}`, { cause })
    }
  })
}

/** Package-owned invariant registry with global and regex-based selection. */
export class InvariantService extends Service {
  static Config: Schema<Config> = z.object({
    enabled: z.boolean().default(true),
    package_allowlist: z.array(z.string()).default([]),
    package_blocklist: z.array(z.string()).default([]),
  })

  private readonly enabled: boolean
  private readonly ownerCtx: Context
  private readonly packageAllowlist: readonly RegExp[]
  private readonly packageBlocklist: readonly RegExp[]
  private readonly registrations = new Set<string>()

  /**
   * Create and install the invariant registry.
   * @param ctx - Cordis context that owns the service.
   * @param config - global enablement and package-name regex filters.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'invariants')
    this.ownerCtx = ctx
    this.enabled = config.enabled ?? true
    this.packageAllowlist = compilePatterns('package_allowlist', config.package_allowlist ?? [])
    this.packageBlocklist = compilePatterns('package_blocklist', config.package_blocklist ?? [])
  }

  /** Return whether one full package name passes the configured filters. */
  private selected(packageName: string): boolean {
    if (!this.enabled) return false
    if (this.packageAllowlist.length > 0
      && !this.packageAllowlist.some(pattern => pattern.test(packageName))) return false
    return !this.packageBlocklist.some(pattern => pattern.test(packageName))
  }

  /**
   * Register one package's invariant installer. The package name is reserved
   * even when filtering disables its checks. Enabled installers run in a child
   * fiber; failure disposes that fiber and releases the reservation.
   * @param packageName - full npm package name that owns the contribution.
   * @param installer - listener or startup-check installer for the child context.
   * @returns an effect-scoped disposer for the registration.
   */
  register(packageName: string, installer: InvariantInstaller): () => void {
    if (packageName.length === 0 || packageName.trim() !== packageName || /\s/.test(packageName)) {
      throw new Error('invariants: packageName must be non-blank and contain no whitespace')
    }
    if (this.registrations.has(packageName)) {
      throw new Error(`invariants: package "${packageName}" is already registered`)
    }

    // Service method tracing binds `this.ctx` to the caller. This explicit
    // origin keeps registrations and their child fibers owned by the service;
    // companion disposal is covered independently by the returned disposer.
    const ctx = this.ownerCtx
    const registrations = this.registrations
    registrations.add(packageName)

    let registration: PendingInvariantRegistration
    try {
      registration = ctx.effect(async () => {
        if (!this.selected(packageName)) {
          return () => {
            registrations.delete(packageName)
          }
        }

        const installInvariant = (childCtx: Context) => (
          installer(childCtx, (message): never => {
            throw new InvariantError(packageName, message)
          })
        )
        const child = ctx.plugin(installer.inject === undefined
          ? installInvariant
          : Object.assign(installInvariant, { inject: installer.inject }))

        try {
          await child
        } catch (error) {
          try {
            await child.dispose()
          } finally {
            registrations.delete(packageName)
          }
          throw error
        }

        return async () => {
          try {
            await child.dispose()
          } finally {
            registrations.delete(packageName)
          }
        }
      }, `invariants.register(${JSON.stringify(packageName)})`)
    } catch (error) {
      registrations.delete(packageName)
      throw error
    }
    // Cordis attaches setup thenability and async teardown to this callable;
    // the service seam intentionally exposes only the conventional disposer.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the extra runtime shape stays private.
    return registration
  }
}

export default InvariantService
