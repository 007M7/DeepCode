import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SubagentService from '@deepseek-ai/dsh-subagent'
import TaskService from '@deepseek-ai/dsh-tasks'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import * as mock from '@deepseek-ai/dsh-subagent-mock'
import * as tool from '../src/index.ts'
import { runOutcome, settleRun } from '../src/index.ts'

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

  it('exposes description + prompt + run_in_background to the model (no provider/type parameter)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'prompt', 'run_in_background'])
    expect(schema!.description).toContain('task_output')
  })

  it('omits run_in_background entirely when the instance disables it (schema and capability never disagree)', async () => {
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'prompt'])
    expect(schema!.description).not.toContain('task_output')
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
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('weird-child'),
        result: Promise.resolve({ output: [{ type: 'text', text: 'partial' }], stopReason: 'frobnicated' as never }),
        cancel() {},
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
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: (request) => {
        seen = request
        return {
          id: AgentId('capture-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          cancel() {},
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
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: (request) => {
        seen = request
        return {
          id: AgentId('bare-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          cancel() {},
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
    const backend = await ctx.plugin(mock, { name: 'mock' }) // spawn-shaped (inherits: false)
    await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('does not see this conversation')

    // Backend unloads (HMR shape): the tool must not outlive its provider.
    await backend.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)

    // Backend reloads with a DIFFERENT contract: the wording is re-derived
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

  it('derives spawn-shaped wording from a fresh-context provider (default mock)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('does not see this conversation')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('include everything it needs')
  })

  it('derives fork-shaped wording from an inheriting provider (the description stops lying)', async () => {
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
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('spy-child'),
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
        cancel() {},
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
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('spy-child'),
        result: Promise.resolve({ output: [], stopReason: 'error' as const }),
        cancel() {},
        dispose: async () => void disposed(),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('bridges the tool abort signal to run.cancel()', async () => {
    const cancelled = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: () => {
        let resolveResult: (r: { output: never[]; stopReason: 'aborted' }) => void
        const result = new Promise<{ output: never[]; stopReason: 'aborted' }>((res) => { resolveResult = res })
        return {
          id: AgentId('spy-child'),
          result,
          cancel: () => {
            cancelled()
            resolveResult({ output: [], stopReason: 'aborted' })
          },
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'spy' })

    const controller = new AbortController()
    const pending = callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    // Abort AFTER the tool body has had a chance to register its abort listener
    // (ctx.tools.execute now awaits the tools/pre-execute waterfall before the
    // body runs, so the listener is not registered synchronously). A few
    // microtask turns let execute() reach `addEventListener('abort')`, so this
    // exercises the LIVE onAbort bridge — distinct from the already-aborted
    // sync path the next test covers.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const result = await pending
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
  })

  it('cancels the run when the tool signal is ALREADY aborted before execute (no missed abort)', async () => {
    // `addEventListener('abort')` does not fire for a signal already aborted
    // before the listener is added, so a step cancelled before the tool ran
    // would never reach the child unless the bridge re-checks `signal.aborted`.
    // A provider that leans only on the abort EVENT (this spy never inspects
    // request.signal) proves the bridge itself must cancel.
    const cancelled = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: () => {
        let resolveResult: (r: { output: never[]; stopReason: 'aborted' }) => void
        const result = new Promise<{ output: never[]; stopReason: 'aborted' }>((res) => { resolveResult = res })
        return {
          id: AgentId('spy-child'),
          result,
          cancel: () => {
            cancelled()
            resolveResult({ output: [], stopReason: 'aborted' })
          },
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'spy' })

    const controller = new AbortController()
    controller.abort() // already aborted BEFORE the tool runs
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    expect(cancelled).toHaveBeenCalledTimes(1)
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
})

describe('dsh-tool-subagent background mode', () => {
  /** A parent agent carrying a real session token, registered in ctx.agents (owner-cleanup wiring requires a live registry entry). */
  function ownerAgent(ctx: Context, sessionId: string, inject: (...args: unknown[]) => void = () => {}): Agent {
    const agent = { id: AgentId(`agent-${sessionId}`), inject, session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as unknown as Agent
    ctx.agents.register(agent)
    return agent
  }

  async function backgroundSetup(toolConfig: tool.Config, mockConfig: Partial<mock.Config> = {}) {
    const ctx = await setup(toolConfig, mockConfig)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TaskService)
    await ctx.plugin(ToolTasks, {})
    return ctx
  }

  it('returns a task id immediately and the answer is collected through task_output', async () => {
    const ctx = await backgroundSetup({ provider: 'mock', agentOptions: { model: 'child-model' } }, { reply: 'background answer' })
    const parent = ownerAgent(ctx, 'sess-parent')

    const start = await callSubagent(ctx, { description: 'deep research', prompt: 'dig in', run_in_background: true }, { agent: parent })
    expect(start.isError).toBe(false)
    expect(text(start)).toBe('started background subagent task subagent-1')

    const collected = await ctx.tools.execute({
      callId: CallId('collect-1'),
      name: 'task_output',
      arguments: { task_id: 'subagent-1', wait: true },
      agent: parent,
    })
    expect(text(collected)).toBe('background answer\n[status: completed]')

    // Final-output reads are idempotent (not consumed).
    const again = await ctx.tools.execute({
      callId: CallId('collect-2'),
      name: 'task_output',
      arguments: { task_id: 'subagent-1' },
      agent: parent,
    })
    expect(text(again)).toBe('background answer\n[status: completed]')
  })

  it('fails loud when the tasks runtime is not loaded', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', run_in_background: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('background tasks unavailable: load @deepseek-ai/dsh-tasks')
  })

  it('refuses to start when the tool signal is already aborted', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' })
    const parent = ownerAgent(ctx, 'sess-parent')
    const controller = new AbortController()
    controller.abort()
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', run_in_background: true }, { agent: parent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent delegation aborted')
  })

  it('forwards task_kill reasons to run.cancel (and defaults one when absent)', async () => {
    // A provider whose runs settle only on cancel — the mock settles on a
    // microtask, too fast to observe a LIVE kill through the real tools.
    const ctx = await backgroundSetup({ provider: 'mock', agentOptions: { model: 'child-model' } })
    const parent = ownerAgent(ctx, 'sess-parent')
    const cancels: (string | undefined)[] = []
    ctx.subagents.registerProvider({
      name: 'hanging',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: () => {
        let settle!: (value: { output: { type: 'text'; text: string }[]; stopReason: 'aborted' }) => void
        return {
          id: AgentId(`hang-${cancels.length}`),
          result: new Promise((res) => { settle = res }),
          cancel(reason?: string) { cancels.push(reason); settle({ output: [], stopReason: 'aborted' }) },
          dispose: () => Promise.resolve(),
        }
      },
    })
    // Direct apply (schema bypass): schemastery would default agentOptions to
    // an (truthy) empty object — the raw config exercises the omitted branch
    // on the background start request.
    tool.apply(ctx, { provider: 'hanging', toolName: 'subagent_hang' })

    const startOne = await ctx.tools.execute({ callId: CallId('h1'), name: 'subagent_hang', arguments: { description: 'one', prompt: 'p', run_in_background: true }, agent: parent })
    const startTwo = await ctx.tools.execute({ callId: CallId('h2'), name: 'subagent_hang', arguments: { description: 'two', prompt: 'p', run_in_background: true }, agent: parent })
    expect(text(startOne)).toBe('started background subagent task subagent-1')
    expect(text(startTwo)).toBe('started background subagent task subagent-2')

    const withReason = await ctx.tools.execute({ callId: CallId('k1'), name: 'task_kill', arguments: { task_id: 'subagent-1', reason: 'superseded' }, agent: parent })
    const withoutReason = await ctx.tools.execute({ callId: CallId('k2'), name: 'task_kill', arguments: { task_id: 'subagent-2' }, agent: parent })
    expect(text(withReason)).toBe('requested cancellation of task subagent-1')
    expect(text(withoutReason)).toBe('requested cancellation of task subagent-2')
    expect(cancels).toEqual(['superseded', 'background subagent task killed'])

    // The aborted children settle as killed tasks.
    const killed = await ctx.tools.execute({ callId: CallId('w1'), name: 'task_output', arguments: { task_id: 'subagent-1', wait: true }, agent: parent })
    expect(text(killed)).toBe('(no new output)\n[status: killed]')
  })

  it('runOutcome maps the stop-reason vocabulary onto task outcomes', () => {
    const output = [{ type: 'text' as const, text: 'partial' }]
    expect(runOutcome({ output, stopReason: 'completed' })).toEqual({ status: 'completed', output: 'partial' })
    expect(runOutcome({ output, stopReason: 'aborted' })).toEqual({ status: 'killed' })
    expect(runOutcome({ output, stopReason: 'error' })).toEqual({ status: 'failed', detail: 'error' })
    expect(runOutcome({ output, stopReason: 'max-tokens' })).toEqual({ status: 'failed', detail: 'max-tokens' })
    expect(runOutcome({ output, stopReason: 'refusal' })).toEqual({ status: 'failed', detail: 'refusal' })
    // Merge-extensible: an unknown reason is failed-with-detail, never success.
    expect(runOutcome({ output, stopReason: 'paused' as never })).toEqual({ status: 'failed', detail: 'paused' })
  })

  it('settleRun disposes the run before reporting, on both result paths', async () => {
    const order: string[] = []
    const completed = await settleRun({
      id: AgentId('child-1'),
      result: Promise.resolve({ output: [{ type: 'text' as const, text: 'ok' }], stopReason: 'completed' as const }),
      cancel() {},
      dispose() { order.push('dispose'); return Promise.resolve() },
    })
    order.push('reported')
    expect(completed).toEqual({ status: 'completed', output: 'ok' })
    expect(order).toEqual(['dispose', 'reported'])

    // An infrastructure rejection still disposes and reports failed.
    let disposed = false
    const failed = await settleRun({
      id: AgentId('child-2'),
      result: Promise.reject(new Error('transport gone')),
      cancel() {},
      dispose() { disposed = true; return Promise.resolve() },
    })
    expect(failed).toEqual({ status: 'failed', detail: 'Error: transport gone' })
    expect(disposed).toBe(true)
  })
})

describe('background registration failure (no orphaned child)', () => {
  it('cancels and disposes the just-started run when register() throws', async () => {
    // TaskService is loaded but NO control surface is attached, so
    // ctx.tasks.register throws AFTER the provider run already started.
    const ctx = await setup({ provider: 'mock' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TaskService)
    const parent = { id: AgentId('agent-sess-p'), inject: () => {}, session: { header: { version: 0, id: 'sess-p', createdAt: 0 } } } as unknown as Agent
    ctx.agents.register(parent)

    const events: string[] = []
    ctx.subagents.registerProvider({
      name: 'probe',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false },
      inheritsParentContext: false,
      start: () => {
        let settle!: (value: { output: never[]; stopReason: 'aborted' }) => void
        return {
          id: AgentId('probe-child'),
          result: new Promise((res) => { settle = res }),
          cancel(reason?: string) { events.push(`cancel:${reason}`); settle({ output: [], stopReason: 'aborted' }) },
          dispose() { events.push('dispose'); return Promise.resolve() },
        }
      },
    })
    tool.apply(ctx, { provider: 'probe', toolName: 'subagent_probe' })

    const result = await ctx.tools.execute({
      callId: CallId('probe-1'),
      name: 'subagent_probe',
      arguments: { description: 'd', prompt: 'p', run_in_background: true },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no control surface is attached')
    // The child was cancelled AND disposed before the call settled — the
    // model never got an id, so nothing else could ever collect or kill it.
    expect(events).toEqual(['cancel:background task registration failed', 'dispose'])
  })
})
