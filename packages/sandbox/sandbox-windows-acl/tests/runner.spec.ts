/**
 * End-to-end runner tests: spawn the REAL runner entry through tsx (exactly
 * the argv shape dsh-sandbox-local's confine() builds), with piped stdio
 * inherited through the runner into the confined child — the same chain a
 * production confined execution walks.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'

const isWin32 = process.platform === 'win32'
const runnerEntry = fileURLToPath(new URL('../src/runner.ts', import.meta.url))

// Functional probe, not where.exe: spawnSync never throws on a missing
// binary (status null) and where.exe exits 1 without pwsh — only an actual
// pwsh invocation's exit status is truth.
function pwshAvailable(): boolean {
  return spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
}

function runRunner(args: string[], timeoutMs = 30_000) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', runnerEntry, ...args], {
    timeout: timeoutMs,
    encoding: 'utf8',
  })
}

describe.skipIf(!isWin32 || !pwshAvailable())('windows-acl runner', () => {
  let scratchRoot!: string
  let writableDir!: string
  let isolatedTemp!: string
  let secretFile!: string
  let escapeFile!: string

  beforeAll(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'dsh-acl-runner-'))
    writableDir = join(scratchRoot, 'writable')
    mkdirSync(writableDir)
    isolatedTemp = mkdtempSync(join(tmpdir(), 'dsh-acl-runner-temp-'))
    secretFile = join(scratchRoot, 'secret.txt')
    writeFileSync(secretFile, 'top secret - must stay readable to prove the read boundary')
    escapeFile = join(scratchRoot, 'escaped.txt')
  })

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
    rmSync(isolatedTemp, { recursive: true, force: true })
  })

  it('workspace-write: the confined child writes granted directories only', () => {
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Set-Content -Path '${writableDir}\\child-wrote.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      `try{Set-Content -Path '${isolatedTemp}\\child-wrote.txt' -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};`,
      `try{Set-Content -Path '${escapeFile}' -Value ok -ErrorAction Stop;'ESCAPE-WRITE: OK (ESCAPE!)'}catch{'ESCAPE-WRITE: DENIED'};`,
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'}`,
    ].join('')
    const result = runRunner([
      '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write',
      '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('TARGET-WRITE: OK')
    expect(result.stdout).toContain('TEMP-WRITE: OK')
    expect(result.stdout).toContain('ESCAPE-WRITE: DENIED')
    expect(result.stdout).toContain('SECRET-READ: OK')
    expect(existsSync(escapeFile)).toBe(false)
    expect(existsSync(join(writableDir, 'child-wrote.txt'))).toBe(true)
  }, 30_000)

  it('read-only: strict zero grants — no writes anywhere (not even NUL), reads and $null redirection fine', () => {
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      '\'LANGMODE: \' + $ExecutionContext.SessionState.LanguageMode;',
      `try{Set-Content -Path '${writableDir}\\readonly-child-wrote.txt' -Value ok -ErrorAction Stop;'TARGET-WRITE: OK'}catch{'TARGET-WRITE: DENIED'};`,
      `try{Set-Content -Path '${isolatedTemp}\\readonly-child-wrote.txt' -Value ok -ErrorAction Stop;'TEMP-WRITE: OK'}catch{'TEMP-WRITE: DENIED'};`,
      // The NUL device is a securable object: strict zero grants deny it too.
      'try{Set-Content -Path \'NUL\' -Value ok -ErrorAction Stop;\'NUL-WRITE: OK\'}catch{\'NUL-WRITE: DENIED\'};',
      // PowerShell's $null redirection discards without opening NUL — must keep working.
      'echo hi > $null;\'DOLLAR-NULL: OK\';',
      `try{Get-Content '${secretFile}' -ErrorAction Stop | Out-Null;'SECRET-READ: OK'}catch{'SECRET-READ: DENIED'}`,
    ].join('')
    const result = runRunner([
      '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'read-only',
      '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('TARGET-WRITE: DENIED')
    expect(result.stdout).toContain('TEMP-WRITE: DENIED')
    expect(result.stdout).toContain('NUL-WRITE: DENIED')
    expect(result.stdout).toContain('DOLLAR-NULL: OK')
    expect(result.stdout).toContain('SECRET-READ: OK')
    expect(existsSync(join(writableDir, 'readonly-child-wrote.txt'))).toBe(false)
  }, 30_000)

  it('workspace-write: Remove-Item and Rename-Item succeed in the granted workspace (DELETE + FILE_DELETE_CHILD)', () => {
    // Deleting a file and renaming a directory both hit the second access
    // check on the workspace itself: the grant must carry DELETE (on the
    // object) and FILE_DELETE_CHILD (on its parent).
    const victimFile = join(writableDir, 'delete-me.txt')
    writeFileSync(victimFile, 'remove me')
    const victimDir = join(writableDir, 'rename-me')
    mkdirSync(victimDir)
    const renamedDir = join(writableDir, 'renamed-by-child')
    const probe = [
      "$ErrorActionPreference='SilentlyContinue';",
      `try{Remove-Item -LiteralPath '${victimFile}' -ErrorAction Stop;'DELETE-FILE: OK'}catch{'DELETE-FILE: DENIED'};`,
      `try{Rename-Item -LiteralPath '${victimDir}' -NewName 'renamed-by-child' -ErrorAction Stop;'RENAME-DIR: OK'}catch{'RENAME-DIR: DENIED'}`,
    ].join('')
    const result = runRunner([
      '--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write',
      '--', 'pwsh', '/NoLogo', '/NonInteractive', '/NoProfile', '/Command', probe,
    ])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('DELETE-FILE: OK')
    expect(result.stdout).toContain('RENAME-DIR: OK')
    expect(existsSync(victimFile)).toBe(false)
    expect(existsSync(renamedDir)).toBe(true)
  }, 30_000)

  it('runner-side failure: signature on stderr and exit 127, the command never runs', () => {
    const result = runRunner(['--workspace', writableDir, '--temp', isolatedTemp, '--mode', 'workspace-write'])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('windows-acl-run: ')
  }, 15_000)
})
