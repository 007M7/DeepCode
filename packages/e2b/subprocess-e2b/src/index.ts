/**
 * E2B implementation of the subprocess seam. Each handle starts through the
 * shared sandbox and retains command output/status paths in that remote world.
 * @module @deepseek-ai/dsh-subprocess-e2b
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from 'cordis'
import { SubprocessService } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { E2BSubprocessHandle } from './process.ts'

/** E2B command manager registered as `ctx.subprocess`. */
export class E2BSubprocessService extends SubprocessService {
  static inject = ['e2b']

  private readonly live = new Set<E2BSubprocessHandle>()

  /** Create the E2B subprocess service and bind its disposal policy. */
  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      await Promise.all(handles.map(async (handle) => {
        await handle.done.catch(() => {})
        await handle.waitForExit()
      }))
      this.live.clear()
    }, 'e2b subprocess teardown')
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error('subprocess-e2b: graceMs must be a positive finite number')
    }
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
    }
    const stateDir = posix.join(this.ctx.e2b.runtimeRoot, 'processes', randomUUID())
    const handle = new E2BSubprocessHandle(this.ctx.e2b, spec, stateDir)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

export default E2BSubprocessService
