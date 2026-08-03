/**
 * Keyless built-artifact guard (the `dsh-workflow-workerthread` built-worker
 * shape): plain `worker_threads` loads `lib/worker.cjs` and the bundle reaches
 * its real koffi requires. POSIX hosts prove the load path end to end through
 * the deterministic ole32 rejection; win32 skips (a real dialog would open),
 * where the win32-only smoke in win32-dialog.spec.ts covers the source plane
 * instead. Skips until a build produces the artifact.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

const builtWorker = fileURLToPath(new URL('../lib/worker.cjs', import.meta.url))

describe.skipIf(!existsSync(builtWorker) || process.platform === 'win32')('built dialog worker (lib/worker.cjs)', () => {
  it('loads under plain worker_threads and reports the native-surface failure', async () => {
    const message = await new Promise<Win32DialogWorkerMessage>((resolve, reject) => {
      const worker = new Worker(builtWorker, { workerData: { title: 'Built-artifact guard' } })
      worker.on('message', resolve)
      worker.on('error', reject)
      worker.on('exit', (code) => {
        reject(new Error(`worker exited (${code}) before reporting`))
      })
    })
    expect(message.kind).toBe('error')
    expect((message as { kind: 'error'; message: string }).message).toMatch(/ole32|koffi/i)
  }, 30_000)
})
