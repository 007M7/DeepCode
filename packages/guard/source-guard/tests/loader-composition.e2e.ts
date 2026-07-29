import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

// The Loader config lives under examples so both launch modes exercise the same
// deployable topology: a local fixture adapter plus bare workspace plugins.
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/guard/source-guard/cordis.yml',
  import.meta.url,
))
const binScript = fileURLToPath(new URL('../../../examples/cli-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

/** Every `.jsonl` session log under `dir`. */
async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

/**
 * Write git metadata mirroring the installer layout — a master clone owning the
 * shared git directory and one linked worktree on a staging branch — and return
 * the worktree file the model will try to write.
 */
async function stagingFixture(cwd: string): Promise<{ checkout: string; target: string }> {
  const gitDir = join(cwd, 'master', '.git')
  const worktreeGitDir = join(gitDir, 'worktrees', 'staging')
  await mkdir(worktreeGitDir, { recursive: true })
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/master\n')
  await writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/dsh-staging/20260101T000000Z\n')
  const checkout = join(cwd, 'staging')
  await mkdir(checkout, { recursive: true })
  await writeFile(join(checkout, '.git'), `gitdir: ${worktreeGitDir}\n`)
  const target = join(checkout, 'guarded.ts')
  await writeFile(target, 'original\n')
  return { checkout, target }
}

describe('source-guard through a real headless cordis.yml', () => {
  it('denies the model-requested write and leaves the staged file untouched', async () => {
    let events: SessionEvent[] = []
    let contents = ''
    let target = ''
    const { stderr } = await runLoaderSmoke({
      label: 'source-guard headless smoke',
      tempDirPrefix: 'source-guard-e2e-',
      binScript,
      configPath,
      tsconfigPath: repoTsconfig,
      binArgs: ['--config', configPath, 'edit the guarded file'],
      // The isolated cwd is not known when these options are built, so the
      // config and adapter resolve their fixture paths against the child's own
      // cwd, which is that directory.
      prepare: async (cwd) => {
        // macOS puts the temp directory behind the /var -> /private/var
        // symlink; the child resolves its cwd, so compare against the same
        // real path rather than the symlinked one this process was handed.
        target = (await stagingFixture(await realpath(cwd))).target
      },
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
        contents = await readFile(target, 'utf8')
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    const results = events.filter(
      (event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const result = results[0]?.data.message.content[0]
    expect(result?.isError).toBe(true)
    const text = result?.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toBe(
      `Error: Editing "${target}" directly is not allowed: it is inside the dsh checkout this session is running from, `
      + 'on branch dsh-staging/20260101T000000Z. Load the dsh-customize skill first and follow it '
      + '— implement in a task worktree, then integrate under the staging lock.',
    )
    // Enforcement, not advice: the guard denies before dispatch, so the file
    // the model targeted still holds its original bytes.
    expect(contents).toBe('original\n')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
