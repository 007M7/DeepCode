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

  it('partitions package sources and tests into alphabetic halves plus their repository complement', () => {
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

  it('assigns every package group to one alphabetic half', () => {
    const groups = readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    const firstHalf = groups.filter(group => /^[a-m]/u.test(group))
    const secondHalf = groups.filter(group => /^[n-z]/u.test(group))

    expect([...firstHalf, ...secondHalf].sort()).toEqual(groups)
  })

  it('rejects an unknown lane', () => {
    expect(() => selectLintShard('missing')).toThrow('unknown DSH_LINT_SHARD')
  })
})
