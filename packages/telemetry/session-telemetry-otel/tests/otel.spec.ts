/**
 * OTel backend unit tier: wire assertions against a scripted `node:http`
 * mock collector through the SDK's REAL pipeline (BatchLogRecordProcessor →
 * OTLP/HTTP JSON), config fail-loud cases, and the real-Loader-path guard
 * for the default-exported Service class.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TelemetryOtel, { Config } from '../src/index.ts'

interface Capture {
  headers: import('node:http').IncomingHttpHeaders
  body: OtlpLogsRequest
}

/** Just the slice of ExportLogsServiceRequest JSON these assertions touch. */
interface OtlpLogsRequest {
  resourceLogs: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] }
    scopeLogs: {
      scope: { name: string }
      logRecords: {
        timeUnixNano: string
        severityNumber: number
        severityText: string
        attributes?: { key: string; value: Record<string, unknown> }[]
      }[]
    }[]
  }[]
}

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close()
    server.closeAllConnections()
  }
})

async function mockCollector(
  beforeRespond?: (requestIndex: number) => Promise<void> | void,
): Promise<{ url: string; captures: Capture[] }> {
  const captures: Capture[] = []
  let requestIndex = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const index = requestIndex++
      void (async () => {
        await beforeRespond?.(index)
        const raw = Buffer.concat(chunks)
        const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
        captures.push({
          headers: request.headers,
          body: JSON.parse(body.toString()) as OtlpLogsRequest,
        })
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })()
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}/v1/logs`, captures }
}

async function boot(url: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(TelemetryOtel, {
    exporter: { url, headers: { authorization: 'Bearer test-token' } },
  })
  return { ctx, fiber }
}

function allRecords(captures: Capture[]) {
  return captures.flatMap(c => c.body.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s =>
    s.logRecords.map(record => ({ scope: s.scope.name, record })))))
}

describe('TelemetryOtel wire', () => {
  it('ships session records and the ops shutdown marker through the real SDK pipeline', async () => {
    const { url, captures } = await mockCollector()
    const { ctx, fiber } = await boot(url)
    const session = ctx.sessions.create(SessionId('wire'), { meta: { cwd: '/tmp/w' } })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'boom' } })
    await fiber.dispose()

    expect(captures.length).toBeGreaterThan(0)
    const first = captures[0]!
    const authorization: string | undefined = first.headers.authorization
    expect(authorization).toBe('Bearer test-token')

    const resource = first.body.resourceLogs[0]!.resource.attributes
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'deepseek-harness' } })

    const records = allRecords(captures)
    const ledger = records.filter(r => r.scope === '@deepseek-ai/dsh-session-telemetry-otel')
    const ops = records.filter(r => r.scope === '@deepseek-ai/dsh-session-telemetry-otel/ops')

    const start = ledger.find(r => r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'turn/start'))
    expect(start).toBeDefined()
    expect(start?.record.severityNumber).toBe(9)
    expect(BigInt(start!.record.timeUnixNano)).toBe(BigInt(session.events[0]!.time) * 1_000_000n)
    expect(start?.record.attributes).toContainEqual({ key: 'session.cwd', value: { stringValue: '/tmp/w' } })

    const end = ledger.find(r => r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'turn/end'))
    expect(end?.record.severityNumber).toBe(17)
    expect(end?.record.severityText).toBe('ERROR')

    expect(ops).toHaveLength(1)
    expect(ops[0]!.record.attributes).toContainEqual({ key: 'telemetry.op', value: { stringValue: 'shutdown' } })
  })

  it('drains records enqueued after a timer export began: dispose during an in-flight batch', async () => {
    // The backend implements NO flush() — the batch processor exports on its
    // own cadence, and shutdown's internal drain is complete exactly because
    // nothing in the process calls forceFlush() concurrently (the SDK's
    // concurrent-flush guard skips draining otherwise). Pin that: hold the
    // collector's response to the timer-triggered export open across
    // disposal, and the dispose-time shutdown marker (enqueued after that
    // batch's snapshot) must still arrive.
    const gate = Promise.withResolvers<boolean>()
    const arrived = Promise.withResolvers<boolean>()
    const { url, captures } = await mockCollector(async (index) => {
      if (index === 0) {
        arrived.resolve(true)
        await gate.promise
      }
    })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(TelemetryOtel, {
      exporter: { url },
      processor: { scheduledDelayMillis: 10 },
    })
    const session = ctx.sessions.create(SessionId('drain'), { meta: {} })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await arrived.promise

    const disposal = fiber.dispose()
    // Let disposal reach the backend's shutdown while the export is held open.
    await new Promise(resolve => setTimeout(resolve, 50))
    gate.resolve(true)
    await disposal

    const ops = allRecords(captures).filter(r => r.scope === '@deepseek-ai/dsh-session-telemetry-otel/ops')
    expect(ops).toHaveLength(1)
    expect(ops[0]!.record.attributes).toContainEqual({ key: 'telemetry.op', value: { stringValue: 'shutdown' } })
  })

  it('passes exporter options beyond url and headers through to the SDK exporter', async () => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // `compression` is a documented SDK exporter option; the advertised
    // verbatim passthrough must hand it (and every other field) to the
    // exporter rather than silently rebuilding url/headers only.
    const fiber = await ctx.plugin(TelemetryOtel, {
      exporter: { url, compression: 'gzip' },
    } as Config)
    const session = ctx.sessions.create(SessionId('gzip'), { meta: {} })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await fiber.dispose()

    expect(captures.length).toBeGreaterThan(0)
    expect(captures[0]!.headers['content-encoding']).toBe('gzip')
    const types = allRecords(captures).flatMap(({ record }) =>
      record.attributes?.flatMap(a => a.key === 'event.type' ? [a.value.stringValue] : []) ?? [])
    expect(types).toContain('turn/start')
  })

  it('maps the warn severity and leaves the seam flush hint unimplemented', async () => {
    const { url, captures } = await mockCollector()
    const { ctx, fiber } = await boot(url)
    const session = ctx.sessions.create(SessionId('warn'), { meta: {} })
    session.append('prompt/blocked', { content: [], source: { kind: 'user' }, reason: 'vetoed' })
    // No flush(): the coordinator's optional-call forwarding no-ops, and the
    // batch processor owns export cadence end to end (see the backend note).
    expect('flush' in ctx.telemetry && ctx.telemetry.flush !== undefined).toBe(false)
    await fiber.dispose()
    const blocked = allRecords(captures).find(r =>
      r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'prompt/blocked'))
    expect(blocked?.record.severityNumber).toBe(13)
  })
})

describe('TelemetryOtel config fails loud', () => {
  it.each([
    [{}, /exporter\.url is required/],
    [{ exporter: { url: '' } }, /exporter\.url is required/],
    [{ exporter: { url: 'not a url' } }, /not a valid URL/],
    [{ exporter: { url: 'ftp://collector' } }, /must be http\(s\)/],
    // The SDK accepts a non-positive batch size but its shutdown drain then
    // splices empty batches forever — dispose would hang, so reject at load.
    [{ exporter: { url: 'http://c/v1/logs' }, processor: { maxExportBatchSize: 0 } }, /maxExportBatchSize/],
    [{ exporter: { url: 'http://c/v1/logs' }, processor: { maxExportBatchSize: 0.5 } }, /maxExportBatchSize/],
  ])('rejects %j at plugin load', async (config, message) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(TelemetryOtel, config as Config)).rejects.toThrow(message)
  })
})

describe('dsh-session-telemetry-otel real-load-path guard', () => {
  it('keeps the Service class with inject/Config through unwrapExports', async () => {
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as typeof TelemetryOtel
    expect(unwrapped).toBe(TelemetryOtel)
    expect(unwrapped.inject).toEqual(['sessions'])
    expect(typeof unwrapped.Config).toBe('function')
  })

  it('boots through the unwrapped class and registers ctx.telemetry', async () => {
    const { url } = await mockCollector()
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as Parameters<Context['plugin']>[0]
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(unwrapped, { exporter: { url } })
    expect(ctx.telemetry).toBeInstanceOf(TelemetryOtel)
    await fiber.dispose()
  })
})
