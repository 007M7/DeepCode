/**
 * Real-backend end-to-end: LocalSandboxProvider (win32 chain → the
 * windows-acl runner), SandboxPolicyService, and SandboxPwshExecutor with
 * REAL pwsh spawns confined through the runner — the debug-instance
 * verification of both modes: read-only denies every write (not even NUL),
 * workspace-write allows the workspace and temp while denying escape writes,
 * and denial/classification facts ride the settled result.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '../src/index.ts'

const isWin32 = process.platform === 'win32'

function pwshAvailable(): boolean {
  return spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
}

describe.skipIf(!isWin32 || !pwshAvailable())('pwsh-sandbox real ACL confinement', () => {
  let scratchRoot!: string
  let writableDir!: string
  let isolatedTemp!: string
  let secretFile!: string
  let escapeFile!: string
  let executor!: SandboxPwshExecutor

  beforeAll(async () => {
    // The escape probe must live OUTSIDE every legitimately granted tree: the
    // provider's workspace-write grants the workspace plus the REAL temp dir
    // (the 'backend-defined temp area', same as Landlock granting /tmp), so a
    // scratch dir under temp would inherit the grant and the probe would be a
    // false pass. A mkdtemp under the profile is removed by afterAll.
    scratchRoot = mkdtempSync(join(homedir(), 'dsh-pwsh-sandbox-e2e-'))
    writableDir = join(scratchRoot, 'writable')
    mkdirSync(writableDir)
    isolatedTemp = mkdtempSync(join(tmpdir(), 'dsh-pwsh-sandbox-e2e-temp-'))
    secretFile = join(scratchRoot, 'secret.txt')
    writeFileSync(secretFile, 'top secret - must stay readable to prove the read boundary')
    escapeFile = join(scratchRoot, 'escaped.txt')

    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: writableDir })
    await ctx.plugin(LocalSubprocessService)
    await ctx.plugin(SandboxPwshExecutor, {})
    executor = ctx.bash as SandboxPwshExecutor
  })

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
    rmSync(isolatedTemp, { recursive: true, force: true })
  })

  it('read-only: every write denied (workspace, temp, NUL), reads fine, denial facts ride the result', async () => {
    const policy: SandboxExecutionPolicy = { mode: 'read-only', workspaceRoot: writableDir }
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Set-Content -Path '${writableDir}\\ro-write.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      `try{Set-Content -Path '${isolatedTemp}\\ro-write.txt' -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};`,
      `try{Set-Content -Path '${escapeFile}' -Value ok -ErrorAction Stop;'ESCAPE-WRITE: OK'}catch{'ESCAPE-WRITE: DENIED'};`,
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'}`,
    ].join('')
    const result = await executor.run(executor.resolve({ command: probe, sandboxPolicy: policy }))
    expect(result.exitCode, `stderr: ${result.stderr.text}`).toBe(0)
    expect(result.stdout.text).toContain('TARGET-WRITE: DENIED')
    expect(result.stdout.text).toContain('TEMP-WRITE: DENIED')
    expect(result.stdout.text).toContain('ESCAPE-WRITE: DENIED')
    expect(result.stdout.text).toContain('SECRET-READ: OK')
    expect(existsSync(join(writableDir, 'ro-write.txt'))).toBe(false)
    // A self-caught denial keeps the command exit 0: no denial fact.
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })

    // A raw failing write must classify as a denial of the ACL dialect.
    const denied = await executor.run(executor.resolve({
      command: `Set-Content -Path '${escapeFile}' -Value x`,
      sandboxPolicy: policy,
    }))
    expect(denied.exitCode).not.toBe(0)
    expect(denied.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  }, 60_000)

  it('workspace-write: workspace and temp writable, escape denied, reads fine', async () => {
    const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: writableDir }
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Set-Content -Path '${writableDir}\\ww-write.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      `try{Set-Content -Path '${isolatedTemp}\\ww-write.txt' -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};`,
      `try{Set-Content -Path '${escapeFile}' -Value ok -ErrorAction Stop;'ESCAPE-WRITE: OK'}catch{'ESCAPE-WRITE: DENIED'};`,
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'}`,
    ].join('')
    const result = await executor.run(executor.resolve({ command: probe, sandboxPolicy: policy }))
    expect(result.exitCode, `stderr: ${result.stderr.text}`).toBe(0)
    expect(result.stdout.text).toContain('TARGET-WRITE: OK')
    expect(result.stdout.text).toContain('TEMP-WRITE: OK')
    expect(result.stdout.text).toContain('ESCAPE-WRITE: DENIED')
    expect(result.stdout.text).toContain('SECRET-READ: OK')
    expect(existsSync(join(writableDir, 'ww-write.txt'))).toBe(true)
    expect(existsSync(escapeFile)).toBe(false)
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
  }, 60_000)
})
