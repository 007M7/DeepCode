/**
 * Client projection of generated TypeRT Remote descriptors. Contributions
 * install concrete namespace methods; no JavaScript Proxy participates in
 * lookup, invocation, or type exposure.
 */

import { Service, symbols } from 'cordis'
import type { Context } from 'cordis'
import type { ConnectionHandle, RpcError } from '@deepseek-ai/dsh-client-connection/client'
import type {
  InvocationDescriptor,
  TypeRTClientApi,
  TypeRTCodec,
  TypeRTDisposer,
  TypeRTRemoteContribution,
} from '@deepseek-ai/dsh-type-meta'

type RemoteMethod = (...args: unknown[]) => Promise<unknown>

interface MountToken {
  active: boolean
  readonly abort: AbortController
}

interface DirectNamespaceRecord {
  readonly value: Record<string, RemoteMethod>
  readonly tokens: Map<string, MountToken>
}

interface ScopedNamespaceRecord {
  readonly service: ScopedRemoteNamespace
  readonly tokens: Map<string, MountToken>
}

interface ScopedProjection {
  readonly context: string
  readonly wire: string
  readonly codec: TypeRTCodec
  readonly parameterIndex?: number
}

/** Typed API service augmented by generated direct Remote namespaces. */
export type ClientApi = TypeRTClientApi

declare module 'cordis' {
  interface Context {
    /** Generated direct Remote namespaces selected by the Client assembly. */
    api: ClientApi
  }
}

/** Required Client services: the TypeRT registry and the existing Connection carrier. */
export const inject = ['typert', 'connection']

/**
 * Install the typed Client API service.
 * @param ctx - Client Cordis root.
 */
export function apply(ctx: Context): void {
  new ClientApiService(ctx)
}

class ClientApiService extends Service implements TypeRTClientApi {
  private readonly ownerCtx: Context
  private readonly direct = new Map<string, DirectNamespaceRecord>()
  private readonly scoped = new Map<string, ScopedNamespaceRecord>()

  constructor(ctx: Context) {
    super(ctx, 'api')
    this.ownerCtx = ctx
  }

  mount(contribution: TypeRTRemoteContribution): ReturnType<TypeRTClientApi['mount']> {
    this.validateContribution(contribution)
    const callerCtx = this.ctx
    const disposeRemote = callerCtx.typert.remotes.register(contribution)
    let disposeMethods: () => void | Promise<void>
    try {
      disposeMethods = callerCtx.effect(() => {
        const installed: Array<() => void> = []
        try {
          for (const descriptor of contribution.descriptors) installed.push(this.install(descriptor))
        } catch (error) {
          for (const dispose of installed.reverse()) dispose()
          throw error
        }
        return () => {
          for (const dispose of installed.reverse()) dispose()
        }
      }, `api-gateway.client.mount(${JSON.stringify(contribution.package)})`)
    } catch (error) {
      /* v8 ignore next -- rollback disposal only rejects if Cordis teardown itself fails while handling the installation error. */
      Promise.resolve(disposeRemote()).catch(() => {})
      throw error
    }
    return async () => {
      await Promise.all([disposeMethods(), disposeRemote()])
    }
  }

