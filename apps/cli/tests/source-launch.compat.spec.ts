import { existsSync } from 'node:fs'
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

function resolvePnpmExecutable(): string {
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const executableNames = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']
  for (const directory of (process.env[pathKey] ?? '').split(delimiter)) {
    for (const executableName of executableNames) {
      const candidate = join(directory, executableName)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('pnpm executable is absent from PATH')
}

async function createPnpmStub(emitBuildOutput = false): Promise<{
  readonly directory: string
  readonly env: NodeJS.ProcessEnv
  readonly invocationLog: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-source-launch-'))
  const invocationLog = join(directory, 'pnpm-args.json')
  const simulatedOutput = emitBuildOutput
    ? "process.stdout.write('tsdown simulated build\\n')\nprocess.stderr.write('build:lib simulated build\\n')\n"
    : ''
  const stubBody = `const { appendFileSync } = require('node:fs')\nappendFileSync(process.env.DSH_TEST_PNPM_LOG, JSON.stringify(process.argv.slice(2)))\n${simulatedOutput}`
  await writeFile(join(directory, 'pnpm'), `#!/usr/bin/env node\n${stubBody}`)
  await chmod(join(directory, 'pnpm'), 0o755)
  await writeFile(join(directory, 'pnpm-stub.cjs'), stubBody)
  await writeFile(join(directory, 'pnpm.cmd'), '@echo off\r\nnode "%~dp0pnpm-stub.cjs" %*\r\n')
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  return {
    directory,
    invocationLog,
    env: {
      ...process.env,
      [pathKey]: `${directory}${delimiter}${process.env[pathKey] ?? ''}`,
      DSH_TEST_PNPM_LOG: invocationLog,
    },
  }
}

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  it('runs the repository build before launching the source CLI', async () => {
    const stub = await createPnpmStub()
    try {
      const result = await execa(process.execPath, ['--import', 'tsx/esm', 'scripts/run-source-dsh.ts', '--help'], {
        cwd: repoRoot,
        env: stub.env,
        reject: false,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/^Usage: dsh /)
      await expect(readFile(stub.invocationLog, 'utf8')).resolves.toBe('["run","build"]')
    } finally {
      await rm(stub.directory, { recursive: true, force: true })
    }
  })

  it('builds without mixing build logs into CLI stdout', async () => {
    const pnpmExecutable = resolvePnpmExecutable()
    const stub = await createPnpmStub(true)
    try {
      const result = await execa(pnpmExecutable, ['dsh', '--help'], {
        cwd: repoRoot,
        env: stub.env,
        timeout: 25_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      if (result.timedOut) {
        throw new Error(`pnpm dsh --help did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/^Usage: dsh /)
      expect(result.stdout).not.toContain('tsdown')
      expect(result.stdout).not.toContain('build:lib')
      await expect(readFile(stub.invocationLog, 'utf8')).resolves.toBe('["run","build"]')
    } finally {
      await rm(stub.directory, { recursive: true, force: true })
    }
  }, 30_000)

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
