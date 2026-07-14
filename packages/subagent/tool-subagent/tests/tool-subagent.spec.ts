import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as mock from '@deepseek-ai/dsh-subagent-mock'
import * as tool from '../src/index.ts'

/**
 * Drives the REAL plugin body: mounts `dsh-tool-subagent` on a real
 * `ToolRegistry` + `SubagentService`, with the real `dsh-subagent-mock` as the
 * backend, and invokes the registered `subagent` tool through
 * `ctx.tools.execute`. The mock is the genuine collaborator (we mock only the
 * "child agent", the expensive/non-deterministic boundary) — everything
 * downstream of the tool is the shipping code path.
 */

/** A minimal parent Agent — the tool reads `agent.id` for `parent`. */
function fakeAgent(id = 'parent-1'): Agent {
  return { id: AgentId(id) } as unknown as Agent
}

async function setup(toolConfig: tool.Config, mockConfig: Partial<mock.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(SubagentService)
  await ctx.plugin(mock, { name: 'mock', ...mockConfig })
  await ctx.plugin(tool, toolConfig)
  return ctx
}

let callCounter = 0
function callSubagent(ctx: Context, args: unknown, over: { agent?: Agent | undefined; signal?: AbortSignal } = {}) {
  // Distinguish "no override" (use a default agent) from an explicit
  // `{ agent: undefined }` (test the no-agent path). Under
  // exactOptionalPropertyTypes the key is omitted rather than set to undefined.
  const agent = 'agent' in over ? over.agent : fakeAgent()
  return ctx.tools.execute({
    callId: CallId(`call-${++callCounter}`),
    name: 'subagent',
    arguments: args,
    ...agent ? { agent } : {},
    ...over.signal ? { signal: over.signal } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-subagent', () => {
  it('registers a `subagent` tool that delegates to the configured provider and returns its output', async () => {
    const ctx = await setup({ provider: 'mock' }, { reply: 'child says hi' })
    const result = await callSubagent(ctx, { description: 'do a thing', prompt: 'go research X' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('child says hi')
  })

  it('exposes only description + prompt to the model (no provider/type parameter)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'prompt'])
  })

  it.each([
    { stopReason: 'aborted' as const, fragment: 'cancelled' },
    { stopReason: 'error' as const, fragment: 'failed' },
    { stopReason: 'max-tokens' as const, fragment: 'token limit' },
    { stopReason: 'refusal' as const, fragment: 'declined' },
  ])('maps stop reason $stopReason to an isError result (not partial success)', async ({ stopReason, fragment }) => {
    const ctx = await setup({ provider: 'mock' }, { stopReason })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('registers under a configurable toolName so multiple providers can coexist', async () => {
    // The defining multi-provider use case: two loads, two distinct tool names,
    // each bound to a different provider — the tool registry rejects duplicate
    // names, so a configurable name is what makes this work.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    await ctx.plugin(mock, { name: 'spawn', reply: 'from spawn' })
    await ctx.plugin(mock, { name: 'acp', reply: 'from acp' })
    await ctx.plugin(tool, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(tool, { provider: 'acp', toolName: 'subagent_acp' })

    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('subagent')).sort()
    expect(names).toEqual(['subagent', 'subagent_acp'])

    const viaSpawn = await ctx.tools.execute({ callId: CallId('c-spawn'), name: 'subagent', arguments: { description: 'd', prompt: 'p' }, agent: fakeAgent() })
    const viaAcp = await ctx.tools.execute({ callId: CallId('c-acp'), name: 'subagent_acp', arguments: { description: 'd', prompt: 'p' }, agent: fakeAgent() })
    expect(text(viaSpawn)).toBe('from spawn')
    expect(text(viaAcp)).toBe('from acp')
  })

  it('treats an unknown (plugin-added) stop reason as an isError result', async () => {
    // SubagentStopReason is merge-extensible; the tool's stopReasonError default
    // arm must treat an unrecognized terminal reason as a failure, not success.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'weird',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: AgentId('weird-child'),
        result: Promise.resolve({ output: [{ type: 'text', text: 'partial' }], stopReason: 'frobnicated' as never }),
        dispose: async () => {},
      }),
    })
    await ctx.plugin(tool, { provider: 'weird' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('abnormally')
  })

  it('forwards configured agentOptions into the start request', async () => {
    // Cover the `config.agentOptions ? … : {}` spread: a provider that captures
    // the request lets us assert the agentOptions reached it.
    let seen: { agentOptions?: { model?: string } } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'capture',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: AgentId('capture-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture', agentOptions: { model: 'child-model' } })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.agentOptions).toEqual({ model: 'child-model' })
  })

  it('defaults toolName and omits agentOptions when apply() is called directly (schema bypass)', async () => {
    // `ctx.plugin` validates+defaults config first (toolName→'subagent', the
    // agentOptions object→{}), so the runtime `?? 'subagent'` fallback and the
    // no-agentOptions branch are only reachable via a direct apply() that
    // bypasses schemastery — the same pattern acp-agent uses for its defaults.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'bare',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: AgentId('bare-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    // Direct apply with only `provider` — no toolName, no agentOptions.
    tool.apply(ctx, { provider: 'bare' })
    await new Promise(r => setTimeout(r, 10))

    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.agentOptions).toBeUndefined()
  })

  it('fails loud when invoked without a calling agent', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('registers when the provider appears LATER — no load-order requirement (Loader starts siblings concurrently)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    // Tool first: no provider yet — the tool must be absent, not broken.
    // Direct apply (schema bypass): also covers the waiting-note's default
    // toolName fallback, which validated config pre-fills.
    tool.apply(ctx, { provider: 'mock' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    // Backend arrives (as a delayed sibling fiber would): the tool appears.
    await ctx.plugin(mock, { name: 'mock', reply: 'late but fine' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(text(result)).toBe('late but fine')
  })

  it('mirrors the provider lifecycle: gone on backend dispose, re-derived wording on re-registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    const backend = await ctx.plugin(mock, { name: 'mock' }) // fresh conversation (descriptor: false)
    await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('does not see this conversation')

    // Backend unloads (HMR shape): the tool must not outlive its provider.
    await backend.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)

    // Backend reloads with a DIFFERENT conversation-history descriptor: the wording is re-derived
    // from the fresh provider, not served stale from the first mount.
    await ctx.plugin(mock, { name: 'mock', inheritsParentContext: true })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('INHERITS this conversation')
  })

  it('the tool PLUGIN fiber owns its lifecycle listeners: disposal unmounts, and a disposed fiber never zombie-mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)

    // Arm 1: a mounted tool dies with its plugin fiber; the provider survives.
    await ctx.plugin(mock, { name: 'mock' })
    const mounted = await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    await mounted.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    expect(ctx.subagents.getProvider('mock')).toBeDefined()

    // Arm 2: a fiber disposed while WAITING must not react to the provider
    // arriving later — a surviving listener would re-register a tool that no
    // live plugin owns (the zombie mount).
    const waiting = await ctx.plugin(tool, { provider: 'later', toolName: 'subagent_later' })
    await waiting.dispose()
    await ctx.plugin(mock, { name: 'later' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent_later')).toBe(false)
  })

  it('ignores lifecycle events for OTHER providers', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    await ctx.plugin(mock, { name: 'mock' })
    await ctx.plugin(tool, { provider: 'mock' })
    // An unrelated provider registering (added-event with another name) and
    // unregistering (removed-event with another name) must not touch the tool.
    const other = await ctx.plugin(mock, { name: 'other', inheritsParentContext: true })
    expect(ctx.tools.schemas().filter(s => s.name === 'subagent')).toHaveLength(1)
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('does not see this conversation')
    await other.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
  })

  it('derives spawn-shaped wording from a fresh-conversation provider (default mock)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('does not see this conversation')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('include everything it needs')
  })

  it('derives fork-shaped wording from a seeded-conversation provider (the description stops lying)', async () => {
    const ctx = await setup({ provider: 'mock', toolName: 'subagent' }, { inheritsParentContext: true })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('INHERITS this conversation')
    expect(schema.description).not.toContain('does not see this conversation')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('completed turns')
  })

  it('disposes the run on the success path (no leaked child)', async () => {
    // Spy on the provider's run.dispose via a wrapping provider registered
    // directly on the service, then point the tool at it.
    const disposed = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: AgentId('spy-child'),
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
        dispose: async () => void disposed(),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy' })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('disposes the run on the error path too', async () => {
    const disposed = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: AgentId('spy-child'),
        result: Promise.resolve({ output: [], stopReason: 'error' as const }),
        dispose: async () => void disposed(),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('passes the tool abort signal as the provider cancellation channel', async () => {
    const cancelled = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        if (request.signal.aborted) throw new Error('start aborted')
        let resolveResult: (r: { output: never[]; stopReason: 'aborted' }) => void
        const result = new Promise<{ output: never[]; stopReason: 'aborted' }>((res) => { resolveResult = res })
        request.signal.addEventListener('abort', () => {
          cancelled()
          resolveResult({ output: [], stopReason: 'aborted' })
        }, { once: true })
        return {
          id: AgentId('spy-child'),
          result,
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'spy' })

    const controller = new AbortController()
    const pending = callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    // Let provider.start install its listener before aborting.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const result = await pending
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
  })

  it('passes an already-aborted signal so provider startup rejects', async () => {
    const sawAborted = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        if (request.signal.aborted) sawAborted()
        throw new Error('start aborted')
      },
    })
    await ctx.plugin(tool, { provider: 'spy' })

    const controller = new AbortController()
    controller.abort() // already aborted BEFORE the tool runs
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    expect(sawAborted).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
  })

  it('tools depend on the service: no `subagent` tool without ctx.subagents', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    // No SubagentService mounted. The tool injects ['tools','subagents'] so its
    // apply never runs; the tool is absent rather than half-registered.
    let booted = true
    try {
      await ctx.plugin(tool, { provider: 'mock' })
      await new Promise(r => setTimeout(r, 20))
    } catch {
      booted = false
    }
    // Either it never booted, or it booted but registered no tool.
    const present = ctx.get('tools')?.schemas().some(s => s.name === 'subagent') ?? false
    expect(booted && present).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    // Postmortem 0001 guard: this plugin HAS `inject = ['tools','subagents']`, so
    // a stray `export default apply` would collapse the module via
    // `unwrapExports` (`exports.default ?? exports`), DROP `inject`, and crash at
    // load with "cannot get property … without inject". Guard the shape directly.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent')
    expect(tool.inject).toEqual(['tools', 'subagents'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-subagent')
    expect(unwrapped.inject).toEqual(['tools', 'subagents'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })

  it('passes persona/toolFilter/maxDepth config through to the start request', async () => {
    let seen: { persona?: string; toolFilter?: unknown; maxDepth?: number } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'capture2',
      capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: AgentId('capture2-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, {
      provider: 'capture2',
      persona: 'You are the child.',
      toolFilter: { deny: ['subagent'] },
      maxDepth: 2,
    })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.persona).toBe('You are the child.')
    expect(seen?.toolFilter).toMatchObject({ deny: ['subagent'] })
    expect(seen?.maxDepth).toBe(2)
  })

  it.each([
    { label: 'null', value: null as unknown as number },
    { label: 'a string', value: '1' as unknown as number },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'a negative integer', value: -1 },
    { label: 'a fractional number', value: 1.5 },
    { label: 'negative zero', value: -0 },
    { label: 'an unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects maxDepth=$label when the plugin loads', async ({ value }) => {
    await expect(setup({ provider: 'mock', maxDepth: value }))
      .rejects.toThrow()
  })

  it('validates maxDepth when apply() is invoked directly without Schemastery', () => {
    const ctx = new Context()
    expect(() => {
      tool.apply(ctx, {
        provider: 'unused',
        maxDepth: Number.NaN,
      })
    }).toThrow('subagent maxDepth must be a non-negative safe integer')
  })

  it('a partial toolFilter (deny only) does not materialize an empty allow-list (deny-all trap)', async () => {
    let seen: { toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'capture3',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: AgentId('capture3-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture3', toolFilter: { deny: ['subagent'] } })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.toolFilter).toEqual({ deny: ['subagent'] })
    expect(seen?.toolFilter).not.toHaveProperty('allow')
  })

  it('an omitted agentOptions does not materialize an empty object onto the request', async () => {
    // Same schemastery trap as toolFilter, adjacent field: an omitted
    // `agentOptions` config key materializes `{}` without the forced default,
    // which reads as present and puts a dishonest `agentOptions: {}` on every
    // start request.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'capture4',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: AgentId('capture4-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture4' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen).toBeDefined()
    expect(seen).not.toHaveProperty('agentOptions')
  })

  it('an explicit empty toolFilter fails at plugin load, not at first delegation', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'p',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: () => { throw new Error('unreachable') },
    })
    const fiber = ctx.plugin(tool, { provider: 'p', toolFilter: {} })
    await expect(fiber).rejects.toThrow(/names neither `allow` nor `deny`/)
  })
})