  private validateContribution(contribution: TypeRTRemoteContribution): void {
    const direct = new Map<string, Set<string>>()
    const scoped = new Map<string, Set<string>>()
    const add = (
      table: Map<string, Set<string>>,
      descriptor: InvocationDescriptor,
      kind: 'direct' | 'scoped',
    ): void => {
      const methods = table.get(descriptor.namespace) ?? new Set<string>()
      if (methods.has(descriptor.method)) {
        throw new Error(`client api: contribution repeats ${kind} method ${endpointOf(descriptor)}`)
      }
      methods.add(descriptor.method)
      table.set(descriptor.namespace, methods)
      const live = kind === 'direct'
        ? this.direct.get(descriptor.namespace)?.tokens
        : this.scoped.get(descriptor.namespace)?.tokens
      if (live?.has(descriptor.method) === true) {
        throw new Error(`client api: ${kind} method ${endpointOf(descriptor)} is already mounted`)
      }
    }
    for (const descriptor of contribution.descriptors) {
      requireStrictDescriptor(descriptor)
      if (descriptor.invocation.kind === 'direct') add(direct, descriptor, 'direct')
      if (scopedProjection(descriptor) !== undefined) add(scoped, descriptor, 'scoped')
    }
    for (const namespace of direct.keys()) {
      if (!this.direct.has(namespace) && namespace in this) {
        throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with the API service`)
      }
    }
    for (const [namespace, methods] of scoped) {
      const record = this.scoped.get(namespace)
      if (record !== undefined) {
        for (const method of methods) record.service.assertMethodAvailable(method)
      } else {
        for (const method of methods) ScopedRemoteNamespace.assertMethodAvailable(namespace, method)
        const property = this.ownerCtx.reflect.props[namespace]
        if (property?.type === 'accessor' || this.ownerCtx.get(namespace) !== undefined) {
          throw new Error(`client api: scoped namespace ${JSON.stringify(namespace)} conflicts with an existing Context property`)
        }
      }
    }
  }

  private install(descriptor: InvocationDescriptor): () => void {
    const token: MountToken = { active: true, abort: new AbortController() }
    const installed: (() => void)[] = []
    try {
      if (descriptor.invocation.kind === 'direct') {
        installed.push(this.installDirect(descriptor, token))
      }
      const projection = scopedProjection(descriptor)
      if (projection !== undefined) installed.push(this.installScoped(descriptor, projection, token))
    } catch (error) {
      token.active = false
      for (const dispose of installed.reverse()) dispose()
      token.abort.abort()
      throw error
    }
    return () => {
      /* v8 ignore next -- Cordis effect disposers are idempotent and invoke this cleanup at most once. */
      if (!token.active) return
      token.active = false
      for (const dispose of installed.reverse()) dispose()
      token.abort.abort()
    }
  }

  private installDirect(descriptor: InvocationDescriptor, token: MountToken): () => void {
    let namespace = this.direct.get(descriptor.namespace)
    const fresh = namespace === undefined
    if (namespace === undefined) {
      namespace = { value: Object.create(null) as Record<string, RemoteMethod>, tokens: new Map() }
      Object.defineProperty(this, descriptor.namespace, {
        configurable: true,
        enumerable: true,
        value: namespace.value,
      })
    }
    try {
      Object.defineProperty(namespace.value, descriptor.method, {
        configurable: true,
        enumerable: true,
        value: (...args: unknown[]) => this.invoke(descriptor, undefined, token, this.ownerCtx, args),
      })
    } catch (error) {
      if (fresh) Reflect.deleteProperty(this, descriptor.namespace)
      throw error
    }
    if (fresh) this.direct.set(descriptor.namespace, namespace)
    namespace.tokens.set(descriptor.method, token)
    return () => {
      /* v8 ignore next -- duplicate live methods are rejected before installation, so no newer token can replace this one. */
      if (namespace.tokens.get(descriptor.method) !== token) return
      Reflect.deleteProperty(namespace.value, descriptor.method)
      namespace.tokens.delete(descriptor.method)
      if (namespace.tokens.size !== 0) return
      this.direct.delete(descriptor.namespace)
      Reflect.deleteProperty(this, descriptor.namespace)
    }
  }

  private installScoped(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection,
    token: MountToken,
  ): () => void {
    let namespace = this.scoped.get(descriptor.namespace)
    if (namespace === undefined) {
      const service = new ScopedRemoteNamespace(
        this.ownerCtx,
        descriptor.namespace,
        (current, currentProjection, currentToken, caller, args) =>
          this.invoke(current, currentProjection, currentToken, caller, args),
      )
      service.install(descriptor, projection, token)
      namespace = { service, tokens: new Map() }
      this.scoped.set(descriptor.namespace, namespace)
    } else {
      namespace.service.install(descriptor, projection, token)
    }
    namespace.tokens.set(descriptor.method, token)
    return () => {
      /* v8 ignore next -- duplicate live methods are rejected before installation, so no newer token can replace this one. */
      if (namespace.tokens.get(descriptor.method) !== token) return
      namespace.service.remove(descriptor.method)
      namespace.tokens.delete(descriptor.method)
      if (namespace.tokens.size === 0) this.scoped.delete(descriptor.namespace)
    }
  }

  private async invoke(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
  ): Promise<unknown> {
    const endpoint = endpointOf(descriptor)
    if (!token.active) throw new Error(`client api: Remote method ${endpoint} is no longer mounted`)
    const expected = descriptor.parameters.length - (projection?.parameterIndex === undefined ? 0 : 1)
    const hasCallerSignal = descriptor.cancellation !== undefined && values.length === expected + 1
    if (values.length !== expected && !hasCallerSignal) {
      const contract = descriptor.cancellation === undefined
        ? `${String(expected)} argument(s)`
        : `${String(expected)} business argument(s) plus an optional AbortSignal`
      throw new Error(
        `client api: ${endpoint} expected ${contract}, got ${String(values.length)}`,
      )
    }
    const args = Object.create(null) as Record<string, unknown>
    if (projection !== undefined) {
      const binder = this.ownerCtx.typert.contexts.getClient(projection.context)
      if (binder === undefined) {
        throw new Error(`client api: ${endpoint} has no Client Context binder for ${JSON.stringify(projection.context)}`)
      }
      const identity = binder.identity(callerCtx)
      if (identity === undefined) {
        throw new Error(`client api: ${endpoint} requires a ${JSON.stringify(projection.context)} Context`)
      }
      args[projection.wire] = parse(projection.codec, identity, endpoint, projection.wire)
    }
    let valueIndex = 0
    descriptor.parameters.forEach((parameter, parameterIndex) => {
      if (parameterIndex === projection?.parameterIndex) return
      args[parameter.wire] = parse(parameter.codec, values[valueIndex], endpoint, parameter.wire)
      valueIndex += 1
    })
    const connection = this.ownerCtx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error(`client api: ${endpoint} has no active Connection`)
    const callerSignal = hasCallerSignal ? values[expected] as AbortSignal | undefined : undefined
    const signal = callerSignal === undefined
      ? token.abort.signal
      : AbortSignal.any([token.abort.signal, callerSignal])
    const result = await connection.rpc.call('/api', endpoint, { args }, signal)
    if (!mountActive(token)) throw new Error(`client api: Remote method ${endpoint} was withdrawn during invocation`)
    if (!result.ok) throw remoteFailure(endpoint, result.error)
    return parse(descriptor.result, result.value, endpoint, 'result')
  }
}

type InvokeRemote = (
  descriptor: InvocationDescriptor,
  projection: ScopedProjection,
  token: MountToken,
  callerCtx: Context,
  args: readonly unknown[],
) => Promise<unknown>

class ScopedRemoteNamespace {
  private readonly ctx: Context
  private readonly ownerCtx: Context
  private readonly methods = new Set<string>()
  private disposeService: TypeRTDisposer | undefined
  readonly name: string

  static assertMethodAvailable(namespace: string, method: string): void {
    if (SCOPED_NAMESPACE_FIELDS.has(method) || method in ScopedRemoteNamespace.prototype) {
      throw new Error(`client api: scoped method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`)
    }
  }

  constructor(
    ctx: Context,
    name: string,
    private readonly invokeRemote: InvokeRemote,
  ) {
    this.ctx = ctx
    this.ownerCtx = ctx
    this.name = name
    Object.defineProperty(this, symbols.tracker, {
      value: { associate: name, property: 'ctx' },
    })
  }

  assertMethodAvailable(method: string): void {
    ScopedRemoteNamespace.assertMethodAvailable(this.name, method)
    if (method in this) {
      throw new Error(`client api: scoped method ${JSON.stringify(`${this.name}/${method}`)} conflicts with its namespace service`)
    }
  }

  install(descriptor: InvocationDescriptor, projection: ScopedProjection, token: MountToken): void {
    this.assertMethodAvailable(descriptor.method)
    const activate = this.methods.size === 0
    const method = descriptor.method
    try {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        value: function (this: ScopedRemoteNamespace, ...args: unknown[]): Promise<unknown> {
          return this.invokeRemote(descriptor, projection, token, this.ctx, args)
        },
      })
      if (activate) {
        this.disposeService = this.ownerCtx.reflect.provide(this.name, this)
      }
    } catch (error) {
      Reflect.deleteProperty(this, method)
      throw error
    }
    this.methods.add(method)
  }

  remove(method: string): void {
    Reflect.deleteProperty(this, method)
    this.methods.delete(method)
    if (this.methods.size !== 0) return
    const disposeService = this.disposeService
    this.disposeService = undefined
    void disposeService?.()
  }
}

const SCOPED_NAMESPACE_FIELDS = new Set(['ctx', 'disposeService', 'invokeRemote', 'methods', 'name', 'ownerCtx'])

function endpointOf(descriptor: Pick<InvocationDescriptor, 'namespace' | 'method'>): string {
  return `${descriptor.namespace}/${descriptor.method}`
}

function mountActive(token: MountToken): boolean {
  return token.active
}

function scopedProjection(descriptor: InvocationDescriptor): ScopedProjection | undefined {
  if (descriptor.invocation.kind === 'context') {
    return {
      context: descriptor.invocation.context,
      wire: descriptor.invocation.wire,
      codec: descriptor.invocation.codec,
    }
  }
  if (descriptor.scope === undefined) return undefined
  const lookupParameters = descriptor.parameters
    .map((parameter, index) => ({ parameter, index }))
    .filter(candidate => candidate.parameter.source === 'lookup')
  const selected = lookupParameters.length === 1 ? lookupParameters[0] : undefined
  if (selected === undefined
    || selected.parameter.wire !== descriptor.scope.wire
    || selected.parameter.lookup !== descriptor.scope.context) {
    throw new Error(
      `client api: generated Remote ${endpointOf(descriptor)} scope must select its only lookup parameter`,
    )
  }
  return {
    context: descriptor.scope.context,
    wire: descriptor.scope.wire,
    codec: selected.parameter.codec,
    parameterIndex: selected.index,
  }
}

function requireStrictDescriptor(descriptor: InvocationDescriptor): void {
  const endpoint = endpointOf(descriptor)
  requireStrictCodec(descriptor.result, endpoint, 'result')
  for (const parameter of descriptor.parameters) {
    requireStrictCodec(parameter.codec, endpoint, parameter.wire)
  }
  if (descriptor.invocation.kind === 'context') {
    requireStrictCodec(descriptor.invocation.codec, endpoint, descriptor.invocation.wire)
  }
}

function requireStrictCodec(codec: TypeRTCodec, endpoint: string, field: string): void {
  if (codec.mode !== 'strict') {
    throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
  }
}

function parse(codec: TypeRTCodec, value: unknown, endpoint: string, field: string): unknown {
  if (codec.mode !== 'strict') {
    throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
  }
  try {
    return codec.schema.parse(value)
  } catch (cause) {
    throw new Error(`client api: ${endpoint} rejected ${JSON.stringify(field)}`, { cause })
  }
}

function remoteFailure(endpoint: string, error: RpcError): Error {
  return new Error(`client api: ${endpoint} failed: ${error.code}: ${error.message}`, { cause: error })
}
