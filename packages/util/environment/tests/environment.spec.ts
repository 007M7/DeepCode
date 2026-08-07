import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import {
  createEnvironmentSnapshot, DSH_ENVIRONMENT_KEY, environmentOf, isBootstrapOnly,
} from '../src/index.ts'

const layered = createEnvironmentSnapshot([
  { source: 'process', values: { SHARED: 'from-process', ONLY_PROCESS: 'p' } },
  { source: 'project-env', path: '/work/.env', values: { SHARED: 'from-project', ONLY_PROJECT: 'j' } },
  { source: 'user-env', path: '/home/.dsh/.env', values: { SHARED: 'from-user', ONLY_USER: 'u' } },
])

describe('createEnvironmentSnapshot', () => {
  it('resolves across every layer, most trusted first, and reports the winning source', () => {
    expect(layered.get('SHARED')).toEqual({ value: 'from-process', source: 'process' })
    expect(layered.get('ONLY_PROJECT')).toEqual({ value: 'j', source: 'project-env', path: '/work/.env' })
    expect(layered.get('ONLY_USER')).toEqual({ value: 'u', source: 'user-env', path: '/home/.dsh/.env' })
    expect(layered.get('ABSENT')).toBeUndefined()
  })

  it('filters layers without changing their trust order', () => {
    // The point of getFrom: a routing field that must never come from a
    // project directory cannot be reached by reordering, only by listing it.
    expect(layered.getFrom('ONLY_PROJECT', ['process', 'user-env'])).toBeUndefined()
    expect(layered.getFrom('SHARED', ['user-env', 'process']))
      .toEqual({ value: 'from-process', source: 'process' })
    expect(layered.getFrom('SHARED', [])).toBeUndefined()
  })

  it('copies each layer, so a later mutation of the source object cannot change it', () => {
    const values: Record<string, string> = { KEY: 'first' }
    const snapshot = createEnvironmentSnapshot([{ source: 'process', values }])
    values.KEY = 'second'
    values.LATE = 'added'
    expect(snapshot.get('KEY')).toEqual({ value: 'first', source: 'process' })
    expect(snapshot.get('LATE')).toBeUndefined()
  })

  it('keeps an empty value as a present value, for its owner to judge', () => {
    const snapshot = createEnvironmentSnapshot([{ source: 'process', values: { EMPTY: '' } }])
    expect(snapshot.get('EMPTY')).toEqual({ value: '', source: 'process' })
  })

  it('orders lookups canonically regardless of construction order', () => {
    const reversed = createEnvironmentSnapshot([
      { source: 'user-env', path: '/u', values: { K: 'u' } },
      { source: 'process', values: { K: 'p' } },
    ])
    expect(reversed.get('K')).toEqual({ value: 'p', source: 'process' })
  })
})

describe('environmentOf', () => {
  it('returns the launcher snapshot when the product CLI provided one', () => {
    const ctx = new Context()
    ctx.provide(DSH_ENVIRONMENT_KEY, layered)
    expect(environmentOf(ctx)).toBe(layered)
  })

  it('falls back to the inherited environment as the only layer', () => {
    vi.stubEnv('DSH_ENV_SPEC_FALLBACK', 'ambient')
    try {
      const snapshot = environmentOf(new Context())
      expect(snapshot.get('DSH_ENV_SPEC_FALLBACK')).toEqual({ value: 'ambient', source: 'process' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('isBootstrapOnly', () => {
  it.each([
    'PATH', 'HOME', 'USERPROFILE', 'SHELL',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
    'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  ])('rejects %s, which decides how the process starts or reaches the network', (name) => {
    expect(isBootstrapOnly(name)).toBe(true)
  })

  it.each([
    ['DSH_HOME', 'the harness home'],
    ['DSH_PERMISSION_MODE', 'the permission mode'],
    ['DSH_AGENTS_HOME', 'a model-visible instruction root'],
    ['DSH_ANYTHING_ADDED_LATER', 'a switch that does not exist yet'],
    ['XDG_CONFIG_HOME', 'a state root'],
    ['DYLD_INSERT_LIBRARIES', 'a library preload'],
  ])('rejects the whole namespace: %s (%s)', (name) => {
    expect(isBootstrapOnly(name)).toBe(true)
  })

  it('matches case-insensitively, so a lowercase proxy name is not a bypass', () => {
    expect(isBootstrapOnly('https_proxy')).toBe(true)
    expect(isBootstrapOnly('dsh_permission_mode')).toBe(true)
  })

  it('allows ordinary variables, including provider credentials and endpoints', () => {
    for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'EXA_API_KEY', 'MY_PROJECT_FLAG', 'PATHS']) {
      expect(isBootstrapOnly(name)).toBe(false)
    }
  })
})
