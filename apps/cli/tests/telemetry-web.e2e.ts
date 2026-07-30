import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

/**
 * Keyless integration test for the web composition's telemetry row: boot the
 * REAL `dsh web` tree (source launch) against an in-test OTLP/HTTP collector
 * and a mock LLM server, drive one full turn over the /api carrier, then
 * SIGINT — the shutdown drain must deliver the whole ledger plus the ops
 * marker. Asserts what the collector actually received on the wire: OTLP
 * JSON structure, resource identity, both instrumentation scopes, the
 * session's event coverage in seq order, and the first-of-step chunk
 * projection. Package-level capture/backend behavior is covered by
 * session-telemetry-otel's own suites; this file pins the deployment wiring
 * (cordis.yml row + env overrides) end to end. Skips when the frontend dist
 * is not built (the web row fails loud without it).
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))

function frontendDistPresent(): boolean {
  try {
    require.resolve('@deepseek-ai/dsh-frontend/dist/index.html')
    return true
  } catch {
    return false
  }
}

/** One decoded OTLP log record: flattened attributes plus the decoded body. */
interface ReceivedRecord {
  scope: string
  severityText: string
  timeUnixNano: string
  attributes: Record<string, unknown>
  body: unknown
}

/** Decode an OTLP JSON AnyValue into plain JS for readable assertions. */
function decodeAnyValue(value: Record<string, unknown>): unknown {
  if ('stringValue' in value) return value['stringValue']
  if ('intValue' in value) return Number(value['intValue'])
  if ('doubleValue' in value) return value['doubleValue']
  if ('boolValue' in value) return value['boolValue']
  if ('arrayValue' in value) {
    return ((value['arrayValue'] as { values?: Record<string, unknown>[] }).values ?? []).map(decodeAnyValue)
  }
  if ('kvlistValue' in value) {
    const entries = (value['kvlistValue'] as { values?: { key: string; value: Record<string, unknown> }[] }).values ?? []
    return Object.fromEntries(entries.map(entry => [entry.key, decodeAnyValue(entry.value)]))
  }
  return value
}

/** In-test OTLP/HTTP logs collector: captures every POST /v1/logs payload. */
class TestCollector {
  readonly records: ReceivedRecord[] = []
  readonly badRequests: string[] = []
  private server: Server | undefined
  url = ''

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (request.method !== 'POST' || request.url !== '/v1/logs'
          || request.headers['content-type']?.includes('application/json') !== true) {
          this.badRequests.push(`${request.method} ${request.url} ${request.headers['content-type']}`)
          response.writeHead(400).end()
          return
        }
        this.ingest(body)
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
    })
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('collector has no port')
    this.url = `http://127.0.0.1:${address.port}/v1/logs`
  }

  private ingest(body: string): void {
    const payload = JSON.parse(body) as {
      resourceLogs: {
        resource: { attributes: { key: string; value: Record<string, unknown> }[] }
        scopeLogs: {
          scope: { name: string }
          logRecords: {
            timeUnixNano?: string
            severityText?: string
            body?: Record<string, unknown>
            attributes?: { key: string; value: Record<string, unknown> }[]
          }[]
        }[]
      }[]
    }
    for (const resourceLog of payload.resourceLogs) {
      const resource = Object.fromEntries(
        resourceLog.resource.attributes.map(a => [a.key, decodeAnyValue(a.value)]))
      expect(resource['service.name']).toBe('deepseek-harness')
      expect(typeof resource['service.version']).toBe('string')
      for (const scopeLog of resourceLog.scopeLogs) {
        for (const record of scopeLog.logRecords) {
          expect(record.timeUnixNano).toBeTypeOf('string')
          expect(record.severityText).toBeTypeOf('string')
          this.records.push({
            scope: scopeLog.scope.name,
            severityText: record.severityText ?? '',
            timeUnixNano: record.timeUnixNano ?? '',
            attributes: Object.fromEntries((record.attributes ?? []).map(a => [a.key, decodeAnyValue(a.value)])),
            body: record.body === undefined ? undefined : decodeAnyValue(record.body),
          })
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.server?.close()
    this.server?.closeAllConnections()
  }
}

/** Unary /api POST with the client-request envelope; unwraps the ok result. */
async function rpc<T>(base: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', method, rpcId: `e2e-${method}-${Date.now()}`, payload }),
  })
  const parsed = await response.json() as { result: { ok: boolean; value?: T; error?: unknown } }
  if (!parsed.result.ok) throw new Error(`${method} failed: ${JSON.stringify(parsed.result.error)}`)
  return parsed.result.value as T
}

const PROMPT_TEXT = 'telemetry e2e probe: reply with one word'

