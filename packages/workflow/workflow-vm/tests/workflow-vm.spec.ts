import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { WorkflowResult, WorkflowResultInfo, WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import * as vmEngineModule from '../src/index.ts'
import VmWorkflowEngine, { type Config } from '../src/index.ts'

/** A minimal parent stand-in: the engine only threads it through to the provider. */
function fakeParent(): Agent {
  return { id: AgentId('workflow-parent'), options: {} } as unknown as Agent
}

/** One controllable child run: the test (or auto mode) settles it. */
interface ControlledRun {
  request: SubagentStartRequest
  settle(result: SubagentResult): void
  cancelled: string | undefined
  disposed: boolean
}

/**
 * A scripted in-test provider over the REAL SubagentService registry: `auto`
 * settles each run via the reply function on a microtask; `manual` piles runs
 * up in `runs` for the test to settle (concurrency/cancellation tests). A run
 * aborts (settles `aborted`) when the request signal fires, like the real
 * in-process backends.
 */
class StubProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true }
  // Context contract: stub children start fresh, mirroring the spawn backend.
  readonly inheritsParentContext = false
  readonly runs: ControlledRun[] = []

  constructor(
    readonly name: string,
    private readonly reply?: (request: SubagentStartRequest, index: number) => SubagentResult,
    private readonly disposeDelayMs = 0,
  ) {}

  start(request: SubagentStartRequest): SubagentRun {
    let settle!: (result: SubagentResult) => void
    const result = new Promise<SubagentResult>((resolve) => { settle = resolve })
    const controlled: ControlledRun = { request, settle, cancelled: undefined, disposed: false }
    this.runs.push(controlled)
    const index = this.runs.length - 1
    request.signal?.addEventListener('abort', () => { settle({ output: [], stopReason: 'aborted' }) }, { once: true })
    if (this.reply) {
      const reply = this.reply
      queueMicrotask(() => { settle(reply(request, index)) })
    }
    return {
      id: AgentId(`stub-child-${index}`),
      result,
      cancel: (reason?: string) => {
        controlled.cancelled = reason ?? 'cancelled'
        settle({ output: [], stopReason: 'aborted' })
      },
      dispose: () => {
        if (this.disposeDelayMs === 0) {
          controlled.disposed = true
          return Promise.resolve()
        }
        // A slow-winding child (quiescence tests): disposal completes late.
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controlled.disposed = true
            resolve()
          }, this.disposeDelayMs)
        })
      },
    }
  }
}

/** Text-reply helper for auto providers. */
function text(reply: string): SubagentResult {
  return { output: [{ type: 'text', text: reply }], stopReason: 'completed' }
}

interface SetupOptions {
  config?: Config
  reply?: (request: SubagentStartRequest, index: number) => SubagentResult
  manual?: boolean
  disposeDelayMs?: number
}

async function setup(options?: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(SubagentService)
  const provider = new StubProvider(
    'stub',
    options?.manual ? undefined : options?.reply ?? (() => text('stub reply')),
    options?.disposeDelayMs ?? 0,
  )
  ctx.subagents.registerProvider(provider)
  // A fixed concurrency ceiling: the auto-resolved default is machine-derived
  // (cores - 2, floored at 1), so tests that expect N children in flight
  // would wedge on small CI runners. Tests about the ceiling override it.
  await ctx.plugin(VmWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 8, ...options?.config })
  return { ctx, provider, parent: fakeParent() }
}

/** Wrap a body in the minimal valid meta header. */
function script(body: string, metaExtra = ''): string {
  return `export const meta = { name: 'test-flow', description: 'a test workflow'${metaExtra} }\n${body}`
}

/** Start + await one run, disposing on the way out. */
async function run(ctx: Context, parent: Agent, source: string, args?: unknown): Promise<WorkflowResult> {
  const handle = ctx.workflows.start({ script: source, parent, ...args !== undefined ? { args } : {} })
  try {
    return await handle.result
  } finally {
    await handle.dispose()
  }
}

