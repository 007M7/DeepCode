/**
 * Disposable live timer projection for one exact root agent.
 * @module @deepseek-ai/dsh-tool-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AfterScheduleRecord } from './types.ts'
import { foldScheduleEvents, renderReminderFraming, ScheduleLogError } from './domain.ts'
import { flushSchedulePersistence } from './persistence.ts'
import { runScheduleTransaction } from './transaction.ts'

/** Largest delay that Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Select the earliest target while preserving create order for ties. */
function earliest(records: readonly AfterScheduleRecord[]): AfterScheduleRecord | undefined {
  let selected: AfterScheduleRecord | undefined
  let selectedAt = Number.POSITIVE_INFINITY
  for (const record of records) {
    const target = Date.parse(record.scheduledAt)
    if (target < selectedAt) {
      selected = record
      selectedAt = target
    }
  }
  return selected
}

/** Render an unknown value for process-local diagnostics only. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** One process-local, disposable projection of an exact agent's durable schedules. */
export class ScheduleOwner {
  private readonly stop = Promise.withResolvers<void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private idleWait: Promise<void> | undefined
  private run: Promise<void> | undefined
  private requested = false
  private stopping = false
  private faulted = false
  private disposal: Promise<void> | undefined

  /**
   * Construct an inactive owner; {@link start} begins the first preflight.
   * @param ctx - Global service context.
   * @param agent - Exact live root agent.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {}

  /** Begin the initial durability preflight and timer derivation. */
  start(): void {
    this.requestDrive()
  }

  /** Recompute the live projection after a committed mutation or idle transition. */
  requestDrive(): void {
    if (this.stopping || this.faulted) return
    this.clearTimer()
    this.requested = true
    if (this.run !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(() => this.runRequested())
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`tool-schedule: could not start owner for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    this.run = run
    void run.then(
      () => { this.retire(run) },
      (error: unknown) => {
        if (this.isLive()) {
          this.ctx.logger.warn(`tool-schedule: owner failed for agent "${this.agent.id}": ${renderThrown(error)}`)
        }
        this.faulted = true
        this.retire(run)
      },
    )
  }

  /** Stop future work, cancel timers, and await every outstanding owner promise. */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopping = true
      this.requested = false
      this.clearTimer()
      this.stop.resolve()
      const pending = [this.run, this.idleWait].filter((value): value is Promise<void> => value !== undefined)
      await Promise.allSettled(pending)
    })())
  }

  /** Drain coalesced triggers serially. */
  private async runRequested(): Promise<void> {
    while (this.requested && !this.stopping && !this.faulted) {
      this.requested = false
      await runScheduleTransaction(this.agent, () => this.driveOnce())
    }
  }

  /** Retire one exact run and honor a trigger that landed during its final microtask. */
  private retire(run: Promise<void>): void {
    /* v8 ignore next -- only the exact stored run installs this callback. */
    if (this.run !== run) return
    this.run = undefined
    /* v8 ignore next -- covers a trigger in the promise-settlement microtask gap. */
    if (this.requested && !this.stopping && !this.faulted) this.requestDrive()
  }

  /** Whether this exact root lifecycle remains authoritative. */
  private isLive(): boolean {
    return this.ctx.agents.get(this.agent.id) === this.agent
      && this.ctx.agents.roots().includes(this.agent)
  }

  /** Cancel the currently armed timer, if any. */
  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arm one bounded timer segment; every wake rechecks the wall clock. */
  private arm(target: number, now: number): void {
    const delay = Math.min(target - now, MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }

  /** Await one public idle boundary without holding admission or creating a retry timer. */
  private waitForIdle(): void {
    if (this.idleWait !== undefined) return
    const wait = Promise.race([this.agent.whenIdle(), this.stop.promise])
    this.idleWait = wait
    void wait.then(
      () => {
        this.idleWait = undefined
        this.requestDrive()
      },
      (error: unknown) => {
        this.idleWait = undefined
        if (this.isLive()) {
          this.ctx.logger.warn(`tool-schedule: idle wait failed for agent "${this.agent.id}": ${renderThrown(error)}`)
        }
      },
    )
  }

  /** Fold the current exact owner suffix and contain a corrupt durable stream. */
  private readEarliest(): AfterScheduleRecord | undefined {
    try {
      const folded = foldScheduleEvents(
        this.agent.session.events,
        this.agent.session.header.seedLength ?? 0,
      )
      return earliest(folded.active)
    } catch (error: unknown) {
      this.faulted = true
      const detail = error instanceof ScheduleLogError ? error.message : renderThrown(error)
      this.ctx.logger.warn(`tool-schedule: corrupt schedule log for agent "${this.agent.id}": ${detail}`)
      return undefined
    }
  }

  /** Preflight, fold, arm, or dispatch the next active one-shot reminder. */
  private async driveOnce(): Promise<void> {
    this.clearTimer()
    if (this.stopping || !this.isLive()) return
    try {
      await flushSchedulePersistence(this.ctx, this.agent.session)
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`tool-schedule: preflight failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal or replacement can win while persistence is awaited.
    if (this.stopping || !this.isLive()) return

    const record = this.readEarliest()
    if (record === undefined) return

    const target = Date.parse(record.scheduledAt)
    const wakeNow = Date.now()
    if (wakeNow < target) {
      this.arm(target, wakeNow)
      return
    }

    let maintenance: Promise<boolean>
    try {
      maintenance = this.agent.runMaintenance(() => {
        if (this.stopping || !this.isLive()) return Promise.resolve(false)
        const claimedRecord = this.readEarliest()
        if (claimedRecord === undefined) return Promise.resolve(false)
        const claimedTarget = Date.parse(claimedRecord.scheduledAt)
        const decisionNow = Date.now()
        if (decisionNow < claimedTarget) {
          this.arm(claimedTarget, decisionNow)
          return Promise.resolve(false)
        }
        try {
          const message = createUserMessage({
            content: [{ type: 'text', text: renderReminderFraming(claimedRecord) }],
            source: { kind: 'plugin', plugin: 'tool-schedule' },
          })
          this.agent.followup(message)
        } catch (error: unknown) {
          if (this.isLive()) {
            this.ctx.logger.warn(`tool-schedule: framing or followup failed for agent "${this.agent.id}": ${renderThrown(error)}`)
          }
          return Promise.resolve(false)
        }
        try {
          this.agent.session.append('schedule/change', {
            version: 1,
            operation: 'dispatch',
            id: claimedRecord.id,
          })
        } catch (error: unknown) {
          this.faulted = true
          this.clearTimer()
          this.ctx.logger.warn(`tool-schedule: dispatch append failed for agent "${this.agent.id}": ${renderThrown(error)}`)
          return Promise.resolve(false)
        }
        return Promise.resolve(true)
      })
    } catch (_busy: unknown) {
      // `runMaintenance` rejects synchronously only while another agent activity owns the idle phase.
      if (this.isLive()) this.waitForIdle()
      return
    }
    if (!await maintenance) return

    try {
      await flushSchedulePersistence(this.ctx, this.agent.session)
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`tool-schedule: dispatch barrier failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can win while the barrier is awaited.
    if (!this.stopping && this.isLive()) this.requestDrive()
  }
}