describe.skipIf(!frontendDistPresent())('web composition telemetry: OTLP collector receives the session ledger', () => {
  const collector = new TestCollector()
  let llm: MockLlmServer
  /** Narrow structural view of the subprocess: execa's per-call generics do not unify under exactOptionalPropertyTypes. */
  let web: {
    kill(signal: NodeJS.Signals): boolean
    settled: Promise<{ exitCode?: number | undefined; stderr?: unknown }>
  } | undefined
  let webBase = ''
  let dshHome = ''

  beforeAll(async () => {
    await collector.start()
    llm = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: 'ok' })
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-telemetry-e2e-'))

    const child = execa(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '0'], {
      cwd: repoRoot,
      reject: false,
      env: {
        DSH_HOME: dshHome,
        DSH_TELEMETRY_OTLP_URL: collector.url,
        DSH_TELEMETRY_DISABLED: '',
        DEEPSEEK_BASE_URL: llm.baseURL,
        DEEPSEEK_API_KEY: 'mock-key',
      },
    })
    web = { kill: signal => child.kill(signal), settled: child.then(result => result) }
    // The URL line is the boot-settled signal; tsx source boot on a cold
    // cache is slow, hence the generous window.
    webBase = await new Promise<string>((resolvePort, rejectPort) => {
      const timer = setTimeout(() => { rejectPort(new Error('dsh web printed no URL within the boot window')) }, 150_000)
      let seen = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString()
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(seen)
        if (match !== null) {
          clearTimeout(timer)
          resolvePort(match[1] as string)
        }
      })
      void child.then((result) => {
        clearTimeout(timer)
        rejectPort(new Error(`dsh web exited before serving: ${String(result.stderr)}`))
      })
    })
  }, 180_000)

  afterAll(async () => {
    // Idempotent: SIGKILL after the test's own SIGINT-exit is a no-op.
    web?.kill('SIGKILL')
    await web?.settled
    await llm.close()
    await collector.stop()
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('streams the full ledger and drains the ops marker on SIGINT', async () => {
    const { sessionId } = await rpc<{ sessionId: string }>(webBase, 'session.create', {})
    await rpc(webBase, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: PROMPT_TEXT }],
    })

    // Wait for the turn to finish via the RPC face (telemetry batches on its
    // own 10s cadence, so the log — not the collector — is the completion signal).
    const deadline = Date.now() + 60_000
    let sawTurnEnd = false
    while (Date.now() < deadline && !sawTurnEnd) {
      const history = await rpc<{ events: { event: { type: string } }[] }>(
        webBase, 'session.history', { sessionId })
      sawTurnEnd = history.events.some(item => item.event.type === 'turn/end')
      if (!sawTurnEnd) await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
    }
    expect(sawTurnEnd).toBe(true)

    // SIGINT → fiber dispose → coordinator emits shutdown markers → backend
    // drain. Everything must reach the collector without waiting a batch tick.
    web?.kill('SIGINT')
    const result = await web?.settled
    expect(result?.exitCode).toBe(130)

    expect(collector.badRequests).toEqual([])

    const mine = collector.records.filter(record => record.attributes['session.id'] === sessionId)
    const ledger = mine.filter(record => record.scope === '@deepseek-ai/dsh-session-telemetry-otel')
    const ops = mine.filter(record => record.scope === '@deepseek-ai/dsh-session-telemetry-otel/ops')

    // Ledger coverage: the canonical turn shape arrived, each row carrying
    // the identity attributes and an integer seq.
    const types = ledger.map(record => record.attributes['event.type'])
    for (const expected of ['turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end']) {
      expect(types, expected).toContain(expected)
    }
    for (const record of ledger) {
      expect(Number.isInteger(record.attributes['event.seq'])).toBe(true)
      expect(record.severityText).toBeTruthy()
    }
    const seqs = ledger.map(record => record.attributes['event.seq'] as number)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)

    // Body fidelity: the exported copy carries the event data (no redaction
    // rule is mounted in this composition).
    const userMessage = ledger.find(record => record.attributes['event.type'] === 'user/message')
    expect(JSON.stringify(userMessage?.body)).toContain(PROMPT_TEXT)

    // Fixed chunk projection: at most the FIRST chunk of each (turn, step).
    const chunkKeys = ledger
      .filter(record => record.attributes['event.type'] === 'assistant/chunk')
      .map((record) => {
        const data = record.body as { turn: number; step: number }
        return `${data.turn}:${data.step}`
      })
    expect(new Set(chunkKeys).size).toBe(chunkKeys.length)

    // The drain proof: the session's clean-exit marker left the process
    // before it died.
    expect(ops.some(record => record.attributes['telemetry.op'] === 'shutdown')).toBe(true)
  }, 120_000)
})