describe('dsh-workflow-vm', () => {
  describe('script execution', () => {
    it('runs a script end-to-end: agent() text results, phases, log, args, return value', async () => {
      const { ctx, parent, provider } = await setup({ reply: (_request, index) => text(`answer-${index}`) })
      const events: [string, unknown[]][] = []
      for (const name of ['workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
        ctx.on(name, (...payload: unknown[]) => { events.push([name, payload]) })
      }
      const result = await run(ctx, parent, script(`
        phase('Scan')
        log('starting with ' + args.files.length + ' files')
        const answers = await pipeline(args.files, (prev, item) => agent('read ' + item))
        phase('Report')
        return { answers, count: args.files.length }
      `, ", phases: [{ title: 'Scan' }, { title: 'Report' }]"), { files: ['a.ts', 'b.ts'] })

      expect(result.stopReason).toBe('completed')
      expect(result.agentsStarted).toBe(2)
      expect(result.value).toEqual({ answers: ['answer-0', 'answer-1'], count: 2 })
      expect(provider.runs.every(r => r.disposed)).toBe(true)

      const names = events.map(([name]) => name)
      expect(names[0]).toBe('workflow/start')
      expect(names).toContain('workflow/phase')
      expect(names).toContain('workflow/log')
      expect(names.at(-1)).toBe('workflow/end')
      const info = events[0]![1][0] as WorkflowRunInfo
      expect(info.meta.name).toBe('test-flow')
      const end = events.at(-1)![1][1] as Record<string, unknown>
      expect(end).toEqual({ stopReason: 'completed', agentsStarted: 2 })
      expect('value' in end).toBe(false)
    })

    it('agent-start/end events carry seq, label (defaulted from the prompt), phase, and outcome', async () => {
      const { ctx, parent } = await setup()
      const starts: unknown[] = []
      const ends: unknown[] = []
      ctx.on('workflow/agent-start', (_info, agent) => starts.push(agent))
      ctx.on('workflow/agent-end', (_info, agent) => ends.push(agent))
      await run(ctx, parent, script(`
        phase('Find')
        await agent('a prompt that is quite long and will surely get truncated down to a display label\\n'
          + 'with a second line the label must not include')
        await agent('short', { label: 'named', phase: 'Custom' })
        return null
      `))
      expect(starts[0]).toMatchObject({ seq: 1, phase: 'Find', childId: 'stub-child-0' })
      expect((starts[0] as { label: string }).label.length).toBeLessThanOrEqual(48)
      expect((starts[0] as { label: string }).label).not.toContain('second line')
      expect(starts[1]).toMatchObject({ seq: 2, label: 'named', phase: 'Custom' })
      expect(ends[0]).toMatchObject({ seq: 1, outcome: 'completed' })
    })

    it('agent({schema}) forwards outputSchema to the provider and returns the structured value into the realm', async () => {
      const { ctx, parent, provider } = await setup({
        reply: () => ({ output: [], structured: { files: ['x.ts', 'y.ts'] }, stopReason: 'completed' }),
      })
      const result = await run(ctx, parent, script(`
        const found = await agent('list files', { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } })
        return { first: found.files[0], count: found.files.length }
      `))
      expect(result.value).toEqual({ first: 'x.ts', count: 2 })
      expect(provider.runs[0]!.request.outputSchema).toEqual({
        type: 'object',
        properties: { files: { type: 'array', items: { type: 'string' } } },
        required: ['files'],
      })
    })

    it('model option maps to agentOptions.model on the start request', async () => {
      const { ctx, parent, provider } = await setup()
      await run(ctx, parent, script("return await agent('p', { model: 'deepseek-v4-pro' })"))
      expect(provider.runs[0]!.request.agentOptions).toEqual({ model: 'deepseek-v4-pro' })
    })

    it('a failed child resolves null (scripts filter), never throwing into the script', async () => {
      const { ctx, parent } = await setup({
        reply: (_request, index) => index === 0 ? { output: [], stopReason: 'error' } : text('ok'),
      })
      const result = await run(ctx, parent, script(`
        const results = await parallel([() => agent('one'), () => agent('two')])
        return results
      `))
      expect(result.value).toEqual([null, 'ok'])
    })

    it('a schema run that completes WITHOUT a structured value is a child failure (null + failed outcome)', async () => {
      const { ctx, parent } = await setup({ reply: () => text('prose, no structure') })
      const ends: unknown[] = []
      ctx.on('workflow/agent-end', (_info, agent) => ends.push(agent))
      const result = await run(ctx, parent, script(`
        return await agent('p', { schema: { type: 'object' } })
      `))
      expect(result.value).toBeNull()
      expect(ends[0]).toMatchObject({ outcome: 'failed' })
    })

    it('a script with no return value resolves value: null', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script("await agent('p')"))
      expect(result.stopReason).toBe('completed')
      expect(result.value).toBeNull()
    })

    it('a returned promise/thenable resolves per async-JS semantics before materialization', async () => {
      const { ctx, parent } = await setup()
      // Load-bearing ergonomics: forgetting await on the final hook call works.
      expect((await run(ctx, parent, script("return agent('x')"))).value).toBe('stub reply')
      // A hand-built thenable is assimilated by the async return — the
      // RESOLUTION is the script's return value (standard JavaScript), and the
      // realm-boundary guard applies to that resolution, not the thenable.
      expect((await run(ctx, parent, script('return { value: 1, then(resolve) { resolve({ ok: true }) } }'))).value).toEqual({ ok: true })
      const nonJson = await run(ctx, parent, script('return { then(resolve) { resolve({ bad: new Date(0) }) } }'))
      expect(nonJson.stopReason).toBe('error')
      expect(nonJson.error).toContain('not plain JSON data')
    })
  })

  describe('combinator semantics', () => {
    it('pipeline has NO cross-stage barrier: a fast item finishes stage 2 while a slow item holds stage 1', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const handle = ctx.workflows.start({
        script: script(`
          const out = await pipeline(['slow', 'fast'],
            (prev, item) => agent('s1 ' + item),
            (prev, item) => agent('s2 ' + item + ' after ' + prev),
          )
          return out
        `),
        parent: fakeParent(),
      })
      // Both items enter stage 1 concurrently.
      await vi.waitFor(() => { expect(provider.runs.length).toBe(2) })
      // Settle only the FAST item's stage 1 → its stage 2 starts with no barrier.
      provider.runs[1]!.settle(text('fast-1'))
      await vi.waitFor(() => { expect(provider.runs.length).toBe(3) })
      expect((provider.runs[2]!.request.prompt[0] as { text: string }).text).toBe('s2 fast after fast-1')
      // The slow item is still sitting in stage 1.
      provider.runs[2]!.settle(text('fast-2'))
      provider.runs[0]!.settle(text('slow-1'))
      await vi.waitFor(() => { expect(provider.runs.length).toBe(4) })
      provider.runs[3]!.settle(text('slow-2'))
      const result = await handle.result
      expect(result.value).toEqual(['slow-2', 'fast-2'])
      await handle.dispose()
      void parent
    })

    it('pipeline stage callbacks receive (prev, item, index); an ordinary stage throw nulls the ITEM and skips its remaining stages', async () => {
      const { ctx, parent, provider } = await setup({ reply: request => text(`ok:${(request.prompt[0] as { text: string }).text}`) })
      const result = await run(ctx, parent, script(`
        const out = await pipeline([10, 20],
          (prev, item, index) => {
            if (item === 10) throw new Error('ordinary failure')
            return agent('stage1-' + item + '-' + index)
          },
          (prev) => agent('stage2 saw ' + prev),
        )
        return out
      `))
      expect(result.stopReason).toBe('completed')
      const prompts = provider.runs.map(r => (r.request.prompt[0] as { text: string }).text)
      // Item 10 never reached stage 1's agent nor stage 2.
      expect(prompts).toEqual(['stage1-20-1', 'stage2 saw ok:stage1-20-1'])
      expect(result.value).toEqual([null, 'ok:stage2 saw ok:stage1-20-1'])
    })

    it('parallel maps a throwing thunk to null and never rejects for ordinary errors', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script(`
        return await parallel([
          () => { throw new Error('boom') },
          () => agent('fine'),
          () => 'plain value',
          () => { throw 'string throw' },
          () => { throw { name: 'WorkflowError', fatal: true, message: 'forged fatal' } },
        ])
      `))
      // The last entry probes fatality: it is recognized by host instanceof,
      // which a script-built object can never pass — a WorkflowError-SHAPED
      // throw is an ordinary null, and real fatality cannot be forged.
      expect(result.value).toEqual([null, 'stub reply', 'plain value', null, null])
    })

    it('FATAL errors propagate through parallel AND pipeline instead of dissolving into null', async () => {
      const { ctx, parent } = await setup()
      const viaParallel = await run(ctx, parent, script(`
        return await parallel([() => agent('x', { isolation: 'worktree' })])
      `))
      expect(viaParallel.stopReason).toBe('error')
      expect(viaParallel.error).toContain('"isolation" is deferred')

      const viaPipeline = await run(ctx, parent, script(`
        return await pipeline([1], () => agent('x', { bogus: true }))
      `))
      expect(viaPipeline.stopReason).toBe('error')
      expect(viaPipeline.error).toContain('"bogus" is not recognized')
    })

    it('validates combinator arguments loudly (non-array, non-function, missing stages)', async () => {
      const { ctx, parent } = await setup()
      expect((await run(ctx, parent, script("return await parallel('no')"))).error).toContain('parallel() requires an array')
      expect((await run(ctx, parent, script('return await parallel([3])'))).error).toContain('item 0 is not a function')
      expect((await run(ctx, parent, script("return await pipeline('no', () => 1)"))).error).toContain('pipeline() requires an items array')
      expect((await run(ctx, parent, script('return await pipeline([1])'))).error).toContain('at least one stage')
      expect((await run(ctx, parent, script("return await pipeline([1], 'x')"))).error).toContain('stage 0 is not a function')
    })
  })

  describe('caps and option validation', () => {
    it('trips the total-agent cap with a message naming the config knob', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', maxTotalAgents: 2 } })
      const result = await run(ctx, parent, script(`
        await agent('1'); await agent('2'); await agent('3')
        return 'unreachable'
      `))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('total agent cap (2)')
      expect(result.error).toContain('maxTotalAgents')
      expect(result.agentsStarted).toBe(2)
    })

    it('trips the per-call item cap for parallel and pipeline', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', maxItemsPerCall: 2 } })
      expect((await run(ctx, parent, script('return await parallel([() => 1, () => 2, () => 3])'))).error)
        .toContain('over the per-call cap (2)')
      expect((await run(ctx, parent, script('return await pipeline([1, 2, 3], (x) => x)'))).error)
        .toContain('maxItemsPerCall')
    })

    it('enforces the concurrency ceiling: never more than maxConcurrentAgents children in flight', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, config: { provider: 'stub', maxConcurrentAgents: 2 } })
      const handle = ctx.workflows.start({
        script: script("return await parallel([1, 2, 3, 4, 5].map((n) => () => agent('job ' + n)))"),
        parent,
      })
      // Only 2 children may exist until one settles.
      await vi.waitFor(() => { expect(provider.runs.length).toBe(2) })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(provider.runs.length).toBe(2)
      // Settle children in arrival order; after each settle at most ONE more
      // child may enter — the window never exceeds the ceiling.
      for (let index = 0; index < 5; index++) {
        await vi.waitFor(() => { expect(provider.runs.length).toBeGreaterThan(index) })
        expect(provider.runs.length).toBeLessThanOrEqual(Math.min(index + 2, 5))
        provider.runs[index]!.settle(text(`r${index}`))
      }
      const result = await handle.result
      expect(result.stopReason).toBe('completed')
      expect(result.agentsStarted).toBe(5)
      expect(result.value).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
      await handle.dispose()
    })

    it('rejects malformed agent() arguments and option types loudly', async () => {
      const { ctx, parent } = await setup()
      expect((await run(ctx, parent, script('return await agent(42)'))).error).toContain('non-empty prompt string')
      expect((await run(ctx, parent, script("return await agent('')"))).error).toContain('non-empty prompt string')
      expect((await run(ctx, parent, script("return await agent('p', 'opts')"))).error).toContain('options must be an object')
      expect((await run(ctx, parent, script("return await agent('p', { label: 3 })"))).error).toContain('"label" must be a string')
      expect((await run(ctx, parent, script("return await agent('p', { effort: 'high' })"))).error).toContain('"effort" is deferred')
    })

    it('rejects options whose property reads throw (materialization is loud, not silent)', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script("return await agent('p', { get label() { throw new Error('read failed') } })"))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('options must be plain JSON data')
      expect(result.error).toContain('read failed')
    })

    it('validates phase() and log() arguments loudly', async () => {
      const { ctx, parent } = await setup()
      expect((await run(ctx, parent, script('phase(3)'))).error).toContain('phase() requires a non-empty title string')
      expect((await run(ctx, parent, script("phase('')"))).error).toContain('phase() requires a non-empty title string')
      expect((await run(ctx, parent, script('log(3)'))).error).toContain('log() requires a message string')
    })

    it('rejects an unsupported schema via the shared subset assertion (UNSUPPORTED_SCHEMA)', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script("return await agent('p', { schema: { type: 'object', oneOf: [] } })"))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('outside the supported subset')
      expect(result.error).toContain('oneOf')
    })

    it('wraps a provider start failure as a fatal AGENT_START error (a missing provider cannot dissolve into null)', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'nonexistent' } })
      const result = await run(ctx, parent, script("return await pipeline([1], () => agent('p'))"))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('could not start a child on provider "nonexistent"')
    })
  })

  describe('the value boundary', () => {
    it('args are cloned at start: a script scribbling on them cannot mutate the caller\'s object', async () => {
      const { ctx, parent } = await setup()
      const hostArgs = { files: ['a.ts'], nested: { deep: [1, 2] } }
      const result = await run(ctx, parent, script(`
        args.files.push('b.ts')
        return { count: args.files.length, deep: args.nested.deep[1] }
      `), hostArgs)
      expect(result.value).toEqual({ count: 2, deep: 2 })
      // The caller's object is untouched (the engine cloned args host-side).
      expect(hostArgs.files).toEqual(['a.ts'])
    })

    it('scalar/null args pass through directly; absent args leave the global undefined', async () => {
      const { ctx, parent } = await setup()
      expect((await run(ctx, parent, script('return args * 2'), 21)).value).toBe(42)
      expect((await run(ctx, parent, script('return args === null'), null)).value).toBe(true)
      expect((await run(ctx, parent, script('return typeof args'))).value).toBe('undefined')
    })

    it('hook failures reach the script as HOST WorkflowErrors: fields readable, in-realm instanceof Error is false', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script(`
        try {
          await agent('p', { bogus: true })
          return 'unreachable'
        } catch (e) {
          // The documented consequence of the trust premise: hook errors are
          // host objects, so realm instanceof is false — read the fields.
          return { isRealmError: e instanceof Error, name: e.name, code: e.code, fatal: e.fatal, message: e.message }
        }
      `))
      expect(result.stopReason).toBe('completed')
      expect(result.value).toMatchObject({ isRealmError: false, name: 'WorkflowError', code: 'UNSUPPORTED_OPTION', fatal: true })
      expect((result.value as { message: string }).message).toContain('"bogus" is not recognized')
    })

    it('a rejecting provider result is an infrastructure fault: fatal AGENT_RESULT, agent-end paired, no combinator dissolve', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const provider: SubagentProvider = {
        name: 'rejecting',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true },
        inheritsParentContext: false,
        start: () => ({
          id: AgentId('reject-child'),
          result: Promise.reject(new Error('backend exploded')),
          cancel: () => { /* nothing in flight */ },
          dispose: () => Promise.resolve(),
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(VmWorkflowEngine, { provider: 'rejecting' })
      const ends: unknown[] = []
      ctx.on('workflow/agent-end', (_info, agent) => { ends.push(agent) })
      // Direct await: the script reads the typed fields (a host object, so
      // realm instanceof is false — same as every hook failure).
      const direct = await run(ctx, fakeParent(), script(`
        try { await agent('p'); return 'unreachable' } catch (e) { return { name: e.name, code: e.code, fatal: e.fatal, message: e.message } }
      `))
      expect(direct.value).toMatchObject({ name: 'WorkflowError', code: 'AGENT_RESULT', fatal: true })
      expect((direct.value as { message: string }).message).toContain('backend exploded')
      // The child's lifecycle stays paired even though result never resolved.
      expect(ends).toEqual([expect.objectContaining({ seq: 1, outcome: 'failed' })])
      // Through a combinator the fault PROPAGATES (fatal) — a broken provider
      // must not dissolve into the per-item null and read as a failed child.
      const throughParallel = await run(ctx, fakeParent(), script("return await parallel([() => agent('p')])"))
      expect(throughParallel.stopReason).toBe('error')
      expect(throughParallel.error).toContain('backend exploded')
    })

    it('phase()/log() throw host WorkflowErrors synchronously on misuse', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script(`
        try { phase(3) } catch (e) {
          if (e.name !== 'WorkflowError') throw e
        }
        try { log(3) } catch (e) {
          return { name: e.name, message: e.message }
        }
      `))
      expect(result.value).toMatchObject({ name: 'WorkflowError' })
      expect((result.value as { message: string }).message).toContain('log() requires')
    })

    it('a returned value whose property reads throw fails loud as RESULT_UNSERIALIZABLE', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script(`
        return { get a() { throw new Error('read failed') } }
      `))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('not plain JSON data')
      expect(result.error).toContain('read failed')
    })

    it('a non-JSON return value fails loud as RESULT_UNSERIALIZABLE', async () => {
      const { ctx, parent } = await setup()
      const withDate = await run(ctx, parent, script('return { when: new Date(0) }'))
      expect(withDate.stopReason).toBe('error')
      expect(withDate.error).toContain('not plain JSON data')
      const withFn = await run(ctx, parent, script('return { fn: () => 1 }'))
      expect(withFn.error).toContain('not plain JSON data')
    })

    it('kills a synchronous spin in the initial slice via the vm timeout', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', syncTimeoutMs: 50 } })
      const result = await run(ctx, parent, script('while (true) {}'))
      expect(result.stopReason).toBe('error')
      expect(result.error?.toLowerCase()).toContain('timed out')
    })
  })

  describe('lifecycle: parse errors, cancellation, disposal', () => {
    it('start() throws synchronously for an unparseable script or invalid meta', async () => {
      const { ctx, parent } = await setup()
      expect(() => ctx.workflows.start({ script: 'const x = 1', parent })).toThrow(/must begin with/)
      expect(() => ctx.workflows.start({ script: script('return ((('), parent })).toThrow(/does not parse/)
    })

    it('cancel() aborts in-flight children and settles the run cancelled', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const ends: WorkflowResultInfo[] = []
      ctx.on('workflow/end', (_info, result) => { ends.push(result) })
      const handle = ctx.workflows.start({ script: script("return await agent('long job')"), parent })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      handle.cancel('user stopped it')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('user stopped it')
      expect(provider.runs[0]!.disposed).toBe(true)
      // workflow/end is an observer's only death signal: it fires for a
      // cancelled run too, mirroring the settled outcome data.
      expect(ends).toEqual([{ stopReason: 'cancelled', error: result.error, agentsStarted: 1 }])
      await handle.dispose()
    })

    it('cancellation bridges to run.cancel() on every in-flight child, not just the request signal', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const handle = ctx.workflows.start({
        script: script("return await parallel([() => agent('a'), () => agent('b')])"),
        parent,
      })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(2) })
      handle.cancel('bridged')
      expect((await handle.result).stopReason).toBe('cancelled')
      // The seam leaves a provider free to honor run.cancel() rather than the
      // request signal, so the engine must drive BOTH channels per child.
      expect(provider.runs.map(r => r.cancelled)).toEqual(['bridged', 'bridged'])
      await handle.dispose()
    })

    it('a provider whose result REJECTS on abort still gets a paired cancelled agent-end, and the run reports cancelled', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      // The seam allows result to reject for infrastructure faults; a backend
      // that tears down uncleanly on abort exercises the rejection path WHILE
      // the run is cancelled — which must stay a cancellation, not AGENT_RESULT.
      const provider: SubagentProvider = {
        name: 'reject-on-abort',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true },
        inheritsParentContext: false,
        start: request => ({
          id: AgentId('crashing-child'),
          result: new Promise((_, reject) => {
            request.signal?.addEventListener('abort', () => { reject(new Error('backend crashed on abort')) }, { once: true })
          }),
          cancel: () => { /* the signal listener above is the teardown */ },
          dispose: () => Promise.resolve(),
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(VmWorkflowEngine, { provider: 'reject-on-abort' })
      const starts: unknown[] = []
      const ends: unknown[] = []
      ctx.on('workflow/agent-start', (_info, agent) => { starts.push(agent) })
      ctx.on('workflow/agent-end', (_info, agent) => { ends.push(agent) })
      const handle = ctx.workflows.start({ script: script("return await agent('doomed')"), parent: fakeParent() })
      await vi.waitFor(() => { expect(starts.length).toBe(1) })
      handle.cancel('user aborted')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('user aborted')
      expect(ends).toEqual([expect.objectContaining({ seq: 1, outcome: 'cancelled' })])
      await handle.dispose()
    })

    it('after cancellation EVERY hook throws at entry — phase/log/parallel/pipeline, not just agent()', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      let cancelled = false
      const postCancel: string[] = []
      ctx.on('workflow/phase', (_info, title) => { if (cancelled) postCancel.push(`phase:${title}`) })
      ctx.on('workflow/log', (_info, message) => { if (cancelled) postCancel.push(`log:${message}`) })
      const handle = ctx.workflows.start({
        // The script survives each throw by catching, so every guarded hook is
        // actually ATTEMPTED after the cancel; the run still reports cancelled.
        script: script(`
          phase('before')
          try { await agent('x') } catch (e) {}
          try { phase('after') } catch (e) {}
          try { log('after') } catch (e) {}
          try { await parallel([() => 'ran']) } catch (e) {}
          try { await pipeline(['item'], p => p) } catch (e) {}
          return 'survived by catching'
        `),
        parent,
      })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      cancelled = true
      handle.cancel('stop everything')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      // No post-cancel progress ever reached observers, and no child started.
      expect(postCancel).toEqual([])
      expect(provider.runs.length).toBe(1)
      await handle.dispose()
    })

    it('an already-aborted request signal cancels before any child starts', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const controller = new AbortController()
      controller.abort()
      const handle = ctx.workflows.start({ script: script("return await agent('never')"), parent, signal: controller.signal })
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(provider.runs.length).toBe(0)
      await handle.dispose()
    })

    it('an already-aborted signal cancels a HOOK-FREE script: the body never runs at all', async () => {
      const { ctx, parent } = await setup()
      const controller = new AbortController()
      controller.abort()
      const logs: string[] = []
      ctx.on('workflow/log', (_info, message) => { logs.push(message) })
      const handle = ctx.workflows.start({ script: script("log('ran')\nreturn 123"), parent, signal: controller.signal })
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.value).toBeNull()
      expect(logs).toEqual([])
      await handle.dispose()
    })

    it('cancel() right after start() reports cancelled even when the script needed no hooks', async () => {
      const { ctx, parent } = await setup()
      const handle = ctx.workflows.start({ script: script('return 123'), parent })
      handle.cancel('changed my mind')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.value).toBeNull()
      expect(result.error).toContain('changed my mind')
      await handle.dispose()
    })

    it('an agent() call AFTER a mid-run cancel rejects at entry — no child ever starts', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const handle = ctx.workflows.start({
        script: script(`
          await agent('first')
          return await agent('second')
        `),
        parent,
      })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      // Same synchronous block: the first child settles completed, then the
      // cancel lands BEFORE the script's continuation can call agent() again.
      provider.runs[0]!.settle(text('first done'))
      handle.cancel('mid-run')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(provider.runs.length).toBe(1)
      await handle.dispose()
    })

    it('the signal aborting mid-run cancels like cancel()', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const controller = new AbortController()
      const handle = ctx.workflows.start({ script: script("return await agent('job')"), parent, signal: controller.signal })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      controller.abort()
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      await handle.dispose()
    })

    it('reports a non-Error script throw (a thrown string) faithfully', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script("throw 'plain string failure'"))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('plain string failure')
    })

    it('a script Error surfaces its stack, carrying the script line numbers (lineOffset)', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script("throw new Error('with stack')"))
      expect(result.stopReason).toBe('error')
      // Line 1 is the blanked meta statement; the throw sits on line 2.
      expect(result.error).toContain('workflow:test-flow:2')
    })

    it('an object throw with neither stack nor message stringifies', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script('throw { code: 42 }'))
      expect(result.stopReason).toBe('error')
      expect(result.error).toBe('[object Object]')
    })

    it('falls back to the message for an Error whose stack was stripped', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, script(`
        const e = new Error('stackless failure')
        e.stack = undefined
        throw e
      `))
      expect(result.stopReason).toBe('error')
      expect(result.error).toBe('stackless failure')
    })

    it('cancel() in the same frame as start(): the awaited slot tick cannot start a child', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      // agent() enters during start()'s synchronous slice and suspends on the
      // acquireSlot await (one microtask tick even with a free slot); the
      // synchronous cancel below lands in that tick. Without the post-acquire
      // re-check the continuation would start a child carrying an ALREADY-
      // aborted signal — which the stub provider (subscribing only to future
      // abort events, like a real backend) would never settle, leaking it.
      const handle = ctx.workflows.start({ script: script("return await agent('never')"), parent })
      handle.cancel('immediately after start')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(provider.runs.length).toBe(0)
      await handle.dispose()
    })

    it('a waiter resumed by a release RACING a cancel still dies at the post-acquire check', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, config: { provider: 'stub', maxConcurrentAgents: 1 } })
      const handle = ctx.workflows.start({
        script: script("return await parallel([() => agent('a'), () => agent('b')])"),
        parent,
      })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      // Same synchronous block: b is still a QUEUED waiter when the cancel
      // lands, so cancel() rejects it outright; together with the immediate-
      // cancel test above (the resumed-waiter tick), no post-cancel path can
      // reach subagents.start.
      provider.runs[0]!.settle(text('a-done'))
      handle.cancel('raced')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(provider.runs.length).toBe(1)
      await handle.dispose()
    })

    it('a dropped agent() promise cannot become an unhandled rejection when cancellation lands', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      try {
        const { ctx, parent, provider } = await setup({ manual: true })
        const handle = ctx.workflows.start({
          script: script(`
            agent('dropped, never awaited')
            return await agent('awaited')
          `),
          parent,
        })
        await vi.waitFor(() => { expect(provider.runs.length).toBe(2) })
        handle.cancel()
        await handle.result
        await handle.dispose()
        // Let any stray rejection reach the process hook before asserting.
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('cancel() force-settles the result of a script parked on a promise no hook owns', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', disposeGraceMs: 30 } })
      const ends: WorkflowResultInfo[] = []
      ctx.on('workflow/end', (_info, result) => { ends.push(result) })
      const handle = ctx.workflows.start({
        // No hooks involved: an unsettleable await cancellation cannot reject
        // — the abandon grace is the only thing that can settle this run.
        script: script("await new Promise(() => {})\nreturn 'unreachable'"),
        parent,
      })
      handle.cancel('user aborted')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('user aborted')
      // The grace force-settle fires workflow/end exactly like an ordinary
      // settlement — an abandoned script's death still reaches observers.
      expect(ends).toEqual([{ stopReason: 'cancelled', error: result.error, agentsStarted: 0 }])
      await handle.dispose()
    })

    it('a never-settling returned thenable is abandoned the same way', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', disposeGraceMs: 30 } })
      const handle = ctx.workflows.start({ script: script('return { then() {} }'), parent })
      handle.cancel()
      expect((await handle.result).stopReason).toBe('cancelled')
      await handle.dispose()
    })

    it('dispose() abandons a stuck script after the grace instead of hanging (result settles cancelled)', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', disposeGraceMs: 30 } })
      const handle = ctx.workflows.start({
        script: script("await new Promise(() => {})\nreturn 'unreachable'"),
        parent,
      })
      const before = Date.now()
      await handle.dispose()
      expect(Date.now() - before).toBeLessThan(1000)
      // The abandon that freed dispose() also settled result — a consumer
      // still awaiting it (the tool does, before its disposing finally) is
      // released rather than wedged forever.
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
    })

    it('dispose() is idempotent and settles cleanly after a completed run', async () => {
      const { ctx, parent } = await setup()
      const handle = ctx.workflows.start({ script: script('return 1'), parent })
      await handle.result
      await handle.dispose()
      await handle.dispose()
    })

    it('strays: children fired without await are aborted once the script settles', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const handle = ctx.workflows.start({
        script: script(`
          agent('stray')
          return 'done without awaiting'
        `),
        parent,
      })
      const result = await handle.result
      expect(result.stopReason).toBe('completed')
      await vi.waitFor(() => {
        expect(provider.runs.length).toBe(1)
        expect(provider.runs[0]!.disposed).toBe(true)
      })
      await handle.dispose()
    })

    it('dispose() waits for a stray child to FINISH disposing (quiescence), not just the script settle', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, disposeDelayMs: 40 })
      const handle = ctx.workflows.start({
        script: script(`
          agent('stray')
          return 'done without awaiting'
        `),
        parent,
      })
      const result = await handle.result
      expect(result.stopReason).toBe('completed')
      expect(provider.runs.length).toBe(1)
      await handle.dispose()
      // Not a waitFor: by the time dispose() returns, the slow child disposal
      // must already be complete.
      expect(provider.runs[0]!.disposed).toBe(true)
    })
  })

  describe('service surface', () => {
    it('run ids are unique per start; the run handle and event payloads hold SEPARATE meta clones', async () => {
      const { ctx, parent } = await setup()
      let eventMeta: WorkflowRunInfo | undefined
      ctx.on('workflow/start', (info) => { eventMeta = info })
      const first = ctx.workflows.start({ script: script('return 1'), parent })
      const second = ctx.workflows.start({ script: script('return 2'), parent })
      expect(first.id).not.toBe(second.id)
      // Mutating a listener's snapshot cannot corrupt the holder's view.
      eventMeta!.meta.name = 'corrupted'
      expect(second.meta.name).toBe('test-flow')
      await Promise.all([first.result, second.result])
      await first.dispose()
      await second.dispose()
    })

    it('a listener mutating one event payload cannot corrupt later events (per-emission snapshots)', async () => {
      const { ctx, parent } = await setup()
      const ends: unknown[] = []
      let endInfo: WorkflowRunInfo | undefined
      ctx.on('workflow/agent-start', (info, agent) => {
        agent.seq = 999
        agent.label = 'HACKED'
        info.meta.name = 'HACKED'
      })
      ctx.on('workflow/agent-end', (info, agent) => {
        ends.push(agent)
        endInfo = info
      })
      await run(ctx, parent, script("return await agent('job', { label: 'honest' })"))
      expect(ends[0]).toMatchObject({ seq: 1, label: 'honest', outcome: 'completed' })
      expect(endInfo!.meta.name).toBe('test-flow')
    })

    it('unregisters ctx.workflows when the engine fiber is disposed (HMR safety)', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const fiber = await ctx.plugin(VmWorkflowEngine, {})
      expect(ctx.get('workflows')).toBeDefined()
      await fiber.dispose()
      expect(ctx.get('workflows')).toBeUndefined()
    })

    it('has the class-plugin export shape (default = the engine service class)', () => {
      expect(vmEngineModule.default).toBe(VmWorkflowEngine)
      const loader = Object.create(Loader.prototype) as Loader
      const unwrapped: unknown = loader.unwrapExports(vmEngineModule)
      expect(unwrapped).toBe(VmWorkflowEngine)
    })
  })
})
