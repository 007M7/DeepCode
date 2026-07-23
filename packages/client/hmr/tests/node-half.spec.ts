/**
 * Node half of the HMR plugin: an empty apply placeholder (the reload driver
 * lives in the client half) whose only contract is mounting and disposing
 * cleanly in the host Loader.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '@deepseek-ai/dsh-client-hmr'

describe('hmr node half', () => {
  it('apply is a no-op host placeholder', () => {
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
