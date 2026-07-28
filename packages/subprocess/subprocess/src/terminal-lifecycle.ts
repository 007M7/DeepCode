/** Provider-neutral lifecycle transaction for terminal-process handles. */

/** Inputs owned by one terminal-process lifecycle controller. */
export interface SubprocessTerminalLifecycleOptions {
  /** Settlement of the top-level terminal process or its live transport. */
  readonly done: Promise<unknown>
  /** Provider-owned cleanup that reaches whole-session quiescence. */
  readonly cleanup: () => Promise<void>
  /** Optional cancellation for the complete terminal lifetime. */
  readonly signal?: AbortSignal | undefined
}

function normalizeCleanupError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Coordinates terminal cleanup without knowing how a provider allocates or
 * terminates its process session. One active cleanup attempt is shared by all
 * callers; a rejected attempt may be retried, and successful cleanup removes
 * the lifetime abort listener.
 */
export class SubprocessTerminalLifecycle {
  private cleanupAttempt: Promise<void> | undefined
  private removeLifetimeAbort: (() => void) | undefined

  /**
   * @param options - top-level settlement, provider cleanup, and lifetime cancellation.
   */
  constructor(private readonly options: SubprocessTerminalLifecycleOptions) {
    const onDone = (): void => { this.terminate() }
    void options.done.then(onDone, onDone)

    if (options.signal !== undefined) {
      const onAbort = (): void => { this.terminate() }
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.removeLifetimeAbort = () => { options.signal?.removeEventListener('abort', onAbort) }
      if (options.signal.aborted) this.terminate()
    }
  }

  /** Begin an idempotent provider cleanup attempt. */
  terminate(): void {
    void this.startCleanup().catch(() => {})
  }

  /**
   * Wait for top-level settlement and successful whole-session cleanup.
   * @param signal - optional bound for this observation only.
   * @returns true after quiescence, false when the observer signal aborts first.
   */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    const quiescence = this.cleanupAttempt ?? this.options.done.then(
      () => this.startCleanup(),
      () => this.startCleanup(),
    )
    if (signal === undefined) {
      await quiescence
      return true
    }
    if (signal.aborted) return false

    return await new Promise<boolean>((resolve, reject) => {
      let settled = false
      const finish = (complete: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        complete()
      }
      const onAbort = (): void => { finish(() => { resolve(false) }) }

      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      void quiescence.then(
        () => { finish(() => { resolve(true) }) },
        (error: unknown) => { finish(() => { reject(normalizeCleanupError(error)) }) },
      )
    })
  }

  private startCleanup(): Promise<void> {
    if (this.cleanupAttempt !== undefined) return this.cleanupAttempt

    const outcome = Promise.withResolvers<void>()
    this.cleanupAttempt = outcome.promise.catch((error: unknown) => {
      this.cleanupAttempt = undefined
      throw normalizeCleanupError(error)
    })
    void this.cleanupAttempt.then(
      () => {
        this.removeLifetimeAbort?.()
        this.removeLifetimeAbort = undefined
      },
      () => {},
    )
    try {
      void this.options.cleanup().then(outcome.resolve, outcome.reject)
    } catch (error: unknown) {
      outcome.reject(error)
    }
    return this.cleanupAttempt
  }
}
