/** Unit coverage for unpublished Session preparation ownership and sharing. */

import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { observeQueuedAbort, SessionPreparations } from '../src/preparations.ts'

interface PreparedSource {
  readonly session: Session
  readonly label: string
}

function prepared(label: string): PreparedSource {
  return { session: Session.create(SessionId(label)), label }
}

function committed(source: PreparedSource): Promise<{ source: PreparedSource; state: string }> {
  return Promise.resolve({ source, state: source.label })
}

describe('SessionPreparations inspection', () => {
  it('shares in-flight and ready sources, then invalidates them', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(2)
    const id = SessionId('shared-inspection')
    const gate = Promise.withResolvers<PreparedSource>()
    const load = vi.fn(() => gate.promise)
    const first = preparations.inspect(id, load)
    const second = preparations.inspect(id, load, new AbortController().signal)
    const source = prepared(id)

    expect(preparations.has(id)).toBe(true)
    gate.resolve(source)
    await expect(first).resolves.toBe(source)
    await expect(second).resolves.toBe(source)
    await expect(preparations.inspect(id, load)).resolves.toBe(source)
    expect(load).toHaveBeenCalledOnce()

    preparations.invalidate(id)
    preparations.invalidate(id)
    expect(preparations.has(id)).toBe(false)
  })

  it('removes failed and invalidated in-flight loads without changing their observers', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const failedId = SessionId('failed-inspection')
    const failure = new Error('load failed')
    await expect(preparations.inspect(failedId, () => Promise.reject(failure))).rejects.toBe(failure)
    expect(preparations.has(failedId)).toBe(false)

    const invalidatedId = SessionId('invalidated-inspection')
    const gate = Promise.withResolvers<PreparedSource>()
    const inspection = preparations.inspect(invalidatedId, () => gate.promise)
    preparations.invalidate(invalidatedId)
    const source = prepared(invalidatedId)
    gate.resolve(source)
    await expect(inspection).resolves.toBe(source)
    expect(preparations.has(invalidatedId)).toBe(false)

    const rejectedId = SessionId('invalidated-rejection')
    const rejectedGate = Promise.withResolvers<PreparedSource>()
    const rejected = preparations.inspect(rejectedId, () => rejectedGate.promise)
    preparations.invalidate(rejectedId)
    rejectedGate.reject(failure)
    await expect(rejected).rejects.toBe(failure)
  })

  it('evicts ready entries while leaving reserved entries alone', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const reservedA = await preparations.reserve(
      SessionId('reserved-a'),
      () => Promise.resolve(prepared('reserved-a')),
      committed,
    )
    const reservedB = await preparations.reserve(
      SessionId('reserved-b'),
      () => Promise.resolve(prepared('reserved-b')),
      committed,
    )
    expect(reservedA).toBeDefined()
    expect(reservedB).toBeDefined()

    await preparations.inspect(SessionId('ready-c'), () => Promise.resolve(prepared('ready-c')))
    preparations.release(reservedA!, true)
    expect(preparations.has(SessionId('reserved-b'))).toBe(true)
    expect(preparations.has(SessionId('ready-c'))).toBe(false)
    expect(preparations.has(SessionId('reserved-a'))).toBe(true)

    preparations.discard(reservedB!)
    preparations.invalidate(SessionId('reserved-a'))
  })
})

