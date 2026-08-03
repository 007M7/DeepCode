/**
 * Real-process half of the Win32 dialog driver: spawn the dialog worker
 * (source or built plane) and close a dialog thread's windows. The module
 * itself loads everywhere (the import chain from native-picker.ts is
 * static); what stays win32-only is koffi, imported dynamically inside the
 * bindings' functions. The driver's logic is tested against fakes of this
 * surface instead.
 */

import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { Win32DialogWorkerData } from './win32-dialog-worker.ts'

/**
 * Spawn the dialog worker. Built consumers load the bundled CJS worker next
 * to this module; unbuilt (source) consumers bootstrap tsx inside the worker
 * first, mirroring `dsh-workflow-workerthread`'s host.
 * @param data - the worker payload (dialog title).
 * @returns the spawned worker thread.
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): Worker {
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/) */
  if (!import.meta.url.endsWith('.ts')) {
    return new Worker(fileURLToPath(new URL('./worker.cjs', import.meta.url)), { workerData: data })
  }
  const workerEntry = new URL('./win32-dialog-worker.ts', import.meta.url)
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: data })
}

export { closeThreadWindows, raiseDialogWindow } from './win32-dialog-bindings.ts'
