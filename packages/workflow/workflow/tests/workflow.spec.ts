import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import WorkflowServiceDefault, {
  isFatalWorkflowError,
  WorkflowError,
  WorkflowRunId,
  WorkflowService,
} from '../src/index.ts'
import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '../src/index.ts'

/** A minimal concrete subclass exposing the protected emit helper for tests. */
class StubEngine extends WorkflowService {
  start(request: WorkflowStartRequest): WorkflowRun {
    void request
    throw new Error('not under test')
  }

  emit(name: Parameters<WorkflowService['emitWorkflowEvent']>[0], ...args: unknown[]): void {
    this.emitWorkflowEvent(name, ...args)
  }
}

const INFO: WorkflowRunInfo = { id: WorkflowRunId('run-1'), meta: { name: 'w', description: 'd' } }

describe('dsh-workflow (interface)', () => {
  it('WorkflowRunId brands a string (identity at runtime)', () => {
    expect(WorkflowRunId('abc')).toBe('abc')
  })

  it('WorkflowError carries code + fatal (default true) and reads as a HarnessError', () => {
    const error = new WorkflowError('cap hit', 'AGENT_CAP')
    expect(error.code).toBe('AGENT_CAP')
    expect(error.fatal).toBe(true)
    expect(error.name).toBe('WorkflowError')
    const soft = new WorkflowError('advisory', 'ITEM_CAP', { fatal: false })
    expect(soft.fatal).toBe(false)
  })

  it('isFatalWorkflowError: true only for a fatal WorkflowError', () => {
    expect(isFatalWorkflowError(new WorkflowError('x', 'CANCELLED'))).toBe(true)
    expect(isFatalWorkflowError(new WorkflowError('x', 'CANCELLED', { fatal: false }))).toBe(false)
    expect(isFatalWorkflowError(new Error('plain'))).toBe(false)
    expect(isFatalWorkflowError('string')).toBe(false)
  })

  it('registers as ctx.workflows and unregisters when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubEngine)
    expect(ctx.get('workflows')).toBeInstanceOf(StubEngine)
    await fiber.dispose()
    expect(ctx.get('workflows')).toBeUndefined()
  })

  it('emitWorkflowEvent dispatches to every listener with the payload tuple', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const seen: unknown[][] = []
    ctx.on('workflow/log', (info, message) => { seen.push([info, message]) })
    ctx.on('workflow/agent-start', (info, agent) => { seen.push([info, agent]) })
    const engine = ctx.workflows as StubEngine
    engine.emit('workflow/log', INFO, 'hello')
    engine.emit('workflow/agent-start', INFO, { seq: 1, label: 'l', childId: 'c' })
    expect(seen).toEqual([
      [INFO, 'hello'],
      [INFO, { seq: 1, label: 'l', childId: 'c' }],
    ])
  })

  it('gives each listener its OWN payload snapshot: mutation corrupts neither peers nor the caller', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const seen: string[] = []
    ctx.on('workflow/agent-start', (info, agent) => {
      agent.label = 'HACKED'
      info.meta.name = 'HACKED'
      seen.push('mutator')
    })
    ctx.on('workflow/agent-start', (info, agent) => {
      seen.push(`${info.meta.name}/${agent.label}`)
    })
    const engine = ctx.workflows as StubEngine
    const info: WorkflowRunInfo = { id: WorkflowRunId('run-2'), meta: { name: 'w', description: 'd' } }
    const payload = { seq: 1, label: 'original', childId: 'c' }
    engine.emit('workflow/agent-start', info, payload)
    expect(seen).toEqual(['mutator', 'w/original'])
    // The caller's own objects are pristine too — no listener ever saw them.
    expect(info.meta.name).toBe('w')
    expect(payload.label).toBe('original')
  })

  it('contains a throwing listener PER LISTENER: later listeners still run, nothing propagates', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const reached: string[] = []
    ctx.on('workflow/phase', () => { throw new Error('bad listener') })
    ctx.on('workflow/phase', (_info, title) => { reached.push(title) })
    const engine = ctx.workflows as StubEngine
    expect(() => { engine.emit('workflow/phase', INFO, 'Scan') }).not.toThrow()
    expect(reached).toEqual(['Scan'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('workflow/phase listener threw')
  })

  it('containment is total: a listener throwing a value whose coercion throws neither propagates nor starves later listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const reached: string[] = []
    ctx.on('workflow/phase', () => {
      throw { toString: () => { throw new Error('coercion trap') } }
    })
    ctx.on('workflow/phase', (_info, title) => { reached.push(title) })
    const engine = ctx.workflows as StubEngine
    expect(() => { engine.emit('workflow/phase', INFO, 'Scan') }).not.toThrow()
    expect(reached).toEqual(['Scan'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('[unrenderable thrown value]')
  })

  it('has the expected export surface (default = the abstract service class)', () => {
    expect(WorkflowServiceDefault).toBe(WorkflowService)
  })
})