describe('SessionPreparations reservation', () => {
  it('waits for an existing reservation, republishes the exact Session, and attaches once', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(2)
    const id = SessionId('reservation-wait')
    const source = prepared(id)
    const first = await preparations.reserve(id, () => Promise.resolve(source), committed)
    expect(first).toBeDefined()
    expect(preparations.reservationFor(source.session)).toBe(first)
    expect(() => preparations.reservationFor(Session.create(id))).toThrow(/cannot publish/)
    expect(() => preparations.assertWritable(id)).toThrow(/is reserved/)

    let secondSettled = false
    const secondPromise = preparations.reserve(id, () => Promise.resolve(prepared('unused')), committed)
      .then((reservation) => {
        secondSettled = true
        return reservation
      })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    preparations.release(first!, true)
    const second = await secondPromise
    expect(second?.source).toBe(source)
    preparations.attach(second!)
    expect(preparations.reservationFor(source.session)).toBeUndefined()
    expect(() => preparations.attach(second!)).toThrow(/no longer reserved/)
    preparations.discard(second!)
    preparations.release(second!, true)
    expect(() => preparations.assertWritable(id)).not.toThrow()
  })

  it('supports abortable reservation waits without cancelling the held reservation', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const id = SessionId('abortable-reservation-wait')
    const first = await preparations.reserve(id, () => Promise.resolve(prepared(id)), committed)
    const controller = new AbortController()
    const reason = { kind: 'cancelled' }
    const waiting = preparations.reserve(id, () => Promise.resolve(prepared('unused')), committed, controller.signal)

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(preparations.reservationFor(first!.source.session)).toBe(first)
    preparations.release(first!, false)
    expect(preparations.has(id)).toBe(false)
  })

  it('removes a failed commit and wakes another waiter as invalidated', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const id = SessionId('failed-commit')
    const commitStarted = Promise.withResolvers<undefined>()
    const commitGate = Promise.withResolvers<{ source: PreparedSource; state: string }>()
    const source = prepared(id)
    const failure = new Error('commit failed')
    const first = preparations.reserve(id, () => Promise.resolve(source), () => {
      commitStarted.resolve(undefined)
      return commitGate.promise
    })
    await commitStarted.promise
    expect(() => preparations.assertWritable(id)).toThrow(/is reserved/)
    const second = preparations.reserve(id, () => Promise.resolve(prepared('unused')), committed)

    commitGate.reject(failure)
    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toBeUndefined()
    expect(preparations.has(id)).toBe(false)
  })

  it('returns a post-commit cancellation to the ready pool', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const id = SessionId('post-commit-cancel')
    const source = prepared(id)
    const controller = new AbortController()
    const reason = new Error('cancel after commit')

    await expect(preparations.reserve(id, () => Promise.resolve(source), async value => {
      controller.abort(reason)
      return { source: value, state: value.label }
    }, controller.signal)).rejects.toBe(reason)

    expect(preparations.takeReady(id)).toBe(source)
    expect(preparations.takeReady(id)).toBeUndefined()
  })

  it('does not revive an invalidated commit after post-commit cancellation', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const id = SessionId('invalidated-commit-cancel')
    const source = prepared(id)
    const commitStarted = Promise.withResolvers<undefined>()
    const commitGate = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const reason = new Error('cancel invalidated commit')
    const reservation = preparations.reserve(id, () => Promise.resolve(source), async value => {
      commitStarted.resolve(undefined)
      await commitGate.promise
      return { source: value, state: value.label }
    }, controller.signal)

    await commitStarted.promise
    preparations.invalidate(id)
    controller.abort(reason)
    commitGate.resolve(undefined)
    await expect(reservation).rejects.toBe(reason)
    expect(preparations.has(id)).toBe(false)
  })

  it('returns undefined when a load is invalidated before reservation', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const id = SessionId('invalidated-reservation')
    const gate = Promise.withResolvers<PreparedSource>()
    const reservation = preparations.reserve(id, () => gate.promise, committed)
    preparations.invalidate(id)
    gate.resolve(prepared(id))
    await expect(reservation).resolves.toBeUndefined()
  })

  it('rejects pending adoption and accepts a ready source exactly once', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const id = SessionId('take-ready')
    const gate = Promise.withResolvers<PreparedSource>()
    const inspection = preparations.inspect(id, () => gate.promise)
    expect(() => preparations.takeReady(id)).toThrow(/preparation is pending/)
    const source = prepared(id)
    gate.resolve(source)
    await inspection
    expect(preparations.takeReady(id)).toBe(source)
    expect(preparations.takeReady(id)).toBeUndefined()
  })

  it('rejects publication while only an inspection exists', async () => {
    const preparations = new SessionPreparations<PreparedSource, string>(1)
    const source = prepared('inspection-publication')
    await preparations.inspect(source.session.id, () => Promise.resolve(source))
    expect(() => preparations.reservationFor(source.session)).toThrow(/cannot publish/)
  })
})

describe('observeQueuedAbort', () => {
  it('relays fulfillment and rejection exactly', async () => {
    const signal = new AbortController().signal
    await expect(observeQueuedAbort(Promise.resolve('value'), signal)).resolves.toBe('value')
    const failure = { kind: 'failed' }
    await expect(observeQueuedAbort(Promise.reject(failure), signal)).rejects.toBe(failure)
  })

  it('rejects promptly with an exact abort reason and ignores later settlement', async () => {
    const operation = Promise.withResolvers<string>()
    const controller = new AbortController()
    const reason = { kind: 'aborted' }
    const observed = observeQueuedAbort(operation.promise, controller.signal)
    controller.abort(reason)
    await expect(observed).rejects.toBe(reason)
    operation.resolve('late')
    await Promise.resolve()
  })

  it('observes a pre-aborted signal through the default start predicate', async () => {
    const controller = new AbortController()
    controller.abort('pre-aborted')
    await expect(observeQueuedAbort(new Promise<never>(() => {}), controller.signal))
      .rejects.toBe('pre-aborted')
  })

  it('lets an operation that already started own cancellation settlement', async () => {
    const operation = Promise.withResolvers<string>()
    const controller = new AbortController()
    const observed = observeQueuedAbort(operation.promise, controller.signal, () => true)
    controller.abort(new Error('too late'))
    operation.resolve('owned')
    await expect(observed).resolves.toBe('owned')
  })
})
