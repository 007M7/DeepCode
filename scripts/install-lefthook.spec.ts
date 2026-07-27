import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const installer = fileURLToPath(new URL('./install-lefthook.mjs', import.meta.url))
const fixtures: string[] = []

interface Fixture {
  container: string
  env: NodeJS.ProcessEnv
  linked: string
  main: string
}

interface CommandResult {
  status: number | null
  stderr: string
  stdout: string
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function commandResult(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

function gitResult(fixture: Fixture, cwd: string, args: string[]): CommandResult {
  return commandResult('git', args, cwd, fixture.env)
}

function git(fixture: Fixture, cwd: string, args: string[]): string {
  const result = gitResult(fixture, cwd, args)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, mode === undefined ? undefined : { mode })
}

function fakeLefthookSource(): string {
  return `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

if (process.argv.slice(2).join(' ') !== 'install --force') process.exit(64)
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim()
mkdirSync(hooksPath, { recursive: true })
const running = join(hooksPath, '.fake-lefthook-running')
try {
  writeFileSync(running, String(process.pid), { flag: 'wx' })
} catch {
  process.exit(91)
}
const delay = Number(process.env.DSH_TEST_LEFTHOOK_DELAY_MS ?? 0)
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
const shouldFail = process.env.DSH_TEST_LEFTHOOK_FAIL === '1'
if (!shouldFail) {
  const binary = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'lefthook.cmd' : 'lefthook')
  const config = readFileSync(join(root, 'lefthook.yml'), 'utf8').trim()
  const hook = \`#!/bin/sh\\n# root=\${root}\\n# binary=\${binary}\\n# config=\${config}\\nexit 0\\n\`
  for (const name of ['pre-commit', 'pre-push']) writeFileSync(join(hooksPath, name), hook, { mode: 0o755 })
}
if (existsSync(running)) unlinkSync(running)
if (shouldFail) process.exit(77)
`
}

function installFakeLefthook(root: string): void {
  const binDirectory = join(root, 'node_modules/.bin')
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(join(binDirectory, 'fake-lefthook.mjs'), fakeLefthookSource())
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDirectory, 'lefthook.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0\\fake-lefthook.mjs" %*\r\n`,
    )
    return
  }
  const shim = join(binDirectory, 'lefthook')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-lefthook.mjs" "$@"\n`)
  chmodSync(shim, 0o755)
}

function createFixture(): Fixture {
  const container = mkdtempSync(join(tmpdir(), 'dsh-lefthook-'))
  fixtures.push(container)
  const main = join(container, 'main')
  const linked = join(container, 'linked')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'hooks@example.test',
    GIT_AUTHOR_NAME: 'Hooks Test',
    GIT_COMMITTER_EMAIL: 'hooks@example.test',
    GIT_COMMITTER_NAME: 'Hooks Test',
    GIT_CONFIG_GLOBAL: join(container, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: container,
    XDG_CONFIG_HOME: join(container, '.config'),
  }
  const fixture = { container, env, linked, main }
  mkdirSync(main)
  git(fixture, container, ['init', main])
  write(join(main, 'README.md'), '# fixture\n')
  git(fixture, main, ['add', 'README.md'])
  git(fixture, main, ['commit', '-m', 'fixture'])
  git(fixture, main, ['worktree', 'add', '-b', 'linked', linked])
  write(join(main, 'lefthook.yml'), 'main-worktree-config\n')
  write(join(linked, 'lefthook.yml'), 'linked-worktree-config\n')
  installFakeLefthook(main)
  installFakeLefthook(linked)
  return fixture
}

function gitDirectory(fixture: Fixture, root: string): string {
  return git(fixture, root, ['rev-parse', '--absolute-git-dir'])
}

function commonDirectory(fixture: Fixture): string {
  const output = git(fixture, fixture.main, ['rev-parse', '--git-common-dir'])
  return isAbsolute(output) ? output : resolve(fixture.main, output)
}

function hooksPath(fixture: Fixture, root: string): string {
  return join(gitDirectory(fixture, root), 'dsh-hooks')
}

function runInstaller(
  fixture: Fixture,
  root: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [installer], {
      cwd: root,
      env: { ...fixture.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (status) => { resolveResult({ status, stderr, stdout }) })
  })
}

