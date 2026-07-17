import { describe, expect, it } from 'vitest'
import { resolvePluginSource, type GithubSource, type NpmSource } from '../src/source.ts'

describe('resolvePluginSource — github', () => {
  it('parses owner/repo with a ref', () => {
    expect(resolvePluginSource('unjs/template#main')).toEqual<GithubSource>({
      kind: 'github', owner: 'unjs', repo: 'template', ref: 'main',
    })
  })

  it('parses a bare owner/repo without a ref', () => {
    expect(resolvePluginSource('deepseek-ai/plugin')).toEqual<GithubSource>({
      kind: 'github', owner: 'deepseek-ai', repo: 'plugin',
    })
  })

  it('parses a nested subdir with a ref', () => {
    expect(resolvePluginSource('owner/repo/packages/plugin#v1.2.3')).toEqual<GithubSource>({
      kind: 'github', owner: 'owner', repo: 'repo', subdir: 'packages/plugin', ref: 'v1.2.3',
    })
  })

  it('parses a subdir without a ref', () => {
    expect(resolvePluginSource('owner/repo/sub')).toEqual<GithubSource>({
      kind: 'github', owner: 'owner', repo: 'repo', subdir: 'sub',
    })
  })

  it('accepts a slash-nested ref', () => {
    expect(resolvePluginSource('owner/repo#feature/x')).toEqual<GithubSource>({
      kind: 'github', owner: 'owner', repo: 'repo', ref: 'feature/x',
    })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(resolvePluginSource('  owner/repo#main  ')).toEqual<GithubSource>({
      kind: 'github', owner: 'owner', repo: 'repo', ref: 'main',
    })
  })

  it.each([
    ['empty ref after hash', 'owner/repo#'],
    ['single locator segment with hash', 'owner#main'],
    ['owner with @ and a hash', 'own@er/repo#main'],
    ['ref with whitespace', 'owner/repo#bad ref'],
    ['ref with traversal', 'owner/repo#a..b'],
    ['ref with a leading slash', 'owner/repo#/main'],
    ['ref with a trailing slash', 'owner/repo#main/'],
    ['ref with an illegal char', 'owner/repo#ma:in'],
  ])('rejects a malformed github spec (%s)', (_label, spec) => {
    expect(() => resolvePluginSource(spec)).toThrow(/github plugin source|missing a ref/)
  })
})

describe('resolvePluginSource — npm', () => {
  it('parses an unscoped name@version', () => {
    expect(resolvePluginSource('react@18.2.0')).toEqual<NpmSource>({
      kind: 'npm', name: 'react', version: '18.2.0',
    })
  })

  it('parses a scoped name@version', () => {
    expect(resolvePluginSource('@deepseek-ai/dsh-tool-foo@0.0.1')).toEqual<NpmSource>({
      kind: 'npm', name: '@deepseek-ai/dsh-tool-foo', version: '0.0.1',
    })
  })

  it('accepts a dist-tag as the version', () => {
    expect(resolvePluginSource('some-plugin@latest')).toEqual<NpmSource>({
      kind: 'npm', name: 'some-plugin', version: 'latest',
    })
  })

  it('accepts a range as the version', () => {
    expect(resolvePluginSource('some-plugin@^1.0.0')).toEqual<NpmSource>({
      kind: 'npm', name: 'some-plugin', version: '^1.0.0',
    })
  })
})

describe('resolvePluginSource — failures', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects a blank spec (%s)', (_label, spec) => {
    expect(() => resolvePluginSource(spec)).toThrow(/must not be empty/)
  })

  it.each([
    ['bare word', 'plugin'],
    ['internal whitespace', 'owner repo'],
    ['empty npm version', 'pkg@'],
    ['scoped without version', '@scope/pkg'],
    ['scoped with empty scope', '@/pkg@1'],
    ['unscoped name with slash and version', 'foo/bar@1'],
    ['version containing a slash', 'foo@1/2'],
    ['uppercase unscoped name', 'FOO@1.0.0'],
    ['uppercase scope segment', '@Scope/pkg@1'],
    ['uppercase scoped name segment', '@scope/PKG@1'],
    ['empty scoped name segment', '@scope/@1'],
    ['dot-only owner', './repo'],
    ['traversal subdir segment', 'owner/repo/../x'],
    ['double slash subdir', 'owner/repo//sub'],
  ])('rejects an unrecognized/ambiguous spec (%s)', (_label, spec) => {
    expect(() => resolvePluginSource(spec)).toThrow(/unrecognized plugin source|github plugin source/)
  })
})
