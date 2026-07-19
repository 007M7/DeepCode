import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { runInNewContext } from 'node:vm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentExecutionProvider from '@deepseek-ai/dsh-agent-execution'
import type { AgentExecution, AgentExecutionService } from '@deepseek-ai/dsh-agent-execution'
import { SessionId } from '@deepseek-ai/dsh-session'

function execution(id: string): AgentExecution {
  return { agent: { id: SessionId(id) } as Agent }
}

async function harness(): Promise<{
  ctx: Context
  service: AgentExecutionService
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = await ctx.plugin(AgentExecutionProvider)
  return {
    ctx,
    service: ctx.agentExecution,
    dispose: fiber.dispose,
  }
}

describe('AgentExecutionProvider', () => {
  it('reports an absent boundary and requires an active execution', async () => {
    const { service, dispose } = await harness()
    expect(service.current()).toBeUndefined()
    expect(() => service.require()).toThrow('no agent execution context is active')
    await dispose()
  })

  it('preserves exact synchronous and Promise return identities across await', async () => {
    const { service, dispose } = await harness()
    const active = execution('identity')
    const value = { result: true }
    expect(service.run(active, () => {
      expect(service.require()).toBe(active)
      return value
    })).toBe(value)

    const promise = service.run(active, async () => {
      expect(service.require()).toBe(active)
      await Promise.resolve()
      expect(service.require()).toBe(active)
      return value
    })
    expect(service.run(active, () => promise)).toBe(promise)
    await expect(promise).resolves.toBe(value)
    expect(service.current()).toBeUndefined()
    await dispose()
  })

  it('isolates overlapping executions', async () => {
    const { service, dispose } = await harness()
    const a = execution('a')
    const b = execution('b')
    const bothStarted = Promise.withResolvers<boolean>()
    const release = Promise.withResolvers<boolean>()
    let starts = 0
    const run = (active: AgentExecution): Promise<void> => service.run(active, async () => {
      expect(service.require()).toBe(active)
      starts += 1
      if (starts === 2) bothStarted.resolve(true)
      await release.promise
      expect(service.require()).toBe(active)
    })

    const pending = [run(a), run(b)]
    await bothStarted.promise
    expect(service.current()).toBeUndefined()
    release.resolve(true)
    await Promise.all(pending)
    await dispose()
  })

  it('restores nested and explicitly cleared boundaries', async () => {
    const { service, dispose } = await harness()
    const parent = execution('parent')
    const child = execution('child')

    service.run(parent, () => {
      expect(service.require()).toBe(parent)
      service.run(child, () => { expect(service.require()).toBe(child) })
      expect(service.require()).toBe(parent)
      service.run(undefined, () => {
        expect(service.current()).toBeUndefined()
        expect(() => service.require()).toThrow('no agent execution context is active')
      })
      expect(service.require()).toBe(parent)
    })
    expect(service.current()).toBeUndefined()
    await dispose()
  })

  it('restores context after synchronous throws and rejected operations', async () => {
    const { service, dispose } = await harness()
    const parent = execution('parent')
    const child = execution('child')
    const syncError = new Error('sync failure')
    const asyncError = new Error('async failure')

    service.run(parent, () => {
      expect(() => service.run(child, () => { throw syncError })).toThrow(syncError)
      expect(service.require()).toBe(parent)
    })
    await expect(service.run(child, async () => {
      await Promise.resolve()
      throw asyncError
    })).rejects.toBe(asyncError)
    expect(service.current()).toBeUndefined()
    await dispose()
  })

  it('stops new boundaries, drains active Promises, and invalidates retained references', async () => {
    const { ctx, service, dispose } = await harness()
    const active = execution('draining')
    const release = Promise.withResolvers<boolean>()
    const pending = service.run(active, async () => {
      await release.promise
      expect(service.require()).toBe(active)
    })
    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()

    expect(() => service.run(active, () => 1)).toThrow('agent execution service is disposed')
    expect(disposed).toBe(false)
    expect(ctx.get('agentExecution')).toBeUndefined()
    release.resolve(true)
    await pending
    await disposal
    expect(() => service.current()).toThrow('agent execution service is disposed')
    expect(() => service.require()).toThrow('agent execution service is disposed')
  })

  it('drains cross-realm Promise boundaries before disposal', async () => {
    const { service, dispose } = await harness()
    const active = execution('cross-realm')
    const release = Promise.withResolvers<boolean>()
    const operation = runInNewContext(
      '(async () => { await release; inspect() })',
      {
        release: release.promise,
        inspect: () => { expect(service.require()).toBe(active) },
      },
    ) as () => Promise<void>
    const pending = service.run(active, operation)
    expect(pending).not.toBeInstanceOf(Promise)

    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(true)
    await pending
    await disposal
    expect(disposed).toBe(true)
  })
})
