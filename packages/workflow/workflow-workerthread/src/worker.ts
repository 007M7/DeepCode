/**
 * The worker-thread entry the engine spawns: bootstrap ./session.ts on the real `parentPort`.
 * @module @deepseek-ai/dsh-workflow-workerthread/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { requireParentPort, runWorkerSession } from './session.ts'
import type { WorkerInit } from './types.ts'

// workerData is `any` at the node:worker_threads boundary; the engine is the
// only spawner and always provides a WorkerInit.
void runWorkerSession(requireParentPort(parentPort), workerData as WorkerInit)
