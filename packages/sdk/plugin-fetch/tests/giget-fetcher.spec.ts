import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { downloadTemplate } from '@bluwy/giget-core'
import {
  createGigetFetcher,
  defaultResolveRef,
  GigetFetcher,
  GITHUB_TEMP_PREFIX,
  type GigetFetcherDeps,
} from '../src/giget-fetcher.ts'
import type { CommitSha } from '../src/ids.ts'
import type { GithubSource } from '../src/source.ts'

vi.mock('@bluwy/giget-core', () => ({ downloadTemplate: vi.fn(async (_input: string, options: { dir: string }) => ({ dir: options.dir, source: '', info: { name: '', tar: '' } })) }))

const SHA = 'a'.repeat(40)

/** A `fetch` mock typed with the call signature the assertions destructure. */
function fetchReturning(response: Response): Mock<(url: string, init?: RequestInit) => Promise<Response>> {
  return vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(response))
}

function fakeDeps(overrides: Partial<GigetFetcherDeps> = {}): {
  deps: GigetFetcherDeps
  download: ReturnType<typeof vi.fn>
  resolveRef: ReturnType<typeof vi.fn>
  createTempDir: ReturnType<typeof vi.fn>
} {
  const download = vi.fn(async () => ({ dir: '/tmp/x' }))
  const resolveRef = vi.fn(async () => SHA as CommitSha)
  const createTempDir = vi.fn(async () => '/tmp/dsh-plugin-github-abc')
  return { deps: { download, resolveRef, createTempDir, ...overrides }, download, resolveRef, createTempDir }
}

describe('GigetFetcher.fetch', () => {
  it('pins the ref to a SHA, downloads that SHA, and reports provenance', async () => {
    const { deps, download, resolveRef, createTempDir } = fakeDeps()
    const source: GithubSource = { kind: 'github', owner: 'unjs', repo: 'template', ref: 'main' }
    const result = await new GigetFetcher(deps).fetch(source)

    expect(resolveRef).toHaveBeenCalledWith(source)
    expect(createTempDir).toHaveBeenCalledWith(GITHUB_TEMP_PREFIX)
    expect(download).toHaveBeenCalledWith(`unjs/template#${SHA}`, { dir: '/tmp/dsh-plugin-github-abc', force: 'clean' })
    expect(result).toEqual({
      dir: '/tmp/dsh-plugin-github-abc',
      source,
      provenance: { kind: 'github', sha: SHA },
    })
  })

  it('includes the subdir in the download input', async () => {
    const { deps, download } = fakeDeps()
    const source: GithubSource = { kind: 'github', owner: 'o', repo: 'r', subdir: 'packages/plugin' }
    await new GigetFetcher(deps).fetch(source)
    expect(download).toHaveBeenCalledWith(`o/r/packages/plugin#${SHA}`, expect.anything())
  })

  it('exposes its source kind', () => {
    expect(new GigetFetcher(fakeDeps().deps).kind).toBe('github')
  })
})

describe('defaultResolveRef', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves the default branch (HEAD) with no auth header', async () => {
    const fetchMock = fetchReturning(new Response(`${SHA}\n`, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const sha = await defaultResolveRef({ kind: 'github', owner: 'o', repo: 'r' })
    expect(sha).toBe(SHA)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/o/r/commits/HEAD')
    expect((init as RequestInit).headers).toEqual({ Accept: 'application/vnd.github.sha' })
  })

  it('resolves an explicit ref and sends a bearer token', async () => {
    const fetchMock = fetchReturning(new Response(SHA, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const sha = await defaultResolveRef({ kind: 'github', owner: 'o', repo: 'r', ref: 'v1.2.3' }, 'secret')
    expect(sha).toBe(SHA)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/o/r/commits/v1.2.3')
    expect((init as RequestInit).headers).toEqual({
      Accept: 'application/vnd.github.sha',
      Authorization: 'Bearer secret',
    })
  })

  it('throws with the HEAD label when the API rejects an unref-ed source', async () => {
    vi.stubGlobal('fetch', fetchReturning(new Response('', { status: 404 })))
    await expect(defaultResolveRef({ kind: 'github', owner: 'o', repo: 'r' })).rejects.toThrow(
      /cannot resolve github ref o\/r#HEAD: HTTP 404/,
    )
  })

  it('throws with the explicit-ref label when the API rejects', async () => {
    vi.stubGlobal('fetch', fetchReturning(new Response('', { status: 403 })))
    await expect(
      defaultResolveRef({ kind: 'github', owner: 'o', repo: 'r', ref: 'main' }),
    ).rejects.toThrow(/cannot resolve github ref o\/r#main: HTTP 403/)
  })
})

describe('createGigetFetcher', () => {
  const downloadMock = vi.mocked(downloadTemplate)
  let savedToken: string | undefined

  beforeEach(() => {
    downloadMock.mockClear()
    savedToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedToken
  })

  it('wires the real download without provider auth when no token is present', async () => {
    vi.stubGlobal('fetch', fetchReturning(new Response(SHA, { status: 200 })))
    await createGigetFetcher().fetch({ kind: 'github', owner: 'o', repo: 'r', ref: 'main' })
    const [input, options] = downloadMock.mock.calls[0]!
    expect(input).toBe(`o/r#${SHA}`)
    expect(options?.dir).toContain(GITHUB_TEMP_PREFIX)
    expect(options?.force).toBe('clean')
    expect(options?.providerOptions).toBeUndefined()
  })

  it('passes an explicit token to both ref resolution and provider auth', async () => {
    const fetchMock = fetchReturning(new Response(SHA, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await createGigetFetcher({ token: 'tok' }).fetch({ kind: 'github', owner: 'o', repo: 'r' })
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
    const [, options] = downloadMock.mock.calls[0]!
    expect(options).toMatchObject({ providerOptions: { auth: 'tok' } })
  })

  it('reads GITHUB_TOKEN from the environment', async () => {
    process.env.GITHUB_TOKEN = 'from-env'
    vi.stubGlobal('fetch', fetchReturning(new Response(SHA, { status: 200 })))
    await createGigetFetcher().fetch({ kind: 'github', owner: 'o', repo: 'r' })
    const [, options] = downloadMock.mock.calls[0]!
    expect(options).toMatchObject({ providerOptions: { auth: 'from-env' } })
  })
})
