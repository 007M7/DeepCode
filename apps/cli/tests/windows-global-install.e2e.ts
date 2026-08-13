/** Windows user-level install acceptance for the downloaded-source workflow. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const installer = join(repositoryRoot, 'scripts', 'install-deepcode.ps1')
const uninstaller = join(repositoryRoot, 'scripts', 'uninstall-deepcode.ps1')
const builtBin = join(repositoryRoot, 'apps', 'cli', 'lib', 'deepseek.js')
const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows'
const powerShellExe = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

describe.skipIf(process.platform !== 'win32' || !existsSync(builtBin))('Windows global DeepCode install', () => {
  it('installs one idempotent command for CMD and restricted-policy PowerShell', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'deepcode-global-prefix-'))
    const environment = { ...process.env, NPM_CONFIG_PREFIX: prefix }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const install = await execa(powerShellExe, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
          '-PathTarget', 'Process', '-SkipDependencies', '-SkipBuild',
        ], { cwd: prefix, env: environment, reject: false })
        expect(install.exitCode, install.stderr).toBe(0)
        expect(install.stdout).toContain('installed successfully')
      }

      const cmdShim = join(prefix, 'deepseek.cmd')
      const powerShellShim = join(prefix, 'deepseek.ps1')
      expect(existsSync(cmdShim)).toBe(true)
      expect(existsSync(powerShellShim)).toBe(false)

      const shellEnvironment = {
        ...environment,
        PATH: `${prefix};${dirname(process.execPath)};${windowsRoot}\\System32`,
      }
      const cmd = await execa('cmd.exe', ['/d', '/s', '/c', 'deepseek --version'], { env: shellEnvironment })
      const powerShell = await execa(powerShellExe, [
        '-NoProfile', '-ExecutionPolicy', 'Restricted', '-Command', 'deepseek --version',
      ], { env: shellEnvironment })
      expect(cmd.stdout).toBe(powerShell.stdout)

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const uninstall = await execa(powerShellExe, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uninstaller,
        ], { cwd: prefix, env: environment, reject: false })
        expect(uninstall.exitCode, uninstall.stderr).toBe(0)
      }
      expect(existsSync(cmdShim)).toBe(false)
      expect(existsSync(powerShellShim)).toBe(false)
    } finally {
      rmSync(prefix, { recursive: true, force: true })
    }
  }, 30_000)
})