describe('worktree-local Lefthook installer', () => {
  it('isolates main and linked worktrees without changing legacy common hooks', async () => {
    const fixture = createFixture()
    const common = commonDirectory(fixture)
    const legacyHook = join(common, 'hooks/pre-commit')
    write(legacyHook, '#!/bin/sh\n# legacy hook\n', 0o755)

    const mainInstall = await runInstaller(fixture, fixture.main)
    const linkedInstall = await runInstaller(fixture, fixture.linked)
    expect(mainInstall.status, mainInstall.stderr).toBe(0)
    expect(linkedInstall.status, linkedInstall.stderr).toBe(0)

    const mainHooks = hooksPath(fixture, fixture.main)
    const linkedHooks = hooksPath(fixture, fixture.linked)
    expect(mainHooks).not.toBe(linkedHooks)
    expect(git(fixture, fixture.main, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(mainHooks)
    expect(git(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(linkedHooks)

    const mainHook = readFileSync(join(mainHooks, 'pre-commit'), 'utf8')
    const linkedHook = readFileSync(join(linkedHooks, 'pre-commit'), 'utf8')
    const canonicalMain = git(fixture, fixture.main, ['rev-parse', '--show-toplevel'])
    const canonicalLinked = git(fixture, fixture.linked, ['rev-parse', '--show-toplevel'])
    expect(mainHook).toContain(`# root=${canonicalMain}`)
    expect(mainHook).toContain('# config=main-worktree-config')
    expect(mainHook).not.toContain(canonicalLinked)
    expect(linkedHook).toContain(`# root=${canonicalLinked}`)
    expect(linkedHook).toContain('# config=linked-worktree-config')
    expect(linkedHook).not.toContain(canonicalMain)
    expect(readFileSync(legacyHook, 'utf8')).toBe('#!/bin/sh\n# legacy hook\n')

    const commonConfig = join(common, 'config')
    expect(git(fixture, fixture.main, ['config', '--file', commonConfig, '--get', 'core.repositoryFormatVersion'])).toBe('1')
    expect(git(fixture, fixture.main, ['config', '--file', commonConfig, '--get', 'extensions.worktreeConfig'])).toBe('true')
    expect(gitResult(fixture, fixture.main, ['config', '--file', commonConfig, '--get', 'core.bare']).status).toBe(1)

    const mainHookBeforeRemoval = readFileSync(join(mainHooks, 'pre-commit'), 'utf8')
    git(fixture, fixture.main, ['worktree', 'remove', '--force', fixture.linked])
    expect(readFileSync(join(mainHooks, 'pre-commit'), 'utf8')).toBe(mainHookBeforeRemoval)
    expect(readFileSync(legacyHook, 'utf8')).toBe('#!/bin/sh\n# legacy hook\n')
  })

  it('serializes concurrent installs and keeps repeated output stable', async () => {
    const fixture = createFixture()
    const delayed = { DSH_TEST_LEFTHOOK_DELAY_MS: '150' }
    const first = await Promise.all([
      runInstaller(fixture, fixture.main, delayed),
      runInstaller(fixture, fixture.linked, delayed),
    ])
    for (const result of first) expect(result.status, result.stderr).toBe(0)

    const mainHookPath = join(hooksPath(fixture, fixture.main), 'pre-push')
    const initialHook = readFileSync(mainHookPath, 'utf8')
    const repeated = await Promise.all([
      runInstaller(fixture, fixture.main, delayed),
      runInstaller(fixture, fixture.main, delayed),
    ])
    for (const result of repeated) expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(mainHookPath, 'utf8')).toBe(initialHook)
    expect(existsSync(join(commonDirectory(fixture), 'dsh-lefthook-install.lock'))).toBe(false)
    expect(existsSync(join(hooksPath(fixture, fixture.main), '.fake-lefthook-running'))).toBe(false)
  })

  it('preserves user-owned hook paths unless an inherited value is explicitly overridden', async () => {
    const fixture = createFixture()
    const customHook = join(fixture.main, 'custom-hooks/pre-commit')
    write(customHook, '#!/bin/sh\n# custom hook\n', 0o755)
    git(fixture, fixture.main, ['config', 'core.hooksPath', 'custom-hooks'])

    const refused = await runInstaller(fixture, fixture.main)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('refusing to replace user-owned core.hooksPath')
    expect(refused.stderr).toContain('DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1')
    expect(git(fixture, fixture.main, ['config', '--get', 'core.hooksPath'])).toBe('custom-hooks')
    expect(readFileSync(customHook, 'utf8')).toBe('#!/bin/sh\n# custom hook\n')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)

    const optedIn = await runInstaller(fixture, fixture.main, {
      DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
    })
    expect(optedIn.status, optedIn.stderr).toBe(0)
    expect(git(fixture, fixture.main, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(hooksPath(fixture, fixture.main))
    expect(git(fixture, fixture.linked, ['config', '--get', 'core.hooksPath'])).toBe('custom-hooks')
    expect(gitResult(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath']).status).toBe(1)
    expect(readFileSync(customHook, 'utf8')).toBe('#!/bin/sh\n# custom hook\n')

    git(fixture, fixture.linked, ['config', '--worktree', 'core.hooksPath', 'linked-custom-hooks'])
    const explicitWorktreePath = await runInstaller(fixture, fixture.linked, {
      DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
    })
    expect(explicitWorktreePath.status).toBe(1)
    expect(git(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe('linked-custom-hooks')
  })

  it('restores the previous hook lookup when Lefthook installation fails', async () => {
    const fixture = createFixture()
    const common = commonDirectory(fixture)
    const legacyHook = join(common, 'hooks/pre-push')
    write(legacyHook, '#!/bin/sh\n# legacy pre-push\n', 0o755)

    const result = await runInstaller(fixture, fixture.main, { DSH_TEST_LEFTHOOK_FAIL: '1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('exit status 77')
    expect(gitResult(fixture, fixture.main, ['config', '--worktree', '--get', 'core.hooksPath']).status).toBe(1)
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'core.hooksPath']).status).toBe(1)
    expect(readFileSync(legacyHook, 'utf8')).toBe('#!/bin/sh\n# legacy pre-push\n')
  })

  it('refuses an unowned directory at the reserved worktree hook path', async () => {
    const fixture = createFixture()
    const reservedHook = join(hooksPath(fixture, fixture.main), 'pre-commit')
    write(reservedHook, '#!/bin/sh\n# user content\n', 0o755)

    const result = await runInstaller(fixture, fixture.main)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to overwrite unowned hooks directory')
    expect(readFileSync(reservedHook, 'utf8')).toBe('#!/bin/sh\n# user content\n')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('rejects Git without worktree-config support before mutation', async () => {
    const fixture = createFixture()
    const realGit = commandResult('which', ['git'], fixture.main, fixture.env).stdout.trim()
    const fakeBin = join(fixture.container, 'fake-bin')
    const fakeGit = join(fakeBin, 'git')
    write(
      fakeGit,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.19.0"; exit 0; fi\nexec "${realGit}" "$@"\n`,
      0o755,
    )

    const result = await runInstaller(fixture, fixture.main, {
      PATH: `${fakeBin}:${fixture.env.PATH ?? ''}`,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Git 2.20 or newer is required')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })
})
