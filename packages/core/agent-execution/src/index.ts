/**
 * Process-local Agent execution context backed by Node AsyncLocalStorage.
 *
 * @module @deepseek-ai/dsh-agent-execution
 */

import type { Context } from 'cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentExecution } from './types.ts'

export type { AgentExecution } from './types.ts'

const NO_ACTIVE_EXECUTION = 'no agent execution context is active'
const DISPOSED_SERVICE = 'agent execution service is disposed'

/** Ambient Agent identity within one process-local asynchronous chain. */
export interface AgentExecutionService {
  /**
   * Read the active execution without requiring one.
   * @returns the inherited execution, or `undefined` outside/inside a cleared boundary.
   * @throws when this service instance has been disposed.
   */
  current(): AgentExecution | undefined

  /**
   * Read the active execution and fail when no boundary is active.
   * @returns the inherited execution.
   * @throws when no execution is active or this service instance has been disposed.
   */
  require(): AgentExecution

  /**
   * Run an operation inside an execution boundary. Passing `undefined` clears
   * an inherited execution; the exact synchronous value or Promise is returned.
   * @param execution - execution to inherit, or `undefined` for a clearing boundary.
   * @param operation - synchronous or asynchronous operation to invoke.
   * @returns the exact value returned by `operation`.
   * @throws when this service is closing/disposed, or when `operation` throws.
   */
  run<T>(execution: AgentExecution | undefined, operation: () => T): T
}

declare module 'cordis' {
  interface Context {
    agentExecution: AgentExecutionService
  }
}

/** One provider-owned ALS instance with quiescent shutdown. */
class DefaultAgentExecutionService implements AgentExecutionService {
  private readonly storage = new AsyncLocalStorage<AgentExecution | undefined>()
  private state: 'active' | 'closing' | 'disposed' = 'active'
  private activeRuns = 0
  private drainWaiter: PromiseWithResolvers<void> | undefined
  private disposalTask: Promise<void> | undefined

  current(): AgentExecution | undefined {
    this.assertReadable()
    return this.storage.getStore()
  }

  require(): AgentExecution {
    const execution = this.current()
    if (execution === undefined) throw new Error(NO_ACTIVE_EXECUTION)
    return execution
  }

  run<T>(execution: AgentExecution | undefined, operation: () => T): T {
    if (this.state !== 'active') throw new Error(DISPOSED_SERVICE)
    this.activeRuns += 1
    let result: T
    try {
      result = this.storage.run(execution, operation)
    } catch (error: unknown) {
      this.releaseRun()
      throw error
    }
    if (result instanceof Promise) {
      void result.then(
        () => { this.releaseRun() },
        () => { this.releaseRun() },
      )
    } else {
      this.releaseRun()
    }
    return result
  }

  /** Reject new boundaries while existing continuations remain readable. */
  close(): void {
    if (this.state === 'active') this.state = 'closing'
  }

  /** Wait for every returned Promise boundary, then invalidate retained references. */
  dispose(): Promise<void> {
    return (this.disposalTask ??= (async () => {
      this.close()
      if (this.activeRuns !== 0) {
        this.drainWaiter ??= Promise.withResolvers<void>()
        await this.drainWaiter.promise
      }
      this.state = 'disposed'
      this.storage.disable()
    })())
  }

  private assertReadable(): void {
    if (this.state === 'disposed') throw new Error(DISPOSED_SERVICE)
  }

  private releaseRun(): void {
    this.activeRuns -= 1
    if (this.activeRuns !== 0) return
    this.drainWaiter?.resolve()
    this.drainWaiter = undefined
  }
}

/** Cordis provider for the mandatory `ctx.agentExecution` service. */
export class AgentExecutionProvider {
  private readonly service = new DefaultAgentExecutionService()

  /**
   * Install one isolated execution service and its ordered lifecycle.
   * @param ctx - provider-owning Cordis context.
   */
  constructor(ctx: Context) {
    const service = this.service
    ctx.effect(function* () {
      // First yielded, disposed last: invalidate ALS only after dependents and active runs drain.
      yield () => service.dispose()
      yield ctx.provide('agentExecution', service)
      // Last yielded, disposed first: prevent a teardown race from opening another boundary.
      yield () => { service.close() }
    }, 'agentExecution.lifecycle()')
  }
}

export default AgentExecutionProvider
