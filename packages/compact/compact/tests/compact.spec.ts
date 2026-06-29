import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CompactService } from '@deepseek-ai/dsh-compact'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

/**
 * A trivial concrete CompactService implementing the abstract contract. The
 * interface package owns no algorithm — these tests exercise the seam itself:
 * service registration, the abstract method shape, and the `compact/*` event
 * declaration merge.
 */
class StubCompactService extends CompactService {
  /** Records the signal handed to the most recent call, to prove it threads through. */
  lastSignal: AbortSignal | undefined

  override async compactIfNeeded(
    _session: Session,
    _systemPrompt?: string,
    _model?: string,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null> {
    this.lastSignal = signal
    return null
  }

  override async compactRegion(
    session: Session,
    start: number,
    end: number,
    _model: string,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    this.lastSignal = signal
    // Minimal stub honoring the lock + log-only event contract.
    const startEvent = session.append('compact/start', { turn: 0 })
    const summaryEvent = session.append('compact/summary', {
      summary: [{ type: 'text', text: 'stub' }],
      shadowedRange: { start, end },
      shadowedSeqs: [],
      shadowedTokenCount: 0,
    })
    const endEvent = session.append('compact/end', { turn: 0 })
    return {
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: [{ type: 'text', text: 'stub' }],
      shadowedRange: { start, end },
      shadowedSeqs: [],
      shadowedTokenCount: 0,
    }
  }
}

describe('CompactService seam', () => {
  it('registers as ctx.compact', () => {
    const ctx = new Context()
    void new StubCompactService(ctx)
    expect(ctx.compact).toBeDefined()
    expect(ctx.compact).toBeInstanceOf(StubCompactService)
  })

  it('disposing the fiber unregisters ctx.compact (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubCompactService)
    expect(ctx.compact).toBeInstanceOf(StubCompactService)
    await fiber.dispose()
    expect(ctx.compact).toBeUndefined()
  })

  it('exposes the abstract contract methods', async () => {
    const ctx = new Context()
    const svc = new StubCompactService(ctx)
    expect(await svc.compactIfNeeded(new Session(SessionId('s')))).toBeNull()
  })

  it('compact/* events merge into SessionEventMap and are log-only', async () => {
    const ctx = new Context()
    const svc = new StubCompactService(ctx)
    const session = new Session(SessionId('s'))

    const result = await svc.compactRegion(session, 0, 0, 'm')

    const startEvent = session.events.find(e => e.type === 'compact/start')
    expect(startEvent).toBeDefined()
    // Log-only: the compiler rejects surfaceOp on compact/* (not a SurfaceEventType);
    // verify the runtime value is absent.
    const raw = startEvent as unknown as { surfaceOp?: unknown }
    expect(raw.surfaceOp).toBeUndefined()
    expect(result.summarySeq).toBeGreaterThan(result.startSeq)
    expect(result.endSeq).toBeGreaterThan(result.summarySeq)
  })

  it('threads the cancellation signal through to the backend', async () => {
    const ctx = new Context()
    const svc = new StubCompactService(ctx)
    const session = new Session(SessionId('s'))
    const controller = new AbortController()

    await svc.compactRegion(session, 0, 0, 'm', controller.signal)
    expect(svc.lastSignal).toBe(controller.signal)

    await svc.compactIfNeeded(session, undefined, undefined, controller.signal)
    expect(svc.lastSignal).toBe(controller.signal)
  })
})
