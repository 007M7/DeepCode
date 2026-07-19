import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import SubagentService, {
  SubagentError,
  assertSubagentMaxDepth,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

function fakeParent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

const ALL_CAPS: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
const NO_CAPS: SubagentCapabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }

function baseRequest(overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'do a thing' }],
    parent: fakeParent(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

class StubProvider implements SubagentProvider {
  readonly inheritsParentContext = false
  startCount = 0

  constructor(
    readonly name: string,
    readonly capabilities: SubagentCapabilities = ALL_CAPS,
    private readonly outcome: SubagentResult = {
      output: [{ type: 'text', text: 'ok' }],
      stopReason: 'completed',
    },
  ) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.startCount += 1
    return {
      id: SessionId(`child:${this.name}:${request.parent.id}`),
      localAgent: undefined,
      result: Promise.resolve(this.outcome),
      async dispose() {},
    }
  }
}

async function service(): Promise<{ ctx: Context; subagents: SubagentService }> {
  const ctx = new Context()
  await ctx.plugin(SubagentService)
  return { ctx, subagents: ctx.subagents }
}

describe('SubagentService', () => {
  it('registers, lists, looks up, starts, and removes providers', async () => {
    const { ctx, subagents } = await service()
    const added: string[] = []
    const removed: string[] = []
    ctx.on('subagent/provider-added', provider => void added.push(provider.name))
    ctx.on('subagent/provider-removed', name => void removed.push(name))
    const provider = new StubProvider('alpha')

    const dispose = subagents.registerProvider(provider)
    expect(subagents.list()).toEqual(['alpha'])
    expect(subagents.getProvider('alpha')).toBe(provider)
    const run = await subagents.start('alpha', baseRequest())
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(provider.startCount).toBe(1)

    dispose()
    expect(added).toEqual(['alpha'])
    expect(removed).toEqual(['alpha'])
    expect(subagents.getProvider('alpha')).toBeUndefined()
  })

  it('rolls registration back when provider-added throws', async () => {
    const { ctx, subagents } = await service()
    ctx.on('subagent/provider-added', () => { throw new Error('added boom') })
    expect(() => { subagents.registerProvider(new StubProvider('alpha')) }).toThrow('added boom')
    expect(subagents.getProvider('alpha')).toBeUndefined()
  })

  it('rejects duplicate and absent provider names with typed errors', async () => {
    const { subagents } = await service()
    subagents.registerProvider(new StubProvider('dup'))
    expect(() => { subagents.registerProvider(new StubProvider('dup')) })
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROVIDER' }))
    await expect(subagents.start('missing', baseRequest()))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it.each([
    ['outputSchema', { outputSchema: { type: 'object', properties: {} } }],
    ['depthLimit', { maxDepth: 1 }],
    ['toolFilter', { toolFilter: { deny: ['bash'] } }],
    ['persona', { persona: 'reviewer' }],
  ] as const)('rejects unsupported %s before provider startup', async (_capability, override) => {
    const { subagents } = await service()
    const provider = new StubProvider('weak', NO_CAPS)
    subagents.registerProvider(provider)
    await expect(subagents.start('weak', baseRequest(override)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(provider.startCount).toBe(0)
  })

  it('validates depth and schema semantics before provider startup', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('strong')
    subagents.registerProvider(provider)
    await expect(subagents.start('strong', baseRequest({ maxDepth: -1 })))
      .rejects.toThrow('non-negative safe integer')
    await expect(subagents.start('strong', baseRequest({ outputSchema: { type: 'string' } as never })))
      .rejects.toThrow()
    expect(provider.startCount).toBe(0)
    expect(() => { assertSubagentMaxDepth(undefined) }).not.toThrow()
  })

  it('publishes lifecycle only after async provider start and keeps parent scope', async () => {
    const { ctx, subagents } = await service()
    const ready = Promise.withResolvers<SubagentRun>()
    const result = Promise.withResolvers<SubagentResult>()
    subagents.registerProvider({
      name: 'deferred',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ready.promise,
    })
    const parent = fakeParent('delegator')
    const events: string[] = []
    const keys: unknown[] = []
    const runIds: string[] = []
    ctx.on('subagent/start', function (info) { events.push('start'); keys.push(carrierKeyOf(this)); runIds.push(info.runId) })
    ctx.on('subagent/end', function (info) { events.push('end'); keys.push(carrierKeyOf(this)); runIds.push(info.runId) })

    const starting = subagents.start('deferred', baseRequest({ parent }))
    await Promise.resolve()
    expect(events).toEqual([])
    ready.resolve({ id: SessionId('child'), localAgent: undefined, result: result.promise, async dispose() {} })
    const run = await starting
    expect(events).toEqual(['start'])
    result.resolve({ output: [{ type: 'text', text: 'answer' }], stopReason: 'completed' })
    await run.result
    await Promise.resolve()
    expect(events).toEqual(['start', 'end'])
    expect(keys).toEqual([parent, parent])
    expect(runIds[0]).toBe(runIds[1])
  })

  it('mints distinct lifecycle identities when provider and child ids repeat', async () => {
    const { ctx, subagents } = await service()
    subagents.registerProvider(new StubProvider('reused'))
    const runIds: string[] = []
    ctx.on('subagent/start', info => void runIds.push(info.runId))

    const first = await subagents.start('reused', baseRequest())
    const second = await subagents.start('reused', baseRequest())
    await Promise.all([first.result, second.result])

    expect(runIds).toHaveLength(2)
    expect(new Set(runIds).size).toBe(2)
  })

  it('emits no run lifecycle when provider startup rejects', async () => {
    const { ctx, subagents } = await service()
    subagents.registerProvider({
      name: 'failed',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: async () => { throw new Error('setup rolled back') },
    })
    const lifecycle = vi.fn()
    ctx.on('subagent/start', lifecycle)
    ctx.on('subagent/end', lifecycle)
    await expect(subagents.start('failed', baseRequest())).rejects.toThrow('setup rolled back')
    expect(lifecycle).not.toHaveBeenCalled()
  })

  it('emits an enriched end event and maps result rejection to error telemetry', async () => {
    const { ctx, subagents } = await service()
    const completed = new StubProvider('completed', NO_CAPS, {
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    subagents.registerProvider(completed)
    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const run = await subagents.start('completed', baseRequest())
    await run.result
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    }))

    const failure = Promise.withResolvers<SubagentResult>()
    subagents.registerProvider({
      name: 'infra',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      async start() {
        return { id: SessionId('infra-child'), localAgent: undefined, result: failure.promise, async dispose() {} }
      },
    })
    const failedRun = await subagents.start('infra', baseRequest())
    failure.reject(new Error('transport'))
    await expect(failedRun.result).rejects.toThrow('transport')
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ provider: 'infra', stopReason: 'error' }))
  })

  it('contains synchronous and asynchronous lifecycle observer failures', async () => {
    const { ctx, subagents } = await service()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => void warnings.push(String(message))) as typeof ctx.logger.warn
    const heard: string[] = []
    ctx.on('subagent/provider-removed', () => { throw new Error('sync boom') })
    // Runtime listeners may return thenables even though the declaration's observable result is void.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- exercises rejected-listener containment
    ctx.on('subagent/provider-removed', async () => { throw new Error('async boom') })
    ctx.on('subagent/provider-removed', () => { throw { toString: () => { throw new Error('coercion') } } })
    ctx.on('subagent/provider-removed', name => void heard.push(name))
    const dispose = subagents.registerProvider(new StubProvider('contained'))

    dispose()
    await Promise.resolve()
    expect(heard).toEqual(['contained'])
    expect(warnings.some(message => message.includes('sync boom'))).toBe(true)
    expect(warnings.some(message => message.includes('async boom'))).toBe(true)
    expect(warnings.some(message => message.includes('<unrenderable thrown value>'))).toBe(true)
  })

  it('SubagentError participates in the harness error taxonomy', () => {
    const error = new SubagentError('boom', 'NO_PROVIDER')
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.name).toBe('SubagentError')
    expect(error.code).toBe('NO_PROVIDER')
  })
})
