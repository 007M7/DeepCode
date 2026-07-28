import { describe, expect, it, vi } from 'vitest'
import { SubprocessTerminalLifecycle } from '@deepseek-ai/dsh-subprocess'

describe('SubprocessTerminalLifecycle', () => {
  it('waits for top-level settlement and the provider cleanup transaction', async () => {
    const done = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanup = vi.fn(() => cleanupGate.promise)
    const lifecycle = new SubprocessTerminalLifecycle({ done: done.promise, cleanup })

    const waiting = lifecycle.waitForExit()
    expect(cleanup).not.toHaveBeenCalled()
    done.resolve(undefined)
    await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledOnce() })

    const observed = vi.fn()
    void waiting.then(observed)
    await Promise.resolve()
    expect(observed).not.toHaveBeenCalled()

    cleanupGate.resolve(undefined)
    await expect(waiting).resolves.toBe(true)
    lifecycle.terminate()
    await expect(lifecycle.waitForExit()).resolves.toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('normalizes cleanup failures, permits retries, and retains lifetime cancellation until success', async () => {
    const done = Promise.withResolvers<undefined>()
    const lifetime = new AbortController()
    const removeListener = vi.spyOn(lifetime.signal, 'removeEventListener')
    const synchronousFailure = new Error('first cleanup failed')
    let attempt = 0
    const cleanup = vi.fn((): Promise<void> => {
      attempt += 1
      if (attempt === 1) throw synchronousFailure
      if (attempt === 2) {
        return Promise.resolve().then(() => {
          const nonErrorRejection: unknown = 'cleanup transport gone'
          throw nonErrorRejection
        })
      }
      return Promise.resolve()
    })
    const lifecycle = new SubprocessTerminalLifecycle({
      done: done.promise,
      cleanup,
      signal: lifetime.signal,
    })

    lifecycle.terminate()
    await expect(lifecycle.waitForExit()).rejects.toBe(synchronousFailure)
    lifecycle.terminate()
    await expect(lifecycle.waitForExit()).rejects.toThrow('cleanup transport gone')

    lifetime.abort()
    await expect(lifecycle.waitForExit()).resolves.toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(3)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))

    done.reject(new Error('top-level transport failed'))
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(3)
  })

  it('starts cleanup for a pre-aborted lifetime and bounds a wait that is already aborted', async () => {
    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanup = vi.fn(() => cleanupGate.promise)
    const lifecycle = new SubprocessTerminalLifecycle({
      done: new Promise(() => {}),
      cleanup,
      signal: AbortSignal.abort(new Error('lifetime cancelled')),
    })

    expect(cleanup).toHaveBeenCalledOnce()
    await expect(lifecycle.waitForExit(AbortSignal.abort())).resolves.toBe(false)
    cleanupGate.resolve(undefined)
    await expect(lifecycle.waitForExit()).resolves.toBe(true)
  })

  it('contains cleanup settlement after an observer aborts between signal checks', async () => {
    const firstCleanup = Promise.withResolvers<undefined>()
    const cleanup = vi.fn()
      .mockImplementationOnce(() => firstCleanup.promise)
      .mockResolvedValueOnce(undefined)
    const lifecycle = new SubprocessTerminalLifecycle({ done: Promise.resolve(), cleanup })
    const observer = new AbortController().signal
    vi.spyOn(observer, 'aborted', 'get')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    await expect(lifecycle.waitForExit(observer)).resolves.toBe(false)
    firstCleanup.reject(new Error('late cleanup failure'))
    await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledOnce() })
    await Promise.resolve()

    lifecycle.terminate()
    await expect(lifecycle.waitForExit()).resolves.toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('reports bounded cleanup success and failure', async () => {
    const successful = new SubprocessTerminalLifecycle({
      done: Promise.resolve(),
      cleanup: async () => {},
    })
    await expect(successful.waitForExit(new AbortController().signal)).resolves.toBe(true)

    const failure = new Error('quiescence failed')
    const failed = new SubprocessTerminalLifecycle({
      done: Promise.resolve(),
      cleanup: () => Promise.reject(failure),
    })
    await expect(failed.waitForExit(new AbortController().signal)).rejects.toBe(failure)

    const failedDone = Promise.withResolvers<undefined>()
    const afterTransportFailure = new SubprocessTerminalLifecycle({
      done: failedDone.promise,
      cleanup: async () => {},
    })
    const waiting = afterTransportFailure.waitForExit()
    failedDone.reject(new Error('transport failed'))
    await expect(waiting).resolves.toBe(true)
  })
})
