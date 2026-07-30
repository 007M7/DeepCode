/** Pure official-DeepSeek readiness projection over the shared Models join. */
import { describe, expect, it } from 'vitest'
import type { CredentialView } from '@deepseek-ai/dsh-client-connection/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { deepSeekReadiness } from '../src/client/store.ts'

const missingCredential: CredentialView = { configured: false, writable: true }

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      active: true,
    },
    configured: true,
    removable: false,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    credential: missingCredential,
    literalApiKeyConfigured: false,
    ...overrides,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    rows: [row()],
    namespaces: new Map(),
    ...overrides,
  }
}

describe('deepSeekReadiness', () => {
  it('waits for the first join and skips onboarding when the adapter directory entry is absent', () => {
    expect(deepSeekReadiness(state({ status: 'idle', rows: [] }))).toEqual({ kind: 'loading' })
    expect(deepSeekReadiness(state({ status: 'loading', rows: [] }))).toEqual({ kind: 'loading' })
    expect(deepSeekReadiness(state({ rows: [] }))).toEqual({ kind: 'adapter-absent' })
  })

  it('addresses the effective credential reference when it is missing and writable', () => {
    expect(deepSeekReadiness(state())).toEqual({
      kind: 'credential-missing',
      displayName: 'DeepSeek',
      ref: 'DEEPSEEK_API_KEY',
    })
  })

  it('accepts file and process-environment credentials without prompting', () => {
    expect(deepSeekReadiness(state({
      rows: [row({ credential: { configured: true, source: 'file', writable: true } })],
    }))).toMatchObject({
      kind: 'configured',
      source: 'credential',
      ref: 'DEEPSEEK_API_KEY',
      credential: { source: 'file', writable: true },
    })
    expect(deepSeekReadiness(state({
      rows: [row({ credential: { configured: true, source: 'env', writable: false } })],
    }))).toMatchObject({
      kind: 'configured',
      source: 'credential',
      credential: { source: 'env', writable: false },
    })
  })

  it('accepts the redacted literal-key sidecar before judging the credential domain', () => {
    expect(deepSeekReadiness(state({
      credentialError: 'credentials service absent',
      rows: [row({ literalApiKeyConfigured: true, credential: undefined })],
    }))).toEqual({ kind: 'configured', source: 'literal' })
  })

  it('turns missing capabilities and inconsistent descriptors into diagnostics', () => {
    expect(deepSeekReadiness(state({ status: 'error', error: 'settings down' }))).toEqual({
      kind: 'unavailable',
      reason: 'settings-unavailable',
      message: 'settings down',
    })
    expect(deepSeekReadiness(state({ status: 'error', error: null }))).toMatchObject({
      kind: 'unavailable',
      reason: 'settings-unavailable',
    })
    expect(deepSeekReadiness(state({
      rows: [row({ entry: { ...row().entry, active: false } })],
    }))).toMatchObject({ kind: 'unavailable', reason: 'provider-inactive' })
    expect(deepSeekReadiness(state({
      rows: [row({ configured: false })],
    }))).toMatchObject({ kind: 'unavailable', reason: 'settings-unavailable' })
    expect(deepSeekReadiness(state({
      rows: [row({ apiKeyEnv: undefined })],
    }))).toMatchObject({ kind: 'unavailable', reason: 'credential-ref-unavailable' })
    expect(deepSeekReadiness(state({
      credentialError: 'credentials service is absent',
    }))).toMatchObject({
      kind: 'unavailable',
      reason: 'credentials-unavailable',
      message: 'credentials service is absent',
    })
    expect(deepSeekReadiness(state({
      rows: [row({ credential: undefined })],
    }))).toMatchObject({ kind: 'unavailable', reason: 'credentials-unavailable' })
    expect(deepSeekReadiness(state({
      rows: [row({ credential: { configured: false, writable: false } })],
    }))).toMatchObject({ kind: 'unavailable', reason: 'credential-read-only' })
  })
})
