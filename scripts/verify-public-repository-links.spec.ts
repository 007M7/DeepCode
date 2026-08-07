import { describe, expect, it } from 'vitest'
import { findInternalRepositoryReferences } from './verify-public-repository-links.ts'

describe('public repository link policy', () => {
  it('rejects the internal remote and accepts the public home', () => {
    const internalRepository = ['deepseek-harness', 'deepseek-harness'].join('/')
    const source = [
      'https://github.com/deepseek-ai/deepseek-harness-sdk',
      `https://github.com/${internalRepository}/issues/1`,
    ].join('\n')

    expect(findInternalRepositoryReferences('subject.md', source)).toEqual([
      { file: 'subject.md', line: 2 },
    ])
  })
})
