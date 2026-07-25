/**
 * Local-subprocess implementation of the process-manager seam. Each spawn is
 * a detached process group with bounded, spill-backed output; disposal kills
 * and joins live groups. It has no config: every limit arrives on the spec,
 * so the deployment-varying choices stay with the calling seam's config (the
 * bash executor's, today).
 * @module @deepseek-ai/dsh-process-local
 */

import { Context } from 'cordis'
import { ProcessManager } from '@deepseek-ai/dsh-process'
import type { ProcessHandle, ProcessSpawnSpec } from '@deepseek-ai/dsh-process'
import { spawnProcess } from './spawn.ts'
import type { SpawnInternals } from './spawn.ts'

/**
 * Local process manager: detached process groups, tail-keep truncation with
 * bounded spill files, credential-scrubbed environment, and group
 * SIGTERM→grace→SIGKILL escalation.
 */
export class LocalProcessManager extends ProcessManager {
  /** Live handles retained only so disposal can kill and join them. */
  private live = new Set<ProcessHandle>()
  /** Test seam: spill knobs forwarded to spawnProcess. */
  internals: SpawnInternals = {}

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      // Await closure so even a TERM-trapping child cannot outlive the fiber.
      const pending: Promise<unknown>[] = []
      for (const handle of this.live) {
        handle.kill()
        // Spawn-failure rejections already settled and left the live set.
        pending.push(handle.done.catch(() => {}))
      }
      this.live.clear()
      await Promise.all(pending)
    }, 'local process-manager teardown')
  }

  spawn(spec: ProcessSpawnSpec): ProcessHandle {
    const handle = spawnProcess(spec, this.internals)
    this.live.add(handle)
    handle.done.then(
      () => { this.live.delete(handle) },
      () => { this.live.delete(handle) },
    )
    return handle
  }
}

export default LocalProcessManager
