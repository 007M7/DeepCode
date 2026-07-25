import { describe, expect, it } from 'vitest'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { parseRetryPolicyKey, retryPolicyKey } from '../src/policy-key.ts'

describe('retry policy durable key', () => {
  it('includes every policy field while normalizing code-set order', () => {
    const first = resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['SERVER', 'RATE_LIMIT'],
      backoff: { initialDelayMs: 3, maxDelayMs: 9, jitterRatio: 0.25 },
    }, 'first')
    const reordered = resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['RATE_LIMIT', 'SERVER'],
      backoff: { initialDelayMs: 3, maxDelayMs: 9, jitterRatio: 0.25 },
    }, 'reordered')
    const key = retryPolicyKey(first)

    expect(key).toBe('["normal",4,["RATE_LIMIT","SERVER"],3,9,0.25]')
    expect(retryPolicyKey(reordered)).toBe(key)
    expect(parseRetryPolicyKey(key)).toEqual(reordered)
  })

  it('round-trips always mode', () => {
    const policy = resolveRetryPolicy({
      mode: 'always',
      backoff: { initialDelayMs: 2, maxDelayMs: 8, jitterRatio: 1 },
    }, 'always')
    const key = retryPolicyKey(policy)

    expect(key).toBe('["always",2,8,1]')
    expect(parseRetryPolicyKey(key)).toEqual(policy)
  })

  it.each([
    undefined,
    '',
    '{',
    '{}',
    '["sometimes",1,2,0]',
    '["always",1,2]',
    '["always","1",2,0]',
    '["always",1e400,2,0]',
    '["always",0,2,0]',
    `["always",${MAX_TIMER_DELAY_MS + 1},${MAX_TIMER_DELAY_MS + 1},0]`,
    '["always",1,"2",0]',
    '["always",1,1e400,0]',
    '["always",1,0,0]',
    `["always",1,${MAX_TIMER_DELAY_MS + 1},0]`,
    '["always",2,1,0]',
    '["always",1,2,"0"]',
    '["always",1,2,1e400]',
    '["always",1,2,-0.1]',
    '["always",1,2,1.1]',
    '["normal",2,["SERVER"],1,2]',
    '["normal","2",["SERVER"],1,2,0]',
    '["normal",-1,["SERVER"],1,2,0]',
    '["normal",2,"SERVER",1,2,0]',
    '["normal",2,[],1,2,0]',
    '["normal",2,[1],1,2,0]',
    '["normal",2,[""],1,2,0]',
    '["normal",2,["SERVER","SERVER"],1,2,0]',
    '["normal",2,["SERVER"],2,1,0]',
    '["normal",2,["SERVER","RATE_LIMIT"],1,2,0]',
  ])('rejects non-canonical durable input %#', (value) => {
    expect(parseRetryPolicyKey(value)).toBeUndefined()
  })
})
