/** Keyless assembled snapshot for the direct DeepSeek terminal command surface. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourceBin = join(repoRoot, 'apps/cli/src/deepseek.ts')
const builtBin = join(repoRoot, 'apps/cli/lib/deepseek.js')
const repoTsconfig = join(repoRoot, 'tsconfig.json')

describe('deepseek local CLI assembled snapshot', () => {
  it('boots the real profile and serves keyless built-in commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'deepseek-cli-snapshot-home-'))
    const workspace = mkdtempSync(join(tmpdir(), 'deepseek-cli-snapshot-workspace-'))
    const environment = Object.fromEntries(Object.entries({
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_API_KEY: undefined,
      DEEPSEEK_BASE_URL: undefined,
      NO_COLOR: '1',
    }).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const launch = resolveExampleLaunch({
      srcBin: sourceBin,
      libBin: builtBin,
      tsconfigPath: repoTsconfig,
      env: environment,
    })
    try {
      const result = await execa(launch.command, launch.args, {
        cwd: workspace,
        input: '/status\n/models\n/help\n/exit\n',
        timeout: LOADER_SMOKE_TEST_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        reject: false,
        env: { ...environment, ...launch.env },
        extendEnv: false,
      })
      if (result.timedOut) throw new Error('deepseek local CLI snapshot timed out')
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stderr).toBe('')
      const transcript = result.stdout
        .replace(/session-[0-9a-f-]{36}/giu, 'session-{{id}}')
        .replaceAll(workspace, '{{workspace}}')
      expect(transcript).toMatchInlineSnapshot(`
        "> Session: session-{{id}}
        Model: deepseek-official/deepseek-v4-flash
        Authentication: missing
        Workspace: {{workspace}}
        > DeepSeek (deepseek-official)
         * deepseek-v4-flash — DeepSeek-V4-Flash · reasoning off/high/max
           deepseek-v4-pro — DeepSeek-V4-Pro · reasoning off/high/max
        > DeepCode commands:
          /login       store a DeepSeek API key securely
          /logout      remove the managed DeepSeek API key
          /model       select provider, model, and reasoning effort
          /models      list registered provider catalogs
          /new         start a fresh session
          /sessions    list persisted sessions
          /resume ID   resume a persisted session
          /status      show auth, model, session, and workspace
          /clear       clear terminal scrollback
          /help        show built-in and registered plugin commands
          /exit        flush and exit

        Plugin commands:
          /compact  Compact older conversation history
          /feedback <text>  record feedback about this session
          /goal [<objective>|clear|edit <objective>|pause|resume]  set or view the goal for a long-running task
          /permission <preset>  Switch the permission preset (sandbox mode + approval policy)
          /plan [off|message]  Enter or leave plan mode
        > "
      `)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
