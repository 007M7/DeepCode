#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'

const MINIMUM_GIT = [2, 20, 0]
const HOOKS_DIRECTORY = 'dsh-hooks'
const OWNERSHIP_MARKER = '.dsh-lefthook-owned'
const OWNERSHIP_MARKER_CONTENT = 'deepseek-harness worktree-local lefthook hooks\n'
const INSTALL_LOCK = 'dsh-lefthook-install.lock'
const INSTALL_LOCK_TIMEOUT_MS = 30_000
const INSTALL_LOCK_POLL_MS = 50
const ALLOW_HOOKS_PATH_OVERRIDE = 'DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE'

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

function commandFailure(command, args, result) {
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const detail = result.error?.message ?? (stderr || `exit status ${String(result.status)}`)
  return new Error(`${command} ${args.join(' ')} failed: ${detail}`)
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0 && !options.allowStatuses?.includes(result.status)) {
    throw commandFailure(command, args, result)
  }
  return result
}

function git(args, root, options = {}) {
  return capture('git', args, { ...options, cwd: root })
}

function nulValues(result) {
  if (result.status !== 0) return []
  if (result.stdout === '') return ['']
  const output = result.stdout.endsWith('\0') ? result.stdout.slice(0, -1) : result.stdout
  return output.split('\0')
}

function fileConfigValues(root, configPath, key) {
  return nulValues(git(
    ['config', '--file', configPath, '--null', '--get-all', key],
    root,
    { allowStatuses: [1] },
  ))
}

function effectiveConfigValue(root, key) {
  const values = nulValues(git(
    ['config', '--null', '--get', key],
    root,
    { allowStatuses: [1] },
  ))
  if (values.length > 1) throw new Error(`git config returned multiple effective values for ${key}`)
  return values[0]
}

function parseGitBoolean(value, key) {
  const normalized = value.toLowerCase()
  if (normalized === '' || normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === '1') return true
  if (normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === '0') return false
  throw new Error(`invalid Boolean value for ${key}: ${JSON.stringify(value)}`)
}

function assertSingle(values, key) {
  if (values.length > 1) throw new Error(`multiple ${key} values are not supported`)
  return values[0]
}

function assertSupportedGit(root) {
  const version = git(['--version'], root).stdout.trim()
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
  if (match === null) throw new Error(`cannot determine Git version from ${JSON.stringify(version)}`)
  const actual = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  for (let index = 0; index < MINIMUM_GIT.length; index += 1) {
    if (actual[index] > MINIMUM_GIT[index]) return
    if (actual[index] < MINIMUM_GIT[index]) {
      throw new Error(`Git 2.20 or newer is required for worktree-local hooks; found ${version}`)
    }
  }
}

function ensureWorktreeConfig(root, commonConfigPath) {
  const versions = fileConfigValues(root, commonConfigPath, 'core.repositoryFormatVersion')
  const versionText = assertSingle(versions, 'core.repositoryFormatVersion')
  const version = Number(versionText)
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`unsupported core.repositoryFormatVersion: ${JSON.stringify(versionText)}`)
  }

  const worktrees = fileConfigValues(root, commonConfigPath, 'core.worktree')
  if (worktrees.length > 0) {
    throw new Error('cannot enable extensions.worktreeConfig while core.worktree is in the common config; move it to the main worktree config first')
  }

  const bareText = assertSingle(fileConfigValues(root, commonConfigPath, 'core.bare'), 'core.bare')
  const bare = bareText === undefined ? undefined : parseGitBoolean(bareText, 'core.bare')
  if (bare === true) {
    throw new Error('cannot enable extensions.worktreeConfig for a common config with core.bare=true')
  }

  const extensionText = assertSingle(
    fileConfigValues(root, commonConfigPath, 'extensions.worktreeConfig'),
    'extensions.worktreeConfig',
  )
  const extensionEnabled = extensionText === undefined
    ? false
    : parseGitBoolean(extensionText, 'extensions.worktreeConfig')

  if (version === 0) {
    git(['config', '--file', commonConfigPath, 'core.repositoryFormatVersion', '1'], root)
  }
  if (!extensionEnabled) {
    git(['config', '--file', commonConfigPath, 'extensions.worktreeConfig', 'true'], root)
  }
  if (bare === false) {
    git(['config', '--file', commonConfigPath, '--unset-all', 'core.bare'], root)
  }
}

