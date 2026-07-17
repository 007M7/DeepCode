import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extract as pacoteExtract, manifest as pacoteManifest } from 'pacote'
import {
  createPacoteFetcher,
  NPM_TEMP_PREFIX,
  PacoteFetcher,
  type PacoteApi,
  type PacoteFetcherDeps,
} from '../src/pacote-fetcher.ts'
import type { NpmSource } from '../src/source.ts'

vi.mock('pacote', () => ({ manifest: vi.fn(), extract: vi.fn() }))

const INTEGRITY = 'sha512-abcABC123+/=='
const RESOLVED = 'https://registry.npmjs.org/plugin/-/plugin-1.2.3.tgz'

function fakePacote(): PacoteApi {
  return {
    manifest: vi.fn(async () => ({ _resolved: RESOLVED, _integrity: INTEGRITY, version: '1.2.3' })),
    extract: vi.fn(async () => ({ resolved: RESOLVED, integrity: INTEGRITY })),
  }
}

function deps(overrides: Partial<PacoteFetcherDeps> = {}): PacoteFetcherDeps {
  return {
    pacote: fakePacote(),
    createTempDir: vi.fn(async () => '/tmp/dsh-plugin-npm-abc'),
    ...overrides,
  }
}

const SOURCE: NpmSource = { kind: 'npm', name: 'plugin', version: '^1.0.0' }

describe('PacoteFetcher.fetch', () => {
  it('resolves the manifest, extracts with integrity, and reports provenance', async () => {
    const d = deps()
    const result = await new PacoteFetcher(d).fetch(SOURCE)

    expect(d.pacote.manifest).toHaveBeenCalledWith('plugin@^1.0.0', {})
    expect(d.createTempDir).toHaveBeenCalledWith(NPM_TEMP_PREFIX)
    expect(d.pacote.extract).toHaveBeenCalledWith('plugin@^1.0.0', '/tmp/dsh-plugin-npm-abc', {
      resolved: RESOLVED,
      integrity: INTEGRITY,
    })
    expect(result).toEqual({
      dir: '/tmp/dsh-plugin-npm-abc',
      source: SOURCE,
      provenance: { kind: 'npm', version: '1.2.3', resolved: RESOLVED, integrity: INTEGRITY },
    })
  })

  it('forwards a configured registry to both manifest and extract', async () => {
    const d = deps({ registry: 'https://npm.internal/' })
    await new PacoteFetcher(d).fetch(SOURCE)
    expect(d.pacote.manifest).toHaveBeenCalledWith('plugin@^1.0.0', { registry: 'https://npm.internal/' })
    expect(d.pacote.extract).toHaveBeenCalledWith('plugin@^1.0.0', '/tmp/dsh-plugin-npm-abc', {
      registry: 'https://npm.internal/',
      resolved: RESOLVED,
      integrity: INTEGRITY,
    })
  })

  it('rejects a registry integrity that is not a valid SRI', async () => {
    const pacote = fakePacote()
    pacote.extract = vi.fn(async () => ({ resolved: RESOLVED, integrity: 'not-sri' }))
    await expect(new PacoteFetcher(deps({ pacote })).fetch(SOURCE)).rejects.toThrow(
      /invalid subresource integrity/,
    )
  })

  it('exposes its source kind', () => {
    expect(new PacoteFetcher(deps()).kind).toBe('npm')
  })
})

describe('createPacoteFetcher', () => {
  const manifestMock = vi.mocked(pacoteManifest)
  const extractMock = vi.mocked(pacoteExtract)

  beforeEach(() => {
    manifestMock.mockReset()
    extractMock.mockReset()
    // The real overloaded pacote manifest returns a much wider shape; the fetcher reads only these fields.
    manifestMock.mockResolvedValue(
      { _resolved: RESOLVED, _integrity: INTEGRITY, version: '1.2.3' } as unknown as Awaited<
        ReturnType<typeof pacoteManifest>
      >,
    )
    extractMock.mockResolvedValue({ from: 'plugin@1.2.3', resolved: RESOLVED, integrity: INTEGRITY })
  })

  afterEach(() => vi.clearAllMocks())

  it('wires the real pacote resolve/extract surface', async () => {
    const result = await createPacoteFetcher().fetch(SOURCE)
    expect(manifestMock).toHaveBeenCalledWith('plugin@^1.0.0', {})
    expect(extractMock).toHaveBeenCalledWith('plugin@^1.0.0', expect.stringContaining(NPM_TEMP_PREFIX), {
      resolved: RESOLVED,
      integrity: INTEGRITY,
    })
    expect(result.provenance).toEqual({ kind: 'npm', version: '1.2.3', resolved: RESOLVED, integrity: INTEGRITY })
  })

  it('forwards a configured registry through the real surface', async () => {
    await createPacoteFetcher({ registry: 'https://npm.internal/' }).fetch(SOURCE)
    expect(manifestMock).toHaveBeenCalledWith('plugin@^1.0.0', { registry: 'https://npm.internal/' })
  })
})
