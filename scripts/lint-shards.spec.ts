import { describe, expect, it } from 'vitest'
import { selectLintShard } from './lint-shards.ts'

describe('lint gate shards', () => {
  it('keeps the unsharded local command complete', () => {
    expect(selectLintShard()).toEqual({ eslintTargets: ['.'], includeDuplication: true })
    expect(selectLintShard('')).toEqual({ eslintTargets: ['.'], includeDuplication: true })
  })

  it('partitions package sources, package tests, and their repository complement', () => {
    expect(selectLintShard('package-sources')).toEqual({
      eslintTargets: ['packages/*/*/src/**/*.ts'],
      includeDuplication: false,
    })
    expect(selectLintShard('package-tests')).toEqual({
      eslintTargets: ['packages/*/*/tests/**/*.ts'],
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

  it('rejects an unknown lane', () => {
    expect(() => selectLintShard('missing')).toThrow('unknown DSH_LINT_SHARD')
  })
})
