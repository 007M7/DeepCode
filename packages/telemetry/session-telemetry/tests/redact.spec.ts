/**
 * Default redaction rules and the `telemetry/redact` waterfall contract:
 * credential shapes scrubbed from bodies and attribute values, structure
 * preserved, canonical log untouched, listener stacking/replacement, and the
 * fail-closed containment of a throwing rule.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  applyDefaultRedaction,
  REDACTION_PLACEHOLDER,
  TelemetryCoordinator,
  type TelemetryBackend,
  type TelemetryRecord,
} from '../src/index.ts'

const SECRETS = {
  deepseek: 'sk-abcdef1234567890abcdef',
  anthropic: 'sk-ant-abcdef1234567890',
  githubPat: 'ghp_ABCDEFGHIJKLMNOPqrstuv12345678',
  finePat: 'github_pat_ABCDEFGHIJKLMNOPQRSTuvwx',
  slack: 'xoxb-1234567890-abcdefghij',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  google: 'AIzaSyA-1234567890abcdefghijklmnopqrstu',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  urlCreds: 'https://user:hunter2@internal.example.com/repo.git',
} as const

function record(body: unknown, attributes: Record<string, string | number> = {}): TelemetryRecord {
  return { channel: 'ledger', time: 1, severity: 'info', attributes, body }
}

describe('applyDefaultRedaction', () => {
  it('scrubs every known credential shape while preserving surrounding text', () => {
    for (const secret of Object.values(SECRETS)) {
      const out = applyDefaultRedaction(record(`before ${secret} after`))
      expect(out.body, secret).not.toContain(secret.includes('\n') ? 'MIIEow' : secret)
      expect(out.body).toContain('before ')
      expect(out.body).toContain(' after')
      expect(out.body).toContain(REDACTION_PLACEHOLDER)
    }
  })

  it('scrubs URL userinfo credentials but leaves plain URLs alone', () => {
    const out = applyDefaultRedaction(record(`${SECRETS.urlCreds} and https://example.com/path`))
    expect(out.body).not.toContain('hunter2')
    expect(out.body).toContain('https://example.com/path')
  })

  it('recurses through arrays and objects, preserving structure and non-strings', () => {
    const out = applyDefaultRedaction(record({
      list: [`key=${SECRETS.deepseek}`, 7, null, true],
      nested: { text: SECRETS.githubPat, count: 3 },
    }))
    expect(out.body).toEqual({
      list: [`key=${REDACTION_PLACEHOLDER}`, 7, null, true],
      nested: { text: REDACTION_PLACEHOLDER, count: 3 },
    })
  })

  it('leaves low-signal values untouched', () => {
    const clean = {
      pkg: '@deepseek-ai/dsh-session-telemetry@0.0.1',
      sha: '342a4c3a9d3adf13cf4ad33b9f8d6e79170be5e2',
      prose: 'ordinary sentence with kebab-case-identifier',
    }
    expect(applyDefaultRedaction(record(clean)).body).toEqual(clean)
  })

  it('scrubs string attribute values and keeps numeric ones', () => {
    const out = applyDefaultRedaction(record(null, {
      'session.cwd': `/home/${SECRETS.aws}/proj`,
      'event.seq': 4,
    }))
    expect(out.attributes['session.cwd']).toBe(`/home/${REDACTION_PLACEHOLDER}/proj`)
    expect(out.attributes['event.seq']).toBe(4)
  })

  it('never mutates its input', () => {
    const input = record({ text: SECRETS.slack }, { 'session.cwd': SECRETS.aws })
    applyDefaultRedaction(input)
    expect((input.body as { text: string }).text).toBe(SECRETS.slack)
    expect(input.attributes['session.cwd']).toBe(SECRETS.aws)
  })
})

class CollectingBackend implements TelemetryBackend {
  records: TelemetryRecord[] = []
  emit(record: TelemetryRecord): void {
    this.records.push(record)
  }
  async shutdown(): Promise<void> {}
}

async function setup() {
  const backend = new CollectingBackend()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin({
    name: 'fake-telemetry',
    inject: ['sessions'],
    apply: (inner: Context) => void new TelemetryCoordinator(inner, backend),
  })
  return { ctx, backend }
}

describe('telemetry/redact waterfall', () => {
  it('applies the default rules when no listener is registered', async () => {
    const { ctx, backend } = await setup()
    const session = ctx.sessions.create(SessionId('w'))
    session.append('user/message', { content: [{ type: 'text', text: `key ${SECRETS.deepseek}` }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const body = backend.records[0]!.body as { content: { text: string }[] }
    expect(body.content[0]!.text).toBe(`key ${REDACTION_PLACEHOLDER}`)
  })

  it('keeps the canonical log unredacted', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('log'))
    session.append('user/message', { content: [{ type: 'text', text: SECRETS.githubPat }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const logged = session.events[0]!.data as { content: { text: string }[] }
    expect(logged.content[0]!.text).toBe(SECRETS.githubPat)
  })

  it('lets a listener stack a stricter rule on top of the defaults', async () => {
    const { ctx, backend } = await setup()
    ctx.on('telemetry/redact', (_record, next) => {
      const defaulted = next()
      return { ...defaulted, body: { shapeOnly: true } }
    })
    const session = ctx.sessions.create(SessionId('stack'))
    session.append('user/message', { content: [{ type: 'text', text: 'anything' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(backend.records[0]!.body).toEqual({ shapeOnly: true })
  })

  it('a listener that skips next() replaces the default rules', async () => {
    const { ctx, backend } = await setup()
    ctx.on('telemetry/redact', record => record)
    const session = ctx.sessions.create(SessionId('veto'))
    session.append('user/message', { content: [{ type: 'text', text: SECRETS.slack }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const body = backend.records[0]!.body as { content: { text: string }[] }
    expect(body.content[0]!.text).toBe(SECRETS.slack)
  })

  it('a throwing rule withholds the record fail-closed without disturbing the log', async () => {
    const { ctx, backend } = await setup()
    ctx.on('telemetry/redact', () => {
      throw new Error('rule exploded')
    })
    const session = ctx.sessions.create(SessionId('closed'))
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(backend.records).toHaveLength(0)
    expect(session.events).toHaveLength(1)
  })
})
