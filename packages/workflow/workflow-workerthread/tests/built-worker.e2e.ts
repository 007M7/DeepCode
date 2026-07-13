import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const builtIndex = join(packageRoot, 'lib', 'index.js')
const builtWorker = join(packageRoot, 'lib', 'worker.cjs')
const run = promisify(execFile)

/**
 * The BUILT-output guard for the worker entry: every other suite runs
 * unbuilt (src/ + tsx), so nothing else proves that `lib/index.js` resolves
 * its sibling `lib/worker.cjs` and that the bundle boots a worker under plain
 * node (no tsx loader). Keyless — a zero-agent script needs no provider —
 * and self-skips until `pnpm run build` has produced the bundles.
 */
describe.skipIf(!existsSync(builtIndex) || !existsSync(builtWorker))('built worker entry (lib/worker.cjs)', () => {
  it('the built engine spawns its built worker under plain node and completes a run', async () => {
    // ESM resolves bare specifiers from the IMPORTING FILE's location, so the
    // driver must live inside the package for its node_modules to apply — a
    // temp-named file at the package root, removed on the way out.
    const driver = join(packageRoot, `.built-worker-driver-${process.pid}.mjs`)
    try {
      await writeFile(driver, `
import { Context } from 'cordis'
import SubagentService from '@deepseek-ai/dsh-subagent'
import WorkerWorkflowEngine from '@deepseek-ai/dsh-workflow-workerthread'

const ctx = new Context()
await ctx.plugin(SubagentService)
await ctx.plugin(WorkerWorkflowEngine, {})
const run = ctx.workflows.start({
  script: 'return 6 * 7',
  meta: { name: 'built-smoke', description: 'built worker smoke' },
  // A zero-agent script never touches the provider, so a bare id suffices.
  parent: { id: 'built-smoke-parent', options: {} },
})
const result = await run.result
await run.dispose()
if (result.stopReason !== 'completed' || result.value !== 42) {
  console.error('unexpected result: ' + JSON.stringify(result))
  process.exit(1)
}
console.log('built-worker-smoke-ok')
`, 'utf8')
      // Plain node — no tsx loader anywhere; the bundle must stand on its own.
      const { stdout } = await run(process.execPath, [driver], { cwd: packageRoot, timeout: 60_000 })
      expect(stdout).toContain('built-worker-smoke-ok')
    } finally {
      await rm(driver, { force: true })
    }
  }, 120_000)
})
