import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless smoke for SOURCE `dsh` execution: run `apps/cli/src/bin.ts`
 * with the exact production runtime vector (`node --import tsx/esm`, the
 * vector the root `dsh` script invokes after building) and assert the
 * required-config diagnostic. The Node compatibility matrix runs this
 * WHOLE file, so a Node release changing module hooks or TypeScript handling
 * breaks this gate instead of every developer's `pnpm dsh`; the built-bin
 * suite covers the published `lib/` entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  it('runs the repository build before launching the source CLI', async () => {
    const stubDir = await mkdtemp(join(tmpdir(), 'dsh-source-launch-'))
    const invocationLog = join(stubDir, 'pnpm-args.json')
    const stubBody = "const { appendFileSync } = require('node:fs')\nappendFileSync(process.env.DSH_TEST_PNPM_LOG, JSON.stringify(process.argv.slice(2)))\n"
    await writeFile(join(stubDir, 'pnpm'), `#!/usr/bin/env node\n${stubBody}`)
    await chmod(join(stubDir, 'pnpm'), 0o755)
    await writeFile(join(stubDir, 'pnpm-stub.cjs'), stubBody)
    await writeFile(join(stubDir, 'pnpm.cmd'), '@echo off\r\nnode "%~dp0pnpm-stub.cjs" %*\r\n')

    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
    try {
      const result = await execa(process.execPath, ['--import', 'tsx/esm', 'scripts/run-source-dsh.ts', '--help'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          [pathKey]: `${stubDir}${delimiter}${process.env[pathKey] ?? ''}`,
          DSH_TEST_PNPM_LOG: invocationLog,
        },
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/^Usage: dsh /)
      await expect(readFile(invocationLog, 'utf8')).resolves.toBe('["run","build"]')
    } finally {
      await rm(stubDir, { recursive: true, force: true })
    }
  })

  it('builds without mixing build logs into CLI stdout', async () => {
    const result = await execa('pnpm', ['dsh', '--help'], {
      cwd: repoRoot,
      timeout: 120_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`pnpm dsh --help did not exit within 120s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^Usage: dsh /)
    expect(result.stdout).not.toContain('tsdown')
    expect(result.stdout).not.toContain('build:lib')
  }, 125_000)

  it('boots the source entry and requires a profile', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--profile <name> is required')
    expect(result.stdout).toBe('')
  }, 30_000)
})
