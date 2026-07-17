import { rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  createTempDir,
  fetchPlugin,
  type FetchedPlugin,
  type PluginFetchers,
} from '../src/fetcher.ts'
import { commitSha } from '../src/ids.ts'
import type { GithubSource, NpmSource, PluginSource } from '../src/source.ts'

function stubFetchers(): { fetchers: PluginFetchers; github: ReturnType<typeof vi.fn>; npm: ReturnType<typeof vi.fn> } {
  const result = (dir: string): FetchedPlugin => ({
    dir,
    source: { kind: 'github', owner: 'o', repo: 'r' },
    provenance: { kind: 'github', sha: commitSha('a'.repeat(40)) },
  })
  const github = vi.fn(async (source: GithubSource) => result(`github:${source.repo}`))
  const npm = vi.fn(async (source: NpmSource) => result(`npm:${source.name}`))
  return {
    fetchers: { github: { kind: 'github', fetch: github }, npm: { kind: 'npm', fetch: npm } },
    github,
    npm,
  }
}

describe('fetchPlugin', () => {
  it('routes a github source to the github fetcher', async () => {
    const { fetchers, github, npm } = stubFetchers()
    const source: GithubSource = { kind: 'github', owner: 'o', repo: 'r' }
    const result = await fetchPlugin(source, fetchers)
    expect(github).toHaveBeenCalledWith(source)
    expect(npm).not.toHaveBeenCalled()
    expect(result.dir).toBe('github:r')
  })

  it('routes an npm source to the npm fetcher', async () => {
    const { fetchers, github, npm } = stubFetchers()
    const source: NpmSource = { kind: 'npm', name: 'plugin', version: '1.0.0' }
    const result = await fetchPlugin(source, fetchers)
    expect(npm).toHaveBeenCalledWith(source)
    expect(github).not.toHaveBeenCalled()
    expect(result.dir).toBe('npm:plugin')
  })

  it('throws on an unknown source kind', () => {
    const { fetchers } = stubFetchers()
    const bogus = { kind: 'svn' } as unknown as PluginSource
    expect(() => fetchPlugin(bogus, fetchers)).toThrow(/unreachable variant in fetchPlugin/)
  })
})

describe('createTempDir', () => {
  it('creates a fresh empty directory under the OS temp root', async () => {
    const dir = await createTempDir('dsh-plugin-fetch-test-')
    try {
      expect(dir.startsWith(tmpdir())).toBe(true)
      expect((await stat(dir)).isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
