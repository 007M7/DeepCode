/**
 * The worker-thread entrypoint: self-executing glue over
 * `bootstrap.ts`'s {@link runWorkerMain}, kept to the spawn wiring alone.
 * Like `bin.ts` CLI entrypoints, this file executes only inside a spawned
 * worker isolate — a place the coverage provider cannot observe — so it is
 * excluded from the coverage gate while every line of actual logic lives in
 * `bootstrap.ts`, unit-tested in-process; the real spawn path is pinned by
 * the integration tests that run genuine workers.
 *
 * @module @deepseek-ai/dsh-code-runtime-worker/src/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { runWorkerMain } from './bootstrap.ts'
import type { WorkerBootData } from './protocol.ts'

// A worker always has a parent port; guard loudly rather than run detached.
if (!parentPort) throw new Error('dsh-code-runtime-worker: worker entry loaded outside a worker thread')

void runWorkerMain(parentPort, workerData as WorkerBootData, { stdout: process.stdout, stderr: process.stderr })