function lockOwnerIsAlive(lockPath) {
  let owner
  try {
    owner = Number(readFileSync(lockPath, 'utf8').trim())
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) return true
  try {
    process.kill(owner, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

function removeStaleLock(lockPath) {
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    // Another waiting installer removed the same stale lock first.
  }
}

async function acquireInstallLock(commonDirectory) {
  const lockPath = join(commonDirectory, INSTALL_LOCK)
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS
  while (true) {
    try {
      writeFileSync(lockPath, `${String(process.pid)}\n`, { flag: 'wx', mode: 0o600 })
      return () => removeStaleLock(lockPath)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      if (!lockOwnerIsAlive(lockPath)) {
        removeStaleLock(lockPath)
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Lefthook installer lock ${lockPath}`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, INSTALL_LOCK_POLL_MS))
    }
  }
}

function ensureOwnedHooksDirectory(hooksPath) {
  const markerPath = join(hooksPath, OWNERSHIP_MARKER)
  if (!existsSync(hooksPath)) {
    mkdirSync(hooksPath, { mode: 0o700 })
    writeFileSync(markerPath, OWNERSHIP_MARKER_CONTENT, { flag: 'wx', mode: 0o600 })
    return
  }
  const hooksStat = lstatSync(hooksPath)
  if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink()) {
    throw new Error(`refusing to use non-directory or symlinked hooks path ${hooksPath}`)
  }
  if (!existsSync(markerPath)) {
    throw new Error(`refusing to overwrite unowned hooks directory ${hooksPath}`)
  }
  const markerStat = lstatSync(markerPath)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || readFileSync(markerPath, 'utf8') !== OWNERSHIP_MARKER_CONTENT) {
    throw new Error(`refusing to overwrite hooks directory with an invalid ownership marker: ${hooksPath}`)
  }
}

function runLefthook(root, lefthook) {
  const args = ['install', '--force']
  // Node refuses to spawn Windows `.cmd` shims directly; the quoted path is
  // re-parsed by cmd.exe, while POSIX can execute its extensionless shim.
  const result = process.platform === 'win32'
    ? spawnSync(`"${lefthook}"`, args, { cwd: root, stdio: 'inherit', shell: true })
    : spawnSync(lefthook, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw commandFailure(lefthook, args, result)
}

function refuseCustomHooksPath(root, hooksPath) {
  const origin = git(
    ['config', '--show-origin', '--get', 'core.hooksPath'],
    root,
    { allowStatuses: [1] },
  ).stdout.trim()
  const source = origin === '' ? hooksPath : origin
  throw new Error(
    `refusing to replace user-owned core.hooksPath (${source}). `
    + `Chain those hooks through lefthook.yml, or, if this inherited path may remain active only in other worktrees, `
    + `rerun with ${ALLOW_HOOKS_PATH_OVERRIDE}=1`,
  )
}

async function main() {
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (probe.status !== 0) return
  const root = probe.stdout.trim()
  const isWindows = process.platform === 'win32'
  const lefthook = join(root, 'node_modules', '.bin', isWindows ? 'lefthook.cmd' : 'lefthook')
  if (!existsSync(lefthook)) return

  assertSupportedGit(root)
  const gitDirectory = git(['rev-parse', '--absolute-git-dir'], root).stdout.trim()
  const commonOutput = git(['rev-parse', '--git-common-dir'], root).stdout.trim()
  const commonDirectory = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput)
  const commonConfigPath = join(commonDirectory, 'config')
  const worktreeConfigPath = join(gitDirectory, 'config.worktree')
  const hooksPath = join(gitDirectory, HOOKS_DIRECTORY)
  const releaseLock = await acquireInstallLock(commonDirectory)

  try {
    const worktreePath = assertSingle(
      fileConfigValues(root, worktreeConfigPath, 'core.hooksPath'),
      'worktree core.hooksPath',
    )
    if (worktreePath !== undefined && worktreePath !== hooksPath) refuseCustomHooksPath(root, worktreePath)

    const effectivePath = effectiveConfigValue(root, 'core.hooksPath')
    const effectivePathIsOwned = effectivePath === hooksPath && worktreePath === hooksPath
    if (
      effectivePath !== undefined
      && !effectivePathIsOwned
      && process.env[ALLOW_HOOKS_PATH_OVERRIDE] !== '1'
    ) {
      refuseCustomHooksPath(root, effectivePath)
    }

    ensureOwnedHooksDirectory(hooksPath)
    ensureWorktreeConfig(root, commonConfigPath)

    let pathChanged = false
    try {
      git(['config', '--worktree', 'core.hooksPath', hooksPath], root)
      pathChanged = worktreePath === undefined
      runLefthook(root, lefthook)
    } catch (error) {
      if (pathChanged) {
        git(['config', '--worktree', '--unset-all', 'core.hooksPath'], root)
      }
      throw error
    }
  } finally {
    releaseLock()
  }
}

try {
  await main()
} catch (error) {
  console.error(`[install-lefthook] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
