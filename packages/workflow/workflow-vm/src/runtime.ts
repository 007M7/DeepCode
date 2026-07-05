/**
 * Per-run execution state for the vm workflow engine: the script context and
 * its injected hooks (`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`), the
 * concurrency semaphore and caps, cancellation, and the drive loop that turns
 * a script settlement into a {@link WorkflowResult}.
 *
 * Value boundary (the trust premise lives in ./realm.ts): values ENTERING the
 * host from the script (hook options, schemas, the return value) are
 * materialized by `materializeFromRealm` — a plain walk that rejects loud
 * everything JSON cannot carry. Values ENTERING the realm (`args`, `agent()`
 * results, hook promises and their failures, combinator arrays) are handed
 * over DIRECTLY as host values: the script is model-written and trusted, so
 * host prototypes are not a leak. `args` is host-side `structuredClone`d once
 * at start so a script scribbling on it cannot mutate the caller's object —
 * that is a benign-bug guard, not isolation. Realm functions (pipeline
 * stages, parallel thunks) are called, not materialized — their values stay
 * realm-side until they cross through a hook or the final return.
 *
 * Failure discipline: fatal {@link WorkflowError}s (bad hook arguments,
 * unsupported options/schemas, tripped caps, seam start failures,
 * cancellation) ALWAYS propagate through `parallel`/`pipeline` — recognized
 * by host `instanceof`, which a script cannot forge — and the per-item `null`
 * is reserved for child-run failures and ordinary in-stage script errors.
 * Every hook-returned promise gets a no-op rejection consumer attached, so a
 * script that drops a promise (fires an `agent()` without awaiting it) cannot
 * surface an unhandled rejection when cancellation rejects it — the app boot
 * layer exits the process on unhandled rejections.
 *
 * @module @deepseek-ai/dsh-workflow-vm/runtime
 */

import * as vm from 'node:vm'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { assertSupportedOutputSchema, OutputSchemaError } from '@deepseek-ai/dsh-tools'
import type { StructuredOutputSchema } from '@deepseek-ai/dsh-tools'
import { isFatalWorkflowError, WorkflowError } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowResult,
} from '@deepseek-ai/dsh-workflow'
import { materializeFromRealm, MaterializeError, renderThrown } from './realm.ts'

/** The per-run knobs the engine resolves from its Config. */
export interface ExecutionLimits {
  /** The `ctx.subagents` provider name to start children on. */
  provider: string
  /** Concurrent `agent()` ceiling (already auto-resolved; ≥ 1). */
  maxConcurrentAgents: number
  /** Total `agent()` calls per run (the runaway-loop backstop). */
  maxTotalAgents: number
  /** Items accepted by one `parallel()`/`pipeline()` call. */
  maxItemsPerCall: number
  /** vm timeout for the script's initial synchronous slice. */
  syncTimeoutMs: number
  /** How long after `cancel()` a still-unsettled script is abandoned (result force-settles `cancelled`). */
  disposeGraceMs: number
}

/** The engine-side observers the execution reports progress through. */
export interface ExecutionObserver {
  phase(title: string): void
  log(message: string): void
  agentStart(info: WorkflowAgentInfo): void
  agentEnd(info: WorkflowAgentEndInfo): void
}

/** The `agent()` options the script may pass; everything else rejects loud. */
const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'model'])
/** Deferred Claude Code options we name explicitly in the rejection message. */
const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])

/** The in-context prelude that bans the nondeterminism sources (kept even though resume is deferred, so scripts stay resume-compatible). */
const DETERMINISM_PRELUDE = `
{
  const banned = (name) => () => {
    throw new Error(name + ' is not available in workflow scripts (runs must stay deterministic for future resume support; pass timestamps in via args)')
  }
  Math.random = banned('Math.random()')
  Date.now = banned('Date.now()')
  const RealDate = Date
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) banned('argless new Date()')()
      return Reflect.construct(target, args, newTarget)
    },
    apply: banned('Date()'),
  })
}
`

