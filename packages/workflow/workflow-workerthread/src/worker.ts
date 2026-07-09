/**
 * The worker-thread entry the engine spawns: bootstrap ./session.ts on the
 * real `parentPort`. Deliberately a single statement — every piece of logic
 * lives in `runWorkerSession`, which the unit suite drives in-process over a
 * `MessageChannel` (code inside a real Worker is invisible to main-process
 * coverage); loading this module on the main thread throws via
 * `requireParentPort`, which is how the suite covers the file itself.
 *
 * @module @deepseek-ai/dsh-workflow-workerthread/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { requireParentPort, runWorkerSession } from './session.ts'
import type { WorkerInit } from './types.ts'

// workerData is `any` at the node:worker_threads boundary; the engine is the
// only spawner and always provides a WorkerInit.
void runWorkerSession(requireParentPort(parentPort), workerData as WorkerInit)
