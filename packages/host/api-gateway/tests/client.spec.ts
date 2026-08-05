import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {
  InvocationDescriptor,
  TypeRTContext,
  TypeRTRemoteContextApi,
  TypeRTRemoteNamespace,
} from '@deepseek-ai/dsh-type-meta'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply, inject } from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-type-meta' {
  interface TypeRTContextMap {
    fixture: TypeRTContext<string>
  }

  interface TypeRTRemoteMap {
    'goals/create': (agentId: string, request: { readonly objective: string }) => Promise<{ readonly ref: string }>
  }

  interface TypeRTRemoteContextMap {
    'fixture:goals/create': (request: { readonly objective: string }) => Promise<{ readonly ref: string }>
    'fixture:goals/rename': (request: { readonly objective: string }) => Promise<{ readonly renamed: boolean }>
  }

  interface TypeRTRemoteNamespaceMap {
    goals: TypeRTRemoteNamespace<'goals'>
  }

}

type FixtureContext = Context & TypeRTRemoteContextApi<'fixture'>

const idSchema = z.string().min(1)
const requestSchema = z.object({ objective: z.string().min(1) })
const createResultSchema = z.object({ ref: z.string().min(1) })
const renameResultSchema = z.object({ renamed: z.boolean() })

function directDescriptor(): InvocationDescriptor {
  return {
    id: '@fixture/goals#goals/create',
    service: 'goals',
    namespace: 'goals',
    method: 'create',
    invocation: { kind: 'direct' },
    scope: { context: 'fixture', wire: 'agentId' },
    parameters: [{
      name: 'agent',
      wire: 'agentId',
      source: 'lookup',
      lookup: 'fixture',
      codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', schema: idSchema },
    }, {
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#CreateRequest', schema: requestSchema },
    }],
    result: { mode: 'strict', typeSymbol: '@fixture#CreateResult', schema: createResultSchema },
  }
}

function contextDescriptor(): InvocationDescriptor {
  return {
    id: '@fixture/goals#goals/rename',
    service: 'goals',
    namespace: 'goals',
    method: 'rename',
    invocation: {
      kind: 'context',
      context: 'fixture',
      wire: 'agentId',
      codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', schema: idSchema },
    },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#RenameRequest', schema: requestSchema },
    }],
    result: { mode: 'strict', typeSymbol: '@fixture#RenameResult', schema: renameResultSchema },
  }
}

async function bench(call: ConnectionHandle['rpc']['call']): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
  await ctx.plugin({ inject, apply })
  return ctx
}

describe('Client TypeRT API', () => {
  it('mounts concrete direct methods, validates both boundaries, and withdraws retained handles', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-1' } })
    const ctx = await bench(call)
    let retained: typeof ctx.api.goals.create | undefined
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => {
        scope.api.mount({ package: '@fixture/goals', descriptors: [directDescriptor()] })
        retained = scope.api.goals.create
      },
      { inject: ['api'] },
    ))
    await assembly

    await expect(ctx.api.goals.create('agent-1', { objective: 'ship' })).resolves.toEqual({ ref: 'goal-1' })
    expect(call).toHaveBeenCalledWith(
      '/api2',
      'goals/create',
      { args: { agentId: 'agent-1', request: { objective: 'ship' } } },
      expect.any(AbortSignal),
    )
    await expect(ctx.api.goals.create('', { objective: 'ship' })).rejects.toThrow('rejected "agentId"')

    call.mockResolvedValueOnce({ ok: true, value: { ref: 1 } })
    await expect(ctx.api.goals.create('agent-1', { objective: 'ship' })).rejects.toThrow('rejected "result"')

    await assembly.dispose()
    expect((ctx.api as unknown as Record<string, unknown>).goals).toBeUndefined()
    expect(ctx.get('goals')).toBeUndefined()
    expect(ctx.typert.remotes.list()).toEqual([])
    await expect(retained?.('agent-1', { objective: 'ship' })).rejects.toThrow('no longer mounted')
  })

  it('projects one direct lookup descriptor onto an Agent-scoped alias', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-2' } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-2' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
    })
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => {
        scope.api.mount({ package: '@fixture/goals', descriptors: [directDescriptor()] })
      },
      { inject: ['api'] },
    ))
    await assembly

    await expect(agentCtx.goals.create({ objective: 'ship scoped' })).resolves.toEqual({ ref: 'goal-2' })
    expect(call).toHaveBeenCalledWith(
      '/api2',
      'goals/create',
      { args: { agentId: 'agent-2', request: { objective: 'ship scoped' } } },
      expect.any(AbortSignal),
    )
    await expect((ctx as FixtureContext).goals.create({ objective: 'wrong scope' }))
      .rejects.toThrow('requires a "fixture" Context')

    await assembly.dispose()
    expect((ctx.api as unknown as Record<string, unknown>).goals).toBeUndefined()
    expect(ctx.get('goals')).toBeUndefined()
  })

  it('uses the caller Context identity for scoped namespace methods', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { renamed: true } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-2' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
    })
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => {
        scope.api.mount({ package: '@fixture/goals', descriptors: [contextDescriptor()] })
      },
      { inject: ['api'] },
    ))
    await assembly

    await expect(agentCtx.goals.rename({ objective: 'land' })).resolves.toEqual({ renamed: true })
    expect(call).toHaveBeenCalledWith(
      '/api2',
      'goals/rename',
      { args: { agentId: 'agent-2', request: { objective: 'land' } } },
      expect.any(AbortSignal),
    )
    await expect((ctx as FixtureContext).goals.rename({ objective: 'land' }))
      .rejects.toThrow('requires a "fixture" Context')

    await assembly.dispose()
    expect(ctx.get('goals')).toBeUndefined()
  })

  it('rejects weak descriptors and namespace collisions before registration', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const weak: InvocationDescriptor = {
      ...directDescriptor(),
      result: { mode: 'src-json' },
    }

    expect(() => ctx.api.mount({ package: '@fixture/weak', descriptors: [weak] }))
      .toThrow('has no strict codec')
    expect(() => ctx.api.mount({
      package: '@fixture/conflict',
      descriptors: [{ ...directDescriptor(), namespace: 'mount' }],
    })).toThrow('conflicts with the API service')
    expect(ctx.typert.remotes.list()).toEqual([])
  })

  it('throws RPC failures with the structured error as its cause', async () => {
    const rpcError = { code: 'internal' as const, message: 'host failed', details: {} }
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: false, error: rpcError }))
    ctx.api.mount({ package: '@fixture/goals', descriptors: [directDescriptor()] })

    let failure: unknown
    try {
      await ctx.api.goals.create('agent-1', { objective: 'ship' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('expected Client API invocation to fail')
    expect(failure.message).toContain('internal: host failed')
    expect(failure.cause).toBe(rpcError)
  })
})