/** Flatten a child's final output blocks to text (the non-schema `agent()` result). */
function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** A short display label derived from the prompt when the script passes none. */
function defaultLabel(prompt: string): string {
  const newline = prompt.indexOf('\n')
  const line = newline === -1 ? prompt : prompt.slice(0, newline)
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`
}

/**
 * One live script execution. Constructed per run by the engine; `drive()` is
 * called exactly once and NEVER rejects — every failure becomes a
 * {@link WorkflowResult} with a non-`completed` stop reason.
 */
export class WorkflowExecution {
  /** 1-based count of `agent()` calls started (the `agentsStarted` result field). */
  private started = 0
  private activeSlots = 0
  private readonly slotWaiters: { resolve(): void; reject(error: unknown): void }[] = []
  private cancelReason: string | undefined
  private cancelError: WorkflowError | undefined
  private readonly controller = new AbortController()
  private currentPhase: string | undefined
  private readonly context: vm.Context
  private readonly compiled: vm.Script
  /** Every live `agent()` call promise — awaited or stray — for {@link quiesce}. */
  private readonly inFlightAgents = new Set<Promise<unknown>>()
  /** Fires {@link abandoned}; assigned by the promise executor at field initialization. */
  private declareAbandoned!: () => void
  private abandonTimer: NodeJS.Timeout | undefined
  /**
   * Rejects `disposeGraceMs` after {@link cancel} if the script has not
   * settled by then. `drive()` races the script against it, so `result`
   * ALWAYS settles within the grace of a cancellation — even when the script
   * is parked on a promise no hook owns (`await new Promise(() => {})`), which
   * cancellation cannot reject. Without this, a consumer awaiting `result`
   * before disposing (the tool's shape) would hang forever on such a script,
   * wedging its caller past any abort.
   */
  private readonly abandoned = new Promise<never>((_, reject) => {
    this.declareAbandoned = () => { reject(new WorkflowError('workflow script abandoned after the cancellation grace', 'CANCELLED')) }
  })

  constructor(
    private readonly ctx: Context,
    meta: WorkflowMeta,
    body: string,
    private readonly parent: Agent,
    args: unknown,
    signal: AbortSignal | undefined,
    private readonly limits: ExecutionLimits,
    private readonly observer: ExecutionObserver,
  ) {
    // Compile FIRST: a body syntax error must throw out of the constructor
    // (the engine maps it to SCRIPT_PARSE) before any realm state exists.
    // lineOffset compensates for the wrapper line, so stack traces carry the
    // script's own line numbers (the meta statement was blanked, not removed).
    try {
      this.compiled = new vm.Script(`(async () => {\n${body}\n})()`, {
        filename: `workflow:${meta.name}`,
        lineOffset: -1,
      })
    } catch (error: unknown) {
      throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
    }

    this.context = vm.createContext({}, { name: `workflow:${meta.name}` })
    vm.runInContext(DETERMINISM_PRELUDE, this.context)
    // A run that settles without ever being abandoned leaves `abandoned`
    // permanently pending or rejecting into the void — consume it so a late
    // grace timer cannot surface an unhandled rejection.
    void this.contain(this.abandoned)

    const globals: Record<string, unknown> = {
      agent: (prompt: unknown, opts?: unknown) => this.contain(this.track(this.agent(prompt, opts))),
      parallel: (thunks: unknown) => this.contain(this.parallel(thunks)),
      pipeline: (items: unknown, ...stages: unknown[]) => this.contain(this.pipeline(items, stages)),
      phase: (title: unknown) => { this.phase(title) },
      log: (message: unknown) => { this.log(message) },
      // Host-side clone: a script scribbling on args must not mutate the
      // caller's object (a benign-bug guard; args is plain JSON by the seam
      // contract, so structuredClone is total here and throws loud otherwise).
      args: args === undefined ? undefined : structuredClone(args),
    }
    for (const [key, value] of Object.entries(globals)) {
      // Data properties on the contextified global; frozen shape not required —
      // a script overwriting its own hooks only sabotages itself.
      ;(this.context as Record<string, unknown>)[key] = typeof value === 'function' ? Object.freeze(value) : value
    }

    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else {
      signal?.addEventListener('abort', () => { this.cancel('workflow signal aborted') }, { once: true })
    }
  }

  /**
   * Whether the run has been cancelled. A METHOD, not an inline property
   * read: `cancel()` mutates `cancelReason` concurrently (a signal listener,
   * a raced dispose), and an inline read after an `await` gets narrowed by
   * control flow into an always-false comparison.
   */
  private isCancelled(): boolean {
    return this.cancelReason !== undefined
  }

  /**
   * Cancel the run: children abort (the shared signal), waiting `agent()`
   * slots reject, and every future hook call throws `CANCELLED` — the script
   * dies at its next await. A script that STILL has not settled after
   * `disposeGraceMs` (parked on a promise no hook owns) is abandoned so
   * `result` settles regardless (see {@link abandoned}). Idempotent; the
   * first reason wins.
   */
  cancel(reason?: string): void {
    if (this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.cancelError = new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
    this.controller.abort(this.cancelReason)
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(this.cancelledError())
    this.abandonTimer = setTimeout(() => { this.declareAbandoned() }, this.limits.disposeGraceMs)
    // unref'd: an armed grace timer must never hold the process open.
    this.abandonTimer.unref()
  }

  /**
   * Run the script to settlement. Resolves — never rejects — with the run's
   * {@link WorkflowResult}: the materialized return value on `completed`, the
   * failure message on `error`, and `cancelled` when the script died of
   * cancellation (or outlived its post-cancel grace and was abandoned — see
   * {@link abandoned}). After settlement, any stray children a script fired
   * without awaiting are aborted (their `agent()` wrappers dispose them).
   */
  async drive(): Promise<WorkflowResult> {
    try {
      // Cancelled before the body ever ran (an already-aborted start signal):
      // the script must not execute at all, let alone report `completed`.
      if (this.isCancelled()) throw this.cancelledError()
      const scriptPromise = this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs }) as Promise<unknown>
      // The race is the result-settles-after-cancel guarantee: a parked
      // script loses to the abandon channel once the grace expires.
      const raw: unknown = await Promise.race([this.contain(Promise.resolve(scriptPromise)), this.abandoned])
      // Cancelled while the body ran: a script that settled without touching
      // another hook (or without any) must still report `cancelled` — the
      // holder asked for cancellation and `completed` would be a lie.
      if (this.isCancelled()) throw this.cancelledError()
      const value = raw === undefined ? null : this.materializeResult(raw)
      return { value, stopReason: 'completed', agentsStarted: this.started }
    } catch (error: unknown) {
      // Any failure after cancel() reports `cancelled` with the canonical
      // reason — the reject path mirrors the resolve path's post-settle check.
      if (this.isCancelled()) {
        return { value: null, stopReason: 'cancelled', error: this.cancelledError().message, agentsStarted: this.started }
      }
      // renderThrown is total (host- and realm-thrown values alike), so this
      // arm cannot throw — drive() resolving is the `result` never-rejects
      // seam contract.
      return { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: this.started }
    } finally {
      // Reap strays: a script that fired agent() calls without awaiting them
      // leaves live children behind after settlement — abort them all. (The
      // per-call wrappers dispose each child; the contain() consumer keeps
      // their rejections from going unhandled.)
      if (this.cancelReason === undefined) this.cancel('workflow settled')
      // drive() settling means nothing is left to abandon — including the
      // timer the self-cancel above just armed.
      if (this.abandonTimer !== undefined) clearTimeout(this.abandonTimer)
    }
  }

  /**
   * Attach a no-op rejection consumer WITHOUT changing what the caller
   * receives: if the script drops the promise (no await), cancellation cannot
   * become an unhandled rejection (the app boot layer exits the process on
   * those); if the script does await it, it still observes the rejection.
   */
  private contain<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => { /* consumed: see method contract — a dropped hook promise must not surface an unhandled rejection */ })
    return promise
  }

  /**
   * Register one `agent()` call promise for {@link quiesce} tracking; the
   * entry drops when the call fully settles (which is AFTER its child's
   * `dispose()` — the call wrapper disposes in its `finally`).
   */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlightAgents.add(promise)
    const drop = (): void => { this.inFlightAgents.delete(promise) }
    promise.then(drop, drop)
    return promise
  }

  /**
   * Settles once every `agent()` call — awaited or stray — has fully settled,
   * INCLUDING each child's `dispose()`. The reap in {@link drive}'s finally
   * aborts strays; this is the wait for those aborts to reach quiescence, so
   * the engine's `dispose()` cannot return while a child is still winding
   * down. Never rejects (the tracked promises' rejections are contained).
   */
  async quiesce(): Promise<void> {
    while (this.inFlightAgents.size > 0) {
      await Promise.allSettled([...this.inFlightAgents])
    }
  }

  private cancelledError(): WorkflowError {
    // cancel() arms cancelError before any caller can observe isCancelled()
    // === true; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    return this.cancelError ?? new WorkflowError('workflow run cancelled', 'CANCELLED')
  }

  /** Materialize the script's return value; violations become RESULT_UNSERIALIZABLE. */
  private materializeResult(raw: unknown): unknown {
    try {
      return materializeFromRealm(raw, 'workflow result')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(
        `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        'RESULT_UNSERIALIZABLE',
        { cause: error },
      )
    }
  }

  /**
   * Acquire one concurrency slot (FIFO). Cancellation rejects QUEUED waiters
   * (see {@link cancel}); the callers guard their own entry and post-acquire
   * windows, so no cancelled-precheck is duplicated here.
   */
  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({
        resolve: () => {
          this.activeSlots += 1
          resolve()
        },
        reject,
      })
    })
  }

  private releaseSlot(): void {
    this.activeSlots -= 1
    const next = this.slotWaiters.shift()
    if (next) next.resolve()
  }

  /** The `agent(prompt, opts)` hook. */
  private async agent(rawPrompt: unknown, rawOpts: unknown): Promise<unknown> {
    if (this.isCancelled()) throw this.cancelledError()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = this.readAgentOptions(rawOpts)
    if (this.started >= this.limits.maxTotalAgents) {
      throw new WorkflowError(
        `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise maxTotalAgents in the engine config if the scale is intentional`,
        'AGENT_CAP',
      )
    }
    this.started += 1
    const seq = this.started
    const label = opts.label ?? defaultLabel(rawPrompt)
    const phase = opts.phase ?? this.currentPhase

    await this.acquireSlot()
    try {
      // Re-check after the acquire: the await yields at least one microtask
      // tick even when a slot is free, and a queued waiter resumes a tick
      // after its release — a cancel() landing in either window must not
      // start a child (it would carry an ALREADY-aborted signal, which a
      // provider subscribing only to future abort events would never see).
      if (this.isCancelled()) throw this.cancelledError()
      let run
      try {
        run = this.ctx.subagents.start(this.limits.provider, {
          prompt: [{ type: 'text', text: rawPrompt }],
          parent: this.parent,
          signal: this.controller.signal,
          ...opts.schema !== undefined ? { outputSchema: opts.schema } : {},
          ...opts.model !== undefined ? { agentOptions: { model: opts.model } } : {},
        })
      } catch (error: unknown) {
        throw new WorkflowError(`agent() could not start a child on provider "${this.limits.provider}": ${String(error)}`, 'AGENT_START', { cause: error })
      }
      const info: WorkflowAgentInfo = { seq, label, ...phase !== undefined ? { phase } : {}, childId: run.id }
      this.observer.agentStart(info)
      try {
        const result = await run.result
        if (result.stopReason === 'completed') {
          if (opts.schema !== undefined) {
            // The provider honored outputSchema (capability-gated at start), so
            // a completed run without a structured value is a child failure.
            if (result.structured === undefined) {
              this.observer.agentEnd({ ...info, outcome: 'failed' })
              return null
            }
            this.observer.agentEnd({ ...info, outcome: 'completed' })
            return result.structured
          }
          this.observer.agentEnd({ ...info, outcome: 'completed' })
          return outputText(result.output)
        }
        // A cancelled RUN kills the script; a child that failed for its own
        // reasons resolves null (scripts .filter(Boolean) per the CC contract).
        if (this.isCancelled()) {
          this.observer.agentEnd({ ...info, outcome: 'cancelled' })
          throw this.cancelledError()
        }
        this.observer.agentEnd({ ...info, outcome: 'failed' })
        return null
      } finally {
        await run.dispose()
      }
    } finally {
      this.releaseSlot()
    }
  }

  /** Materialize + validate the `agent()` options bag from the realm. */
  private readAgentOptions(rawOpts: unknown): { label?: string; phase?: string; model?: string; schema?: StructuredOutputSchema } {
    if (rawOpts === undefined) return {}
    let opts: unknown
    try {
      opts = materializeFromRealm(rawOpts, 'agent() options')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(`agent() options must be plain JSON data — ${error.message}`, 'INVALID_ARGUMENT', { cause: error })
    }
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new WorkflowError('agent() options must be an object', 'INVALID_ARGUMENT')
    }
    const record = opts as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
      if (DEFERRED_AGENT_OPTIONS.has(key)) {
        throw new WorkflowError(`agent() option "${key}" is deferred and not supported by this engine (supported: label, phase, schema, model)`, 'UNSUPPORTED_OPTION')
      }
      throw new WorkflowError(`agent() option "${key}" is not recognized (supported: label, phase, schema, model)`, 'UNSUPPORTED_OPTION')
    }
    for (const key of ['label', 'phase', 'model'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'string') {
        throw new WorkflowError(`agent() option "${key}" must be a string`, 'INVALID_ARGUMENT')
      }
    }
    let schema: StructuredOutputSchema | undefined
    if (record.schema !== undefined) {
      try {
        assertSupportedOutputSchema(record.schema)
        schema = record.schema
      } catch (error: unknown) {
        /* v8 ignore next -- defensive rethrow arm: assertSupportedOutputSchema only throws OutputSchemaError */
        if (!(error instanceof OutputSchemaError)) throw error
        throw new WorkflowError(`agent() schema is outside the supported subset — ${error.message}`, 'UNSUPPORTED_SCHEMA', { cause: error })
      }
    }
    return {
      ...record.label !== undefined ? { label: record.label as string } : {},
      ...record.phase !== undefined ? { phase: record.phase as string } : {},
      ...record.model !== undefined ? { model: record.model as string } : {},
      ...schema !== undefined ? { schema } : {},
    }
  }

  /** The `parallel(thunks)` hook: each thunk caught → `null`; fatal errors propagate. */
  private async parallel(rawThunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(rawThunks)) {
      throw new WorkflowError('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawThunks.length, 'parallel()')
    const thunks = rawThunks.map((thunk, index) => {
      if (typeof thunk !== 'function') {
        throw new WorkflowError(`parallel() item ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return thunk as () => unknown
    })
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk()
      } catch (error: unknown) {
        // Hook failures are host WorkflowErrors; a fatal one is recognized by
        // host `instanceof` — a script-built object can never pass it, so
        // fatality cannot be forged (nor accidentally dissolved).
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  /** The `pipeline(items, ...stages)` hook: per-item stage chains, NO cross-stage barrier. */
  private async pipeline(rawItems: unknown, rawStages: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('pipeline() requires an items array', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'pipeline()')
    if (rawStages.length === 0) {
      throw new WorkflowError('pipeline() requires at least one stage function', 'INVALID_ARGUMENT')
    }
    const stages = rawStages.map((stage, index) => {
      if (typeof stage !== 'function') {
        throw new WorkflowError(`pipeline() stage ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return stage as (previous: unknown, item: unknown, index: number) => unknown
    })
    return Promise.all(rawItems.map(async (item: unknown, index) => {
      let value: unknown = item
      try {
        for (const stage of stages) {
          value = await stage(value, item, index)
        }
        return value
      } catch (error: unknown) {
        // An ordinary stage throw drops the ITEM to null and skips its
        // remaining stages; a fatal host WorkflowError (see parallel()) kills
        // the whole script.
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  private assertItemCap(length: number, hook: string): void {
    if (length > this.limits.maxItemsPerCall) {
      throw new WorkflowError(
        `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise maxItemsPerCall in the engine config`,
        'ITEM_CAP',
      )
    }
  }

  /** The `phase(title)` hook: sets the current label for subsequent `agent()` calls and notifies observers. */
  private phase(title: unknown): void {
    if (typeof title !== 'string' || title.length === 0) {
      throw new WorkflowError('phase() requires a non-empty title string', 'INVALID_ARGUMENT')
    }
    this.currentPhase = title
    this.observer.phase(title)
  }

  /** The `log(message)` hook: narration to observers. */
  private log(message: unknown): void {
    if (typeof message !== 'string') {
      throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    }
    this.observer.log(message)
  }
}
