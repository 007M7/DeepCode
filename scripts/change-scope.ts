/** Report the explicit committed and worktree scope of a repository change. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs, TextDecoder } from 'node:util'

const FORMAT_VERSION = 1
const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

interface ChangeScopeReport {
  formatVersion: typeof FORMAT_VERSION
  repository: {
    root: string
    branch: string | null
    upstream: string | null
  }
  input: {
    base: string
    head: string
  }
  resolved: {
    baseSha: string
    headSha: string
    mergeBaseSha: string
  }
  paths: {
    committed: string[]
    staged: string[]
    unstaged: string[]
    untracked: string[]
  }
}

interface GitCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error: Error | undefined
}

interface GitBytesCommandResult {
  status: number | null
  stdout: Buffer
  stderr: Buffer
  error: Error | undefined
}

interface ChangeScopeOptions {
  base: string
  head: string
  json: boolean
}

function executeGit(cwd: string, args: string[], context: string): GitCommandResult {
  const result = executeGitBytes(cwd, args)
  return {
    status: result.status,
    stdout: decodeGitText(result.stdout, context, 'stdout'),
    stderr: decodeGitText(result.stderr, context, 'stderr'),
    error: result.error,
  }
}

function executeGitBytes(cwd: string, args: string[]): GitBytesCommandResult {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT,
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

function decodeGitText(output: Buffer, context: string, stream: 'stdout' | 'stderr'): string {
  try {
    return UTF8_DECODER.decode(output)
  } catch {
    throw new Error(`${context}: Git ${stream} is not valid UTF-8`)
  }
}

function failureDetail(result: GitCommandResult): string {
  return result.error?.message ?? (result.stderr.trim() || `Git exited with status ${String(result.status)}`)
}

function requireGit(cwd: string, args: string[], context: string): string {
  const result = executeGit(cwd, args, context)
  if (result.status !== 0) throw new Error(`${context}: ${failureDetail(result)}`)
  return result.stdout
}

function requireGitBytes(cwd: string, args: string[], context: string): Buffer {
  const result = executeGitBytes(cwd, args)
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? (result.stderr.toString('utf8').trim() || `Git exited with status ${String(result.status)}`)
    throw new Error(`${context}: ${detail}`)
  }
  return result.stdout
}

function parseOptions(args: string[]): ChangeScopeOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.base === undefined) throw new Error('missing required --base <ref>')
  return { base: values.base, head: values.head, json: values.json }
}

function resolveCommit(root: string, label: 'base' | 'head', ref: string): string {
  const context = `cannot resolve ${label} ref ${JSON.stringify(ref)}`
  const result = executeGit(root, [
    '-c',
    'core.warnAmbiguousRefs=true',
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ], context)
  if (/\bambiguous\b/iu.test(result.stderr)) {
    throw new Error(`${label} ref ${JSON.stringify(ref)} is ambiguous; use a fully qualified ref or commit ID`)
  }
  if (result.status !== 0) {
    throw new Error(`${label} ref ${JSON.stringify(ref)} does not resolve to a commit: ${failureDetail(result)}`)
  }
  const commits = result.stdout.trim().split(/\r?\n/u).filter(Boolean)
  if (commits.length !== 1) {
    throw new Error(`${label} ref ${JSON.stringify(ref)} did not resolve to exactly one commit`)
  }
  return commits[0] as string
}

function resolveMergeBase(root: string, baseSha: string, headSha: string): string {
  const result = executeGit(
    root,
    ['merge-base', '--all', baseSha, headSha],
    'cannot resolve the merge base',
  )
  if (result.status !== 0) {
    throw new Error(`base and head do not have a merge base: ${failureDetail(result)}`)
  }
  const mergeBases = result.stdout.trim().split(/\r?\n/u).filter(Boolean)
  if (mergeBases.length !== 1) {
    throw new Error(`base and head do not have a unique merge base; found ${mergeBases.length}`)
  }
  return mergeBases[0] as string
}

function currentBranch(root: string): string | null {
  const result = executeGit(
    root,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'cannot inspect the current branch',
  )
  if (result.status === 1) return null
  if (result.status !== 0) throw new Error(`cannot inspect the current branch: ${failureDetail(result)}`)
  return stripGitLineTerminator(result.stdout)
}

function configuredUpstream(root: string, branch: string | null): string | null {
  if (branch === null) return null
  const output = stripGitLineTerminator(requireGit(
    root,
    ['for-each-ref', '--count=1', '--format=%(upstream:short)', `refs/heads/${branch}`],
    'cannot inspect the configured upstream',
  ))
  return output === '' ? null : output
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function parsePathSet(output: Buffer, context: string): string[] {
  const paths: string[] = []
  let start = 0
  let record = 0
  for (let end = 0; end < output.length; end += 1) {
    if (output[end] !== 0) continue
    if (end > start) {
      record += 1
      try {
        paths.push(UTF8_DECODER.decode(output.subarray(start, end)))
      } catch {
        throw new Error(`${context}: Git path ${record} is not valid UTF-8`)
      }
    }
    start = end + 1
  }
  return [...new Set(paths)].sort(comparePaths)
}

function diffPaths(root: string, args: string[], context: string): string[] {
  return parsePathSet(requireGitBytes(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--ignore-submodules=none',
    '--name-only',
    '-z',
    ...args,
    '--',
  ], context), context)
}

function stripGitLineTerminator(output: string): string {
  const withoutLineFeed = output.endsWith('\n') ? output.slice(0, -1) : output
  return process.platform === 'win32' && withoutLineFeed.endsWith('\r')
    ? withoutLineFeed.slice(0, -1)
    : withoutLineFeed
}

function collectReport(options: ChangeScopeOptions, cwd: string): ChangeScopeReport {
  const root = stripGitLineTerminator(
    requireGit(cwd, ['rev-parse', '--show-toplevel'], 'cannot locate a Git worktree'),
  )
  const baseSha = resolveCommit(root, 'base', options.base)
  const headSha = resolveCommit(root, 'head', options.head)
  const mergeBaseSha = resolveMergeBase(root, baseSha, headSha)
  const branch = currentBranch(root)
  return {
    formatVersion: FORMAT_VERSION,
    repository: {
      root,
      branch,
      upstream: configuredUpstream(root, branch),
    },
    input: {
      base: options.base,
      head: options.head,
    },
    resolved: {
      baseSha,
      headSha,
      mergeBaseSha,
    },
    paths: {
      committed: diffPaths(root, [mergeBaseSha, headSha], 'cannot inspect committed paths'),
      staged: diffPaths(root, ['--cached'], 'cannot inspect staged paths'),
      unstaged: diffPaths(root, [], 'cannot inspect unstaged paths'),
      untracked: parsePathSet(requireGitBytes(
        root,
        ['ls-files', '--others', '--exclude-standard', '-z', '--'],
        'cannot inspect untracked paths',
      ), 'cannot inspect untracked paths'),
    },
  }
}

function formatValue(value: string | null): string {
  return JSON.stringify(value)
}

function formatPaths(label: string, paths: string[]): string[] {
  return [
    `${label} (${paths.length}):`,
    ...(paths.length === 0 ? ['  (none)'] : paths.map(path => `  - ${formatValue(path)}`)),
  ]
}

function formatHuman(report: ChangeScopeReport): string {
  return [
    `Format version: ${report.formatVersion}`,
    `Repository root: ${formatValue(report.repository.root)}`,
    `Branch: ${formatValue(report.repository.branch)}`,
    `Upstream: ${formatValue(report.repository.upstream)}`,
    `Base ref: ${formatValue(report.input.base)}`,
    `Head ref: ${formatValue(report.input.head)}`,
    `Base commit: ${report.resolved.baseSha}`,
    `Head commit: ${report.resolved.headSha}`,
    `Merge base: ${report.resolved.mergeBaseSha}`,
    ...formatPaths('Committed paths', report.paths.committed),
    ...formatPaths('Staged paths', report.paths.staged),
    ...formatPaths('Unstaged paths', report.paths.unstaged),
    ...formatPaths('Untracked paths', report.paths.untracked),
  ].join('\n')
}

/**
 * Validate arguments, collect one complete report, then invoke the writer once.
 * @param args - Command-line arguments after the script path.
 * @param cwd - Directory whose containing Git worktree is inspected.
 * @param write - Destination called once only after every Git query succeeds.
 * @returns Nothing.
 */
export function writeChangeScope(
  args: string[],
  cwd: string,
  write: (output: string) => void,
): void {
  const options = parseOptions(args)
  const report = collectReport(options, cwd)
  write(`${options.json ? JSON.stringify(report, null, 2) : formatHuman(report)}\n`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    writeChangeScope(process.argv.slice(2), process.cwd(), output => process.stdout.write(output))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`change-scope: ${message}\n`)
    process.exitCode = 1
  }
}
