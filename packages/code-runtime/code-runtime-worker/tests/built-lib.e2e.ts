import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * BUILT-ARTIFACT smoke for the published package (the real-load-path guard
 * from docs/testing.md): the unit suite runs `src/` under vitest, where the
 * worker entry resolves to `src/worker.ts` — a consumer runs `lib/index.js`
 * under plain `node`, where it must resolve the sibling `lib/worker.js`
 * bundle instead. This spawns plain `node` (NOT tsx) from inside the package
 * directory and imports the package BY NAME, so resolution flows through the
 * real `exports` map exactly as it would from a downstream install; the
 * program exercises the type-strip, the worker spawn, the binding bridge,
 * and log capture end-to-end through the built bundles.
 *
 * It build-gates: SKIPS when the built artifacts are absent (suite run
 * without `pnpm run build`); CI runs it after the build step. KEYLESS — no
 * model is involved.
 */

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/worker.js'].every(file => existsSync(join(pkgDir, file)))
  && existsSync(join(pkgDir, '../code-runtime/lib/index.js'))

describe.skipIf(!built)('built lib real load path (plain node)', () => {
  it('runs a TypeScript program with a binding through lib/index.js and its lib/worker.js entry', async () => {
    const script = `
      const { Context } = await import('cordis')
      const { WorkerCodeRuntime } = await import('@deepseek-ai/dsh-code-runtime-worker')
      const ctx = new Context()
      await ctx.plugin(WorkerCodeRuntime, {})
      const result = await ctx.codeRuntime.run({
        program: 'const doubled: number = await tools.double({ n: 21 }); console.log("halfway", doubled); return doubled;',
        bindings: [{ global: 'tools', functions: { double: async args => args.n * 2 } }],
      })
      console.log(JSON.stringify(result))
      process.exit(0)
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: pkgDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const exitCode = await new Promise<number | null>(resolve => child.on('close', resolve))

    expect(exitCode, `stderr:\n${stderr}`).toBe(0)
    const lastLine = stdout.trim().split('\n').at(-1) ?? ''
    const result = JSON.parse(lastLine) as { value?: unknown; logs: { source: string; level?: string; text: string }[]; error?: unknown }
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
    expect(result.logs).toContainEqual({ source: 'console', level: 'log', text: 'halfway 42' })
  })
})
