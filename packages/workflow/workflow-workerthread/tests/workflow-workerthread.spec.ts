import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { WorkflowMeta, WorkflowResult, WorkflowResultInfo, WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import * as workerEngineModule from '../src/index.ts'
import WorkerWorkflowEngine, { type Config } from '../src/index.ts'

/** A minimal parent stand-in: the engine only threads it through to the provider. */
function fakeParent(): Agent {
  return { id: AgentId('workflow-parent'), options: {} } as unknown as Agent
}

/** The vm-context escape hatch, spelled once: real Worker tests use it to make the WORKER misbehave. */
const ESCAPE = "globalThis.constructor.constructor('return process')()"

/** One controllable child run: the test (or auto mode) settles it. */
interface ControlledRun {
  request: SubagentStartRequest
  settle(result: SubagentResult): void
  cancelled: string | undefined
  disposed: boolean
  disposeCalls: number
}

/**
 * A scripted in-test provider over the REAL SubagentService registry: `auto`
 * settles each run via the reply function on a microtask; `manual` piles runs
 * up in `runs` for the test to settle. A run aborts (settles `aborted`) when
 * the request signal fires, like the real in-process backends.
 */
class StubProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true }
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
    const controlled: ControlledRun = { request, settle, cancelled: undefined, disposed: false, disposeCalls: 0 }
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
        controlled.disposeCalls += 1
        if (this.disposeDelayMs === 0) {
          controlled.disposed = true
          return Promise.resolve()
        }
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
  // would wedge on small CI runners.
  await ctx.plugin(WorkerWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 8, ...options?.config })
  return { ctx, provider, parent: fakeParent() }
}

/** The standard test meta plus a body, spread into a start request. */
function scripted(body: string, metaExtra?: Partial<WorkflowMeta>): { script: string; meta: WorkflowMeta } {
  return { script: body, meta: { name: 'test-flow', description: 'a test workflow', ...metaExtra } }
}

/** Start + await one run, disposing on the way out. */
async function run(ctx: Context, parent: Agent, source: { script: string; meta: WorkflowMeta }, args?: unknown): Promise<WorkflowResult> {
  const handle = ctx.workflows.start({ ...source, parent, ...args !== undefined ? { args } : {} })
  try {
    return await handle.result
  } finally {
    await handle.dispose()
  }
}

