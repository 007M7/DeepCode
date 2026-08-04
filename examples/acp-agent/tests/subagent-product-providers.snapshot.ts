/**
 * Real-product Loader snapshots for fixed subagent providers.
 *
 * PR1 owns the Codex scenario. PR2 extends this file with the sibling Claude
 * Code scenario and reruns both from its final stacked candidate.
 */

import { dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  normalizeSessionLog,
  normalizeStdout,
  scrubSystemPrompts,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'
import { startResponsesFixture } from '../../../packages/subagent/subagent-codex/tests/responses-fixture.ts'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const fixtureDir = join(testsDir, 'fixtures/subagent/subagent-codex')
const configPath = join(fixtureDir, 'cordis.yml')
const snapshotDir = join(testsDir, 'snapshots/subagent-codex')
const sessionExpected = join(snapshotDir, 'session.expected.jsonl')
const evidenceExpected = join(snapshotDir, 'evidence.expected.json')
const cliBin = join(repoRoot, 'packages/examples/cli-demo/src/bin.ts')
const repoTsconfig = join(repoRoot, 'tsconfig.json')
const codexBinDir = join(
  repoRoot,
  'packages/subagent/subagent-codex/node_modules/.bin',
)
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const CODEX_SENTINEL = 'REAL_CODEX_LOADER_SENTINEL_0_146_0'
const FAKE_KEY = 'dsh-fake-openai-loader-key'

interface PersistedSession {
  readonly content: string
  readonly header: {
    readonly id: string
    readonly cwd: string
  }
}

async function onlySession(root: string): Promise<PersistedSession> {
  const paths = (await readdir(root, { recursive: true }))
    .filter(path => path.endsWith('.jsonl'))
  expect(paths).toHaveLength(1)
  const path = paths[0]
  if (path === undefined) throw new Error('Codex Loader snapshot persisted no session')
  const content = await readFile(join(root, path), 'utf8')
  const header = JSON.parse(content.slice(0, content.indexOf('\n'))) as PersistedSession['header']
  return { content, header }
}

function responseInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap((item): string[] => {
    if (item === null || typeof item !== 'object') return []
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part): string[] => (
      part !== null
      && typeof part === 'object'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    ))
  })
}

describe('real product subagent providers through the Loader', () => {
  it('pins the Codex tool, result, persisted Session, and process quiescence', async () => {
    const responses = await startResponsesFixture([
      { kind: 'complete', text: CODEX_SENTINEL },
    ])
    let session: PersistedSession | undefined
    let quiescence: unknown
    try {
      const result = await runLoaderSmoke({
        label: 'Codex subagent Loader snapshot',
        tempDirPrefix: 'dsh-subagent-codex-loader-',
        binScript: cliBin,
        configPath,
        binArgs: [
          '--config',
          configPath,
          '--output-format',
          'json',
          'Delegate through Codex once.',
        ],
        tsconfigPath: repoTsconfig,
        processTimeoutMs: 45_000,
        env: {
          DSH_TEST_OPENAI_API_KEY: FAKE_KEY,
          PATH: `${codexBinDir}${delimiter}${process.env.PATH ?? ''}`,
        },
        async prepare(cwd): Promise<void> {
          const codexHome = join(cwd, 'codex-home')
          await mkdir(codexHome)
          await writeFile(join(codexHome, 'config.toml'), [
            'model = "fixture-model"',
            'model_provider = "fixture"',
            'approval_policy = "on-request"',
            'sandbox_mode = "read-only"',
            'disable_response_storage = true',
            'check_for_update_on_startup = false',
            '',
            '[model_providers.fixture]',
            'name = "Fixture Responses"',
            `base_url = "${responses.baseUrl}"`,
            'env_key = "OPENAI_API_KEY"',
            'wire_api = "responses"',
            'requires_openai_auth = false',
            '',
            '[analytics]',
            'enabled = false',
            '',
          ].join('\n'))
        },
        async inspect(cwd): Promise<void> {
          session = await onlySession(join(cwd, '.sessions'))
          quiescence = JSON.parse(await readFile(join(cwd, '.codex-quiescence.json'), 'utf8'))
        },
      })

      expect(result.stderr).toBe('')
      expect(session).toBeDefined()
      if (session === undefined) throw new Error('Codex Loader snapshot session was not inspected')
      const context: NormalizeContext = {
        sessionIds: [session.header.id],
        cwd: session.header.cwd,
      }
      const normalizedSession = scrubSystemPrompts(normalizeSessionLog(session.content, context))
      const request = responses.requests[0]
      expect(request).toBeDefined()
      if (request === undefined) throw new Error('Codex Loader snapshot made no Responses request')
      const evidence = `${JSON.stringify({
        stdout: JSON.parse(normalizeStdout(result.stdout, context)) as unknown,
        request: {
          method: request.method,
          path: request.path,
          authorization: request.headers.authorization,
          taskObserved: responseInputTexts(request.body)
            .includes('Return the Loader snapshot sentinel exactly.'),
        },
        quiescence,
      }, null, 2)}\n`

      if (refreshing) {
        await mkdir(snapshotDir, { recursive: true })
        await Promise.all([
          writeFile(sessionExpected, normalizedSession),
          writeFile(evidenceExpected, evidence),
        ])
      }
      expect(normalizedSession).toBe(await readFile(sessionExpected, 'utf8'))
      expect(evidence).toBe(await readFile(evidenceExpected, 'utf8'))
    } finally {
      await responses.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS + 30_000)
})
