import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectLintShard } from './lint-shards.ts'

const packagesRoot = resolve(import.meta.dirname, '..', 'packages')

describe('lint gate shards', () => {
  it('keeps the unsharded local command complete', () => {
    expect(selectLintShard()).toEqual({ eslintTargets: ['.'], includeDuplication: true })
    expect(selectLintShard('')).toEqual({ eslintTargets: ['.'], includeDuplication: true })
  })

  it('partitions package sources and tests into alphabetic ranges plus their repository complement', () => {
    expect(selectLintShard('package-sources-a-c')).toEqual({
      eslintTargets: ['packages/[a-c]*/*/src/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-sources-d-m')).toEqual({
      eslintTargets: ['packages/[d-m]*/*/src/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-sources-n-s')).toEqual({
      eslintTargets: ['packages/[n-s]*/*/src/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-sources-t-z')).toEqual({
      eslintTargets: ['packages/[t-z]*/*/src/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-tests-a-c')).toEqual({
      eslintTargets: ['packages/[a-c]*/*/tests/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-tests-d-m')).toEqual({
      eslintTargets: ['packages/[d-m]*/*/tests/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-tests-n-s')).toEqual({
      eslintTargets: ['packages/[n-s]*/*/tests/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-tests-t-z')).toEqual({
      eslintTargets: ['packages/[t-z]*/*/tests/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-sources-a-m')).toEqual({
      eslintTargets: ['packages/[a-m]*/*/src/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-sources-n-z')).toEqual({
      eslintTargets: ['packages/[n-z]*/*/src/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-tests-a-m')).toEqual({
      eslintTargets: ['packages/[a-m]*/*/tests/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-tests-n-z')).toEqual({
      eslintTargets: ['packages/[n-z]*/*/tests/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('repository')).toEqual({
      eslintTargets: [
        '.',
        '--ignore-pattern',
        'packages/*/*/src/**',
        '--ignore-pattern',
        'packages/*/*/tests/**',
      ],
      includeDuplication: true,
    })
  })

  it('assigns every package group once in the Linux and Windows topologies', () => {
    const groups = readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    const topologies = [
      [/^[a-c]/u, /^[d-m]/u, /^[n-s]/u, /^[t-z]/u],
      [/^[a-m]/u, /^[n-z]/u],
    ]

    for (const ranges of topologies) {
      const assignments = ranges.flatMap(range => groups.filter(group => range.test(group))).sort()
      expect(assignments).toEqual(groups)
    }
  })

  it('rejects an unknown lane', () => {
    expect(() => selectLintShard('missing')).toThrow('unknown DSH_LINT_SHARD')
  })
})