describe('dsh-workflow-workerthread', () => {
  describe('script execution over a real worker thread', () => {
    it('runs a script end-to-end: agent() text results, phases, log, args, return value, events', async () => {
      const { ctx, parent, provider } = await setup({ reply: (_request, index) => text(`answer-${index}`) })
      const events: [string, unknown[]][] = []
      for (const name of ['workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
        ctx.on(name, (...payload: unknown[]) => { events.push([name, payload]) })
      }
      const result = await run(ctx, parent, scripted(`
        phase('Scan')
        log('starting with ' + args.files.length + ' files')
        const answers = await pipeline(args.files, (prev, item) => agent('read ' + item))
        phase('Report')
        return { answers, count: args.files.length }
      `, { phases: [{ title: 'Scan' }, { title: 'Report' }] }), { files: ['a.ts', 'b.ts'] })

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

    it('agent({schema, model}) forwards outputSchema and agentOptions to the provider across the thread', async () => {
      const { ctx, parent, provider } = await setup({
        reply: () => ({ output: [], structured: { files: ['x.ts', 'y.ts'] }, stopReason: 'completed' }),
      })
      const result = await run(ctx, parent, scripted(`
        const found = await agent('list files', { model: 'deepseek-v4-pro', schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } })
        return { first: found.files[0], count: found.files.length }
      `))
      expect(result.value).toEqual({ first: 'x.ts', count: 2 })
      expect(provider.runs[0]!.request.outputSchema).toEqual({
        type: 'object',
        properties: { files: { type: 'array', items: { type: 'string' } } },
        required: ['files'],
      })
      expect(provider.runs[0]!.request.agentOptions).toEqual({ model: 'deepseek-v4-pro' })
      expect(provider.runs[0]!.request.parent).toBeDefined()
    })

    it('a fatal hook error inside the worker kills the script and reports the error', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, scripted("return await parallel([() => agent('x', { isolation: 'worktree' })])"))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('"isolation" is deferred')
    })

    it('a provider start failure crosses back as a fatal AGENT_START error', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'nonexistent' } })
      const result = await run(ctx, parent, scripted("return await pipeline([1], () => agent('p'))"))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('agent() could not start a child')
    })

    it('a child result REJECTION crosses back as a fatal AGENT_RESULT error (a broken provider is not a failed child)', async () => {
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
      await ctx.plugin(WorkerWorkflowEngine, { provider: 'rejecting', maxConcurrentAgents: 2 })
      const result = await run(ctx, fakeParent(), scripted(`
        try { await agent('p'); return 'unreachable' } catch (e) { return { name: e.name, code: e.code, fatal: e.fatal, message: e.message } }
      `))
      expect(result.value).toMatchObject({ name: 'WorkflowError', code: 'AGENT_RESULT', fatal: true })
      expect((result.value as { message: string }).message).toContain('backend exploded')
    })

    it('a child whose dispose() rejects cannot wedge the script (the host acks anyway)', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const provider: SubagentProvider = {
        name: 'bad-dispose',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true },
        inheritsParentContext: false,
        start: () => ({
          id: AgentId('bad-dispose-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'fine' }], stopReason: 'completed' }),
          cancel: () => { /* settled already */ },
          dispose: () => Promise.reject(new Error('dispose exploded')),
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(WorkerWorkflowEngine, { provider: 'bad-dispose', maxConcurrentAgents: 2 })
      const result = await run(ctx, fakeParent(), scripted("return await agent('p')"))
      expect(result.stopReason).toBe('completed')
      expect(result.value).toBe('fine')
    })

    it('a child dispose() rejecting an UNRENDERABLE value still acks — the containment warn is total', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const provider: SubagentProvider = {
        name: 'coercion-trap-dispose',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true },
        inheritsParentContext: false,
        start: () => ({
          id: AgentId('trap-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'fine' }], stopReason: 'completed' }),
          cancel: () => { /* settled already */ },
          // The rejection VALUE's own coercion throws: a warn built with bare
          // String(error) would itself throw, skipping the ChildDisposed ack
          // and wedging the script's finally until the grace/terminate path.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection IS the scenario under test
          dispose: () => Promise.reject({ toString: () => { throw new Error('coercion trap') } }),
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(WorkerWorkflowEngine, { provider: 'coercion-trap-dispose', maxConcurrentAgents: 2 })
      const result = await run(ctx, fakeParent(), scripted("return await agent('p')"))
      expect(result.stopReason).toBe('completed')
      expect(result.value).toBe('fine')
    })

    it('the worker spawns with an EMPTY environment: an escaped script finds no ambient credentials', async () => {
      const { ctx, parent } = await setup()
      // A canary in the HARNESS process's env: with an inherited environment
      // the escape below would read it back (exactly how DEEPSEEK_API_KEY
      // would leak); env: {} in the spawn options is what keeps it out.
      process.env.WORKFLOW_ENV_CANARY = 'leak me'
      try {
        const result = await run(ctx, parent, scripted(`
          const proc = ${ESCAPE}
          return { canary: proc.env.WORKFLOW_ENV_CANARY ?? null, keys: Object.keys(proc.env).length }
        `))
        expect(result.stopReason).toBe('completed')
        expect(result.value).toEqual({ canary: null, keys: 0 })
      } finally {
        delete process.env.WORKFLOW_ENV_CANARY
      }
    })

    it('the unbuilt worker forwards exactly TSX_TSCONFIG_PATH through the scrub: the paths-map pin survives, secrets do not', async () => {
      const { ctx, parent } = await setup()
      // The ACP snapshot harness runs the parent with its cwd OUTSIDE the
      // repo and pins the repo tsconfig through this variable; the worker
      // must inherit the pin (or its dsh-* imports silently resolve to
      // unbuilt lib/ bundles) while every other variable stays scrubbed.
      const tsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
      process.env.TSX_TSCONFIG_PATH = tsconfig
      process.env.WORKFLOW_ENV_CANARY = 'leak me'
      try {
        const result = await run(ctx, parent, scripted(`
          const proc = ${ESCAPE}
          return { keys: Object.keys(proc.env), tsconfig: proc.env.TSX_TSCONFIG_PATH }
        `))
        expect(result.stopReason).toBe('completed')
        expect(result.value).toEqual({ keys: ['TSX_TSCONFIG_PATH'], tsconfig })
      } finally {
        delete process.env.TSX_TSCONFIG_PATH
        delete process.env.WORKFLOW_ENV_CANARY
      }
    })
  })

  describe('lifecycle: parse errors, cancellation, termination, disposal', () => {
    it('start() throws synchronously for invalid meta data or an unparseable body (host-side pre-checks)', async () => {
      const { ctx, parent } = await setup()
      // Meta is DATA — shape violations reject loud, every one named.
      expect(() => ctx.workflows.start({ script: 'return 1', meta: { name: '', description: 'd' }, parent })).toThrow(/meta\.name must be a non-empty string/)
      expect(() => ctx.workflows.start({ script: 'return 1', meta: { name: 'x', description: 'd', extra: 1 } as unknown as WorkflowMeta, parent })).toThrow(/META_INVALID|not a recognized field/)
      expect(() => ctx.workflows.start({ ...scripted('return ((('), parent })).toThrow(/does not parse/)
      // The likeliest authoring slip — a Claude Code-style meta header in the
      // body — gets a pointed message, not a bare SyntaxError.
      expect(() => ctx.workflows.start({ ...scripted("export const meta = { name: 'x', description: 'd' }\nreturn 1"), parent })).toThrow(/meta rides the `meta` request field/)
    })

    it('cancel() aborts in-flight children (signal AND cancel RPC) and settles the run cancelled', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const ends: unknown[] = []
      ctx.on('workflow/agent-end', (_info, agent) => { ends.push(agent) })
      const runEnds: WorkflowResultInfo[] = []
      ctx.on('workflow/end', (_info, result) => { runEnds.push(result) })
      const handle = ctx.workflows.start({ ...scripted("return await agent('long job')"), parent })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      handle.cancel('user stopped it')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('user stopped it')
      await handle.dispose()
      expect(provider.runs[0]!.disposed).toBe(true)
      expect(ends).toEqual([expect.objectContaining({ seq: 1, outcome: 'cancelled' })])
      // workflow/end is an observer's only death signal: it fires for a
      // cancelled run too, mirroring the settled outcome data.
      expect(runEnds).toEqual([{ stopReason: 'cancelled', error: result.error, agentsStarted: result.agentsStarted }])
    })

    it('an already-aborted request signal cancels before the body ever runs (the go handshake holds it)', async () => {
      const { ctx, parent, provider } = await setup()
      const controller = new AbortController()
      controller.abort()
      const logs: string[] = []
      ctx.on('workflow/log', (_info, message) => { logs.push(message) })
      const handle = ctx.workflows.start({ ...scripted("log('ran')\nreturn 123"), parent, signal: controller.signal })
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.value).toBeNull()
      expect(logs).toEqual([])
      expect(provider.runs.length).toBe(0)
      await handle.dispose()
    })

    it('cancel() right after start() cancels before the body runs; the signal aborting mid-run cancels like cancel()', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const first = ctx.workflows.start({ ...scripted("return await agent('never')"), parent })
      // No-reason cancel: the canonical default reason must ride the result.
      first.cancel()
      const firstResult = await first.result
      expect(firstResult.stopReason).toBe('cancelled')
      expect(firstResult.error).toContain('workflow cancelled')
      expect(provider.runs.length).toBe(0)
      await first.dispose()

      const controller = new AbortController()
      const second = ctx.workflows.start({ ...scripted("return await agent('job')"), parent, signal: controller.signal })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      controller.abort()
      expect((await second.result).stopReason).toBe('cancelled')
      await second.dispose()
    })

    it('a child-start racing the host cancel is refused: no child starts after cancellation', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      // Cancel from INSIDE the log listener: the worker has already posted
      // its child-start (queued right behind the log message), so the host
      // processes it with cancelReason set — the refusal arm no real-world
      // timing can hit reliably. (The closure runs only after `handle` below
      // is initialized — the listener fires on the worker's first message.)
      ctx.on('workflow/log', () => { handle.cancel('cancelled from the log listener') })
      const handle = ctx.workflows.start({ ...scripted("log('mark')\nreturn await agent('late')"), parent })
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(provider.runs.length).toBe(0)
      await handle.dispose()
    })

    it('post-cancel narration is suppressed host-side, and completion racing a cancel reports cancelled', async () => {
      const { ctx, parent } = await setup()
      const narration: string[] = []
      ctx.on('workflow/log', (_info, message) => { narration.push(message) })
      ctx.on('workflow/phase', (_info, title) => { narration.push(`phase:${title}`) })
      const handle = ctx.workflows.start({
        // The sync spin keeps the worker's loop busy so the cancel message
        // cannot be processed before the script settles `completed` — the
        // worker posts a completed result that must LOSE to the in-flight
        // host cancellation. The trailing narration exercises host-side
        // suppression: posted pre-cancel-processing worker-side, arriving
        // post-cancel host-side.
        ...scripted(`
          log('started')
          const end = Date.now() + 1000
          while (Date.now() < end) {}
          phase('late phase')
          log('late log')
          return 'done'
        `),
        parent,
      })
      await vi.waitFor(() => { expect(narration).toContain('started') })
      handle.cancel('raced the completion')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('raced the completion')
      expect(narration).toEqual(['started'])
      await handle.dispose()
    }, 15_000)

    it('cancel() force-settles a script parked on a promise no hook owns, and TERMINATES its worker', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', disposeGraceMs: 50 } })
      const runEnds: WorkflowResultInfo[] = []
      ctx.on('workflow/end', (_info, result) => { runEnds.push(result) })
      const handle = ctx.workflows.start({
        ...scripted("await new Promise(() => {})\nreturn 'unreachable'"),
        parent,
      })
      handle.cancel('user aborted')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('user aborted')
      // The grace force-settle fires workflow/end exactly like an ordinary
      // settlement — a terminated script's death still reaches observers.
      expect(runEnds).toEqual([{ stopReason: 'cancelled', error: result.error, agentsStarted: 0 }])
      await handle.dispose()
    })

    it('dispose() on a stuck script returns within the grace instead of hanging (result settles cancelled)', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', disposeGraceMs: 50 } })
      const handle = ctx.workflows.start({
        ...scripted("await new Promise(() => {})\nreturn 'unreachable'"),
        parent,
      })
      const before = Date.now()
      await handle.dispose()
      expect(Date.now() - before).toBeLessThan(2000)
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
    })

    it('dispose() is idempotent and settles cleanly after a completed run', async () => {
      const { ctx, parent } = await setup()
      const handle = ctx.workflows.start({ ...scripted('return 1'), parent })
      await handle.result
      await handle.dispose()
      await handle.dispose()
    })

    it('a settled run arms NO grace timer: disposing a completed run must not pin it for disposeGraceMs', async () => {
      // A distinctive grace so the spy can tell the cancel-path grace timer
      // apart from every other timeout in flight.
      const GRACE = 44_444
      const { ctx, parent } = await setup({ config: { provider: 'stub', disposeGraceMs: GRACE } })
      const handle = ctx.workflows.start({ ...scripted('return 1'), parent })
      await handle.result
      const spy = vi.spyOn(globalThis, 'setTimeout')
      try {
        await handle.dispose()
        // dispose()'s own bounded-wait sleep is the ONLY grace-sized timer
        // allowed here; before the settled guard, cancel() armed a second one
        // that nothing would ever clear (the run was already settled), keeping
        // the WorkerRun/Worker closure alive until the grace expired.
        const graceTimers = spy.mock.calls.filter(call => call[1] === GRACE)
        expect(graceTimers.length).toBe(1)
      } finally {
        spy.mockRestore()
      }
    })

    it('strays: children fired without await are aborted once the script settles, and dispose() waits for their disposal', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, disposeDelayMs: 40 })
      const handle = ctx.workflows.start({
        ...scripted(`
          agent('stray')
          return 'done without awaiting'
        `),
        parent,
      })
      const result = await handle.result
      expect(result.stopReason).toBe('completed')
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      await handle.dispose()
      // Not a waitFor: by the time dispose() returns, the slow child disposal
      // must already be complete (host-side registry quiescence).
      expect(provider.runs[0]!.disposed).toBe(true)
    })

    it('the settle-reap fires the request signal too: a provider honoring ONLY the signal winds its stray down promptly', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const aborted: string[] = []
      const provider: SubagentProvider = {
        name: 'signal-only',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true },
        inheritsParentContext: false,
        start: (request) => {
          let settle!: (result: SubagentResult) => void
          const result = new Promise<SubagentResult>((resolve) => { settle = resolve })
          request.signal?.addEventListener('abort', () => {
            aborted.push(String(request.signal?.reason))
            settle({ output: [], stopReason: 'aborted' })
          }, { once: true })
          return {
            id: AgentId('signal-only-child'),
            result,
            // The seam leaves a provider free to honor EITHER cancel channel;
            // this one deliberately ignores run.cancel() — only the request
            // signal can wind it down.
            cancel: () => { /* signal-only by design */ },
            dispose: () => Promise.resolve(),
          }
        },
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(WorkerWorkflowEngine, { provider: 'signal-only', maxConcurrentAgents: 2 })
      const handle = ctx.workflows.start({
        ...scripted(`
          agent('stray, never awaited')
          return 'done'
        `),
        parent: fakeParent(),
      })
      const result = await handle.result
      expect(result.stopReason).toBe('completed')
      // BEFORE dispose(): the settlement itself must have aborted the signal —
      // without it this child would stay live until dispose's terminate.
      await vi.waitFor(() => { expect(aborted).toEqual(['workflow settled']) })
      await handle.dispose()
    })

    it("cancel() drives each child's explicit cancel() host-side: a wedged worker cannot delay it", async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      let starts = 0
      const cancelled: string[] = []
      const provider: SubagentProvider = {
        name: 'cancel-only',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true },
        inheritsParentContext: false,
        start: () => {
          starts += 1
          return {
            id: AgentId('cancel-only-child'),
            result: new Promise(() => { /* only cancel() ends this child */ }),
            // Deliberately ignores the request signal — the seam leaves a
            // provider free to honor ONLY the explicit cancel() channel.
            cancel: (reason?: string) => { cancelled.push(reason ?? 'cancelled') },
            dispose: () => Promise.resolve(),
          }
        },
      }
      ctx.subagents.registerProvider(provider)
      // A deliberately huge grace: if only the grace/terminate reap could
      // reach this child, the assertion below would time out first.
      await ctx.plugin(WorkerWorkflowEngine, { provider: 'cancel-only', maxConcurrentAgents: 2, disposeGraceMs: 30_000 })
      const handle = ctx.workflows.start({
        // The stray child's start RPC reaches the host, then the script wedges
        // its own worker in a synchronous spin: the worker cannot process the
        // Cancel message, so it can relay NO ChildCancel RPC — only the host's
        // own children loop can deliver the explicit cancel in time. The
        // microtask yields let the agent() continuation POST its child-start
        // before the spin seizes the worker's loop (the posted message needs
        // no further worker-loop turns to reach the host).
        ...scripted(`
          agent('wedged child')
          for (let i = 0; i < 20; i++) await null
          const end = Date.now() + 1500
          while (Date.now() < end) {}
          return 'raced'
        `),
        parent: fakeParent(),
      })
      await vi.waitFor(() => { expect(starts).toBe(1) })
      handle.cancel('stop now')
      await vi.waitFor(() => { expect(cancelled).toEqual(['stop now']) }, { timeout: 800 })
      // The wedged worker's own completion loses to the in-flight cancel.
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      await handle.dispose()
    }, 15_000)

    it('dispose() on a wedged worker host-drives child disposal inside the grace: it returns with the children DISPOSED, not with their teardown still in flight', async () => {
      const { ctx, parent, provider } = await setup({
        manual: true,
        disposeDelayMs: 40,
        config: { provider: 'stub', maxConcurrentAgents: 8, disposeGraceMs: 400 },
      })
      const handle = ctx.workflows.start({
        // Same shape as the wedged-cancel test above: the child's start RPC
        // reaches the host, then the script seizes its worker's loop, so the
        // worker can relay NO dispose RPC — the host's own dispose() drive is
        // the only thing that can start (and finish) this child's disposal
        // before the grace runs out.
        ...scripted(`
          agent('wedged child')
          for (let i = 0; i < 20; i++) await null
          const end = Date.now() + 1500
          while (Date.now() < end) {}
          return 'raced'
        `),
        parent,
      })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      const before = Date.now()
      await handle.dispose()
      // Bounded by the grace (plus the terminate), never by the 1.5s spin.
      expect(Date.now() - before).toBeLessThan(1200)
      // Not a waitFor: dispose() resolving IS the quiescence claim — the slow
      // child disposal must be complete, not merely started (before the
      // host-driven drive, disposal only STARTED at the post-terminate reap,
      // so dispose() returned with it still in flight).
      expect(provider.runs[0]!.disposed).toBe(true)
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
    }, 15_000)

    it('a live child disposed by the dispose() drive is disposed ONCE, and the worker\'s late dispose RPC still gets its ack (the script settles, not the grace)', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const handle = ctx.workflows.start({
        ...scripted(`
          await agent('long child')
          return 'unreachable'
        `),
        parent,
      })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(1) })
      const handleDispose = handle.dispose()
      const result = await handle.result
      // The script itself settled (the wrapper's own dispose RPC found the
      // child already reaped host-side and was acked) — a missing ack would
      // wedge the wrapper's finally until the 5s default grace force-settle.
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('workflow disposed')
      await handleDispose
      expect(provider.runs[0]!.disposed).toBe(true)
      // The memo: the host drive and the worker's RPC share one disposal.
      expect(provider.runs[0]!.disposeCalls).toBe(1)
    })

    it('the grace force-settle pairs every stranded start: a host-synthesized cancelled agent-end lands before workflow/end', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, config: { provider: 'stub', maxConcurrentAgents: 8, disposeGraceMs: 300 } })
      const ends: { seq: number; outcome: string }[] = []
      const order: string[] = []
      ctx.on('workflow/agent-start', (_info, agent) => { order.push(`start:${agent.seq}`) })
      ctx.on('workflow/agent-end', (_info, agent) => {
        ends.push({ seq: agent.seq, outcome: agent.outcome })
        order.push(`end:${agent.seq}`)
      })
      ctx.on('workflow/end', () => { order.push('run-end') })
      const handle = ctx.workflows.start({
        // 'slow' starts and its agent-start crosses to observers (the awaited
        // 'fast' call keeps the worker loop turning), then the script seizes
        // the loop: the wedged worker can never author slow's agent-end —
        // only the host's ledger can close the pair.
        ...scripted(`
          const p = agent('slow')
          await agent('fast')
          const end = Date.now() + 1500
          while (Date.now() < end) {}
          return 'raced'
        `),
        parent,
      })
      await vi.waitFor(() => { expect(order.filter(entry => entry.startsWith('start:')).length).toBe(2) })
      const fast = provider.runs.find(run => (run.request.prompt[0] as { text?: string }).text === 'fast')!
      fast.settle(text('fast done'))
      handle.cancel('stop now')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      // fast's end is the worker's own report; slow's is host-synthesized at
      // the force-settle — exactly one end per started seq, no third event.
      expect(ends).toEqual([
        { seq: 2, outcome: 'completed' },
        { seq: 1, outcome: 'cancelled' },
      ])
      // Both ends reached observers BEFORE workflow/end: a progress consumer
      // can finalize its state at run-end without dangling agents.
      expect(order.indexOf('run-end')).toBe(order.length - 1)
      await handle.dispose()
    }, 15_000)

    it('graceful cancellation keeps pairing worker-authored: exactly one agent-end per start, nothing synthesized on top', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const ends: { seq: number; outcome: string }[] = []
      const order: string[] = []
      ctx.on('workflow/agent-end', (_info, agent) => {
        ends.push({ seq: agent.seq, outcome: agent.outcome })
        order.push(`end:${agent.seq}`)
      })
      ctx.on('workflow/end', () => { order.push('run-end') })
      const handle = ctx.workflows.start({
        ...scripted("await parallel([() => agent('a'), () => agent('b')])\nreturn 'unreachable'"),
        parent,
      })
      await vi.waitFor(() => { expect(provider.runs.length).toBe(2) })
      handle.cancel('user stop')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      // The live worker reported both pairs itself; the ledger must not add
      // a synthesized duplicate on any path that settles inside the grace.
      expect(ends.map(end => end.outcome)).toEqual(['cancelled', 'cancelled'])
      expect(new Set(ends.map(end => end.seq)).size).toBe(2)
      expect(order.indexOf('run-end')).toBe(order.length - 1)
      await handle.dispose()
    })
  })

  describe('worker death', () => {
    it('a worker that exits before settling reports an error result and reaps its children', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      // The child's dispose() REJECTS on top of the worker death: the reap
      // must contain it (warn, not crash) while still emptying the registry.
      const cancelled: string[] = []
      const provider: SubagentProvider = {
        name: 'doomed',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true },
        inheritsParentContext: false,
        start: () => ({
          id: AgentId('doomed-child'),
          result: new Promise(() => { /* never settles; the reap is the teardown */ }),
          cancel: (reason?: string) => { cancelled.push(reason ?? 'cancelled') },
          dispose: () => Promise.reject(new Error('dispose exploded during reap')),
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(WorkerWorkflowEngine, { provider: 'doomed', maxConcurrentAgents: 2 })
      const runEnds: WorkflowResultInfo[] = []
      ctx.on('workflow/end', (_info, result) => { runEnds.push(result) })
      const handle = ctx.workflows.start({
        // The stray child's start RPC reaches the host, then the script kills
        // its own worker through the documented vm escape — the host must
        // settle `error` with the exit diagnostics and wind the child down.
        ...scripted(`
          agent('doomed')
          const proc = ${ESCAPE}
          const st = globalThis.constructor.constructor('return setTimeout')()
          await new Promise(resolve => st(resolve, 200))
          proc.exit(7)
        `),
        parent: fakeParent(),
      })
      const result = await handle.result
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('exit code 7')
      expect(result.agentsStarted).toBe(1)
      // A worker death is a stop reason like any other: workflow/end fires
      // with the error outcome — for a bus observer it is the only obituary.
      expect(runEnds).toEqual([{ stopReason: 'error', error: result.error, agentsStarted: 1 }])
      await vi.waitFor(() => { expect(cancelled.length).toBe(1) })
      await handle.dispose()
    }, 15_000)

    it('an uncaught exception inside the worker surfaces as an error result and reaps the in-flight child', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const handle = ctx.workflows.start({
        ...scripted(`
          agent('in flight when the worker dies')
          const proc = ${ESCAPE}
          const st = globalThis.constructor.constructor('return setTimeout')()
          await new Promise(resolve => st(resolve, 200))
          proc.nextTick(() => { throw new Error('worker blew up') })
          await new Promise(() => {})
        `),
        parent,
      })
      const result = await handle.result
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('worker blew up')
      // The reap wound the stray child down (cancel + a CLEAN dispose).
      await vi.waitFor(() => {
        expect(provider.runs.length).toBe(1)
        expect(provider.runs[0]!.disposed).toBe(true)
      })
      await handle.dispose()
    }, 15_000)

    it('a worker death pairs every stranded start: the synthesized cancelled agent-end precedes the error workflow/end', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const ends: { seq: number; outcome: string }[] = []
      const order: string[] = []
      ctx.on('workflow/agent-start', (_info, agent) => { order.push(`start:${agent.seq}`) })
      ctx.on('workflow/agent-end', (_info, agent) => {
        ends.push({ seq: agent.seq, outcome: agent.outcome })
        order.push(`end:${agent.seq}`)
      })
      ctx.on('workflow/end', () => { order.push('run-end') })
      const handle = ctx.workflows.start({
        // Same choreography as the force-settle pairing test, but the worker
        // DIES (the documented vm escape) instead of being terminated: the
        // exit path must close slow's pair from the ledger too. The escaped
        // setTimeout lets the already-posted messages flush before the kill.
        ...scripted(`
          const p = agent('slow')
          await agent('fast')
          const proc = ${ESCAPE}
          const st = globalThis.constructor.constructor('return setTimeout')()
          await new Promise(resolve => st(resolve, 150))
          proc.exit(7)
        `),
        parent,
      })
      await vi.waitFor(() => { expect(order.filter(entry => entry.startsWith('start:')).length).toBe(2) })
      const fast = provider.runs.find(run => (run.request.prompt[0] as { text?: string }).text === 'fast')!
      fast.settle(text('fast done'))
      const result = await handle.result
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('exit code 7')
      expect(ends).toEqual([
        { seq: 2, outcome: 'completed' },
        { seq: 1, outcome: 'cancelled' },
      ])
      expect(order.indexOf('run-end')).toBe(order.length - 1)
      await handle.dispose()
    }, 15_000)

    it('a dispose ack racing the worker death is dropped, not crashed (post after exit)', async () => {
      // Slow child disposal: the ack resolves only AFTER the worker died, so
      // it has nowhere to go and must be dropped silently (the workerGone
      // guard in post()).
      const { ctx, parent, provider } = await setup({ disposeDelayMs: 300 })
      const handle = ctx.workflows.start({
        // The STRAY child settles instantly, so its wrapper starts the slow
        // host-side disposal concurrently while the script goes on to kill
        // its own worker — the ack then resolves into a dead thread.
        ...scripted(`
          agent('stray, never awaited')
          const proc = ${ESCAPE}
          const st = globalThis.constructor.constructor('return setTimeout')()
          await new Promise(resolve => st(resolve, 150))
          proc.exit(5)
        `),
        parent,
      })
      const result = await handle.result
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('exit code 5')
      await vi.waitFor(() => { expect(provider.runs[0]!.disposed).toBe(true) })
      await handle.dispose()
    }, 15_000)

    it('a worker death AFTER a cancel reports cancelled, not error', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub', disposeGraceMs: 60_000 } })
      const handle = ctx.workflows.start({
        ...scripted(`
          const proc = ${ESCAPE}
          const st = globalThis.constructor.constructor('return setTimeout')()
          log('armed')
          await new Promise(resolve => st(resolve, 400))
          proc.exit(3)
        `),
        parent,
      })
      const logs: string[] = []
      ctx.on('workflow/log', (_info, message) => { logs.push(message) })
      await vi.waitFor(() => { expect(logs).toContain('armed') })
      handle.cancel('stop it')
      // The grace is deliberately huge: only the worker's own death (exit 3,
      // unreachable by the cancel — the script ignores hooks) settles this.
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('stop it')
      await handle.dispose()
    }, 15_000)
  })

  describe('service surface', () => {
    it('run ids are unique per start; the run handle and event payloads hold SEPARATE meta clones', async () => {
      const { ctx, parent } = await setup()
      let eventMeta: WorkflowRunInfo | undefined
      ctx.on('workflow/start', (info) => { eventMeta = info })
      const first = ctx.workflows.start({ ...scripted('return 1'), parent })
      const second = ctx.workflows.start({ ...scripted('return 2'), parent })
      expect(first.id).not.toBe(second.id)
      eventMeta!.meta.name = 'corrupted'
      expect(second.meta.name).toBe('test-flow')
      await Promise.all([first.result, second.result])
      await first.dispose()
      await second.dispose()
    })

    it('unregisters ctx.workflows when the engine fiber is disposed (HMR safety), and default config runs (auto concurrency)', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const fiber = await ctx.plugin(WorkerWorkflowEngine, {})
      expect(ctx.get('workflows')).toBeDefined()
      // A zero-agent run through the DEFAULT config exercises the auto
      // concurrency resolution (cores - 2, capped) in start().
      const result = await run(ctx, fakeParent(), scripted('return 6 * 7'))
      expect(result.value).toBe(42)
      await fiber.dispose()
      expect(ctx.get('workflows')).toBeUndefined()
    })

    it('has the class-plugin export shape (default = the engine service class)', () => {
      expect(workerEngineModule.default).toBe(WorkerWorkflowEngine)
      const loader = Object.create(Loader.prototype) as Loader
      const unwrapped: unknown = loader.unwrapExports(workerEngineModule)
      expect(unwrapped).toBe(WorkerWorkflowEngine)
    })
  })
})
