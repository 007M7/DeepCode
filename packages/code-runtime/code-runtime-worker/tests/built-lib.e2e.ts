import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Keyless built-artifact smoke: plain Node imports the package by name through its exports map,
 * then exercises type stripping, sibling `worker.cjs` loading, bindings, and logs. Unit tests use
 * `src/worker.ts`; this pins the downstream `lib/index.js` path. It skips when `lib/` is absent,
 * and CI runs it after the build.
 */

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/worker.cjs'].every(file => existsSync(join(pkgDir, file)))
  && existsSync(join(pkgDir, '../code-runtime/lib/index.js'))

describe.skipIf(!built)('built lib real load path (plain node)', () => {
  it('runs a TypeScript program with a binding through lib/index.js and its lib/worker.cjs entry', async () => {
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
