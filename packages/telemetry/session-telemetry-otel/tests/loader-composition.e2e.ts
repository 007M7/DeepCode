/**
 * REAL-composition tier: boot the examples-owned telemetry Loader fixture as
 * a subprocess (per testing policy, through the same app/boot path a
 * deployment uses), run one mocked-model turn with a real bash round trip,
 * and assert against what the mock OTLP collector actually received on the
 * wire: ledger mirroring, the deployment-mounted redact rule applied to the
 * exported copy, ops markers, and the untouched canonical log.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/telemetry-otel-driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/telemetry-otel.cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

const FIXTURE_SECRET = 'sk-e2efixture1234567890'
const FIXTURE_PLACEHOLDER = '[E2E-REDACTED]'

interface OtlpLogRecord {
  attributes?: { key: string; value: Record<string, unknown> }[]
  body?: unknown
}

interface OtlpCapture {
  resourceLogs: {
    scopeLogs: {
      scope: { name: string }
      logRecords: OtlpLogRecord[]
    }[]
  }[]
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('session-telemetry-otel through a real headless cordis.yml', () => {
  it('exports redacted ledger records to the collector while the canonical log keeps the secret', async () => {
    let captures: OtlpCapture[] = []
    let logContent = ''
    const { stderr } = await runLoaderSmoke({
      label: 'session-telemetry-otel loader smoke',
      tempDirPrefix: 'telemetry-otel-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        captures = JSON.parse(await readFile(join(cwd, 'otlp-captures.json'), 'utf8')) as OtlpCapture[]
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        logContent = await readFile(logs[0] as string, 'utf8')
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    const records = captures.flatMap(capture => capture.resourceLogs.flatMap(resource =>
      resource.scopeLogs.flatMap(scoped => scoped.logRecords.map(record => ({ scope: scoped.scope.name, record })))))
    expect(records.length).toBeGreaterThan(0)

    const eventTypes = records.flatMap(({ record }) =>
      record.attributes?.flatMap(attribute =>
        attribute.key === 'event.type' && typeof attribute.value['stringValue'] === 'string'
          ? [attribute.value['stringValue']]
          : []) ?? [])
    for (const expected of ['turn/start', 'user/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end']) {
      expect(eventTypes, expected).toContain(expected)
    }
    expect(records.some(({ scope }) => scope.endsWith('/ops'))).toBe(true)

    // The deployment-mounted rule on the wire: the fixture credential never
    // leaves the process, its surrounding prose does, and the placeholder
    // marks the spot — the seam itself ships no rules.
    const wire = JSON.stringify(captures)
    expect(wire).not.toContain(FIXTURE_SECRET)
    expect(wire).toContain(FIXTURE_PLACEHOLDER)
    expect(wire).toContain('prove telemetry with key')

    // The canonical session log is never rewritten.
    expect(logContent).toContain(FIXTURE_SECRET)
    expect(logContent).not.toContain(FIXTURE_PLACEHOLDER)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
