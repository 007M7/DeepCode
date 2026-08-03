/**
 * Worker entry for the Win32 folder dialog: blocks THIS thread inside the
 * modal `Show` so the host event loop stays live, reporting over the message
 * port. Protocol: `{kind:'showing',threadId}` right before the blocking call
 * (the driver's abort lever needs the native thread id), then exactly one of
 * `{kind:'done',path}` or `{kind:'error',message}`.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { loadWin32DialogBindings } from './win32-dialog-bindings.ts'
import { runFolderDialog } from './win32-dialog-logic.ts'

/** The driver-to-worker payload: the dialog title. */
export interface Win32DialogWorkerData { title: string }

/** One notice or outcome posted back to the driver. */
export type Win32DialogWorkerMessage =
  | { kind: 'showing'; threadId: number }
  | { kind: 'done'; path: string | null }
  | { kind: 'error'; message: string }

const port = parentPort
if (port === null) throw new Error('win32-dialog-worker must run as a worker thread')
const { title } = workerData as Win32DialogWorkerData

// No top-level await: the built worker ships as CJS (pkg's VFS Worker hook
// compiles that format), which cannot carry TLA.
void (async () => {
  try {
    const bindings = await loadWin32DialogBindings()
    const path = runFolderDialog(bindings, title, (threadId) => {
      port.postMessage({ kind: 'showing', threadId } satisfies Win32DialogWorkerMessage)
    })
    port.postMessage({ kind: 'done', path } satisfies Win32DialogWorkerMessage)
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    port.postMessage({ kind: 'error', message } satisfies Win32DialogWorkerMessage)
  }
})()
