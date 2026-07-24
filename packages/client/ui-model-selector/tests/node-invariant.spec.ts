/** Host-half placeholder and package invariant companion. */

import { describe, expect, it, vi } from 'vitest'
import { apply as nodeApply } from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

describe('model-selector node half and invariant companion', () => {
  it('keeps the host half as an intentional no-op', () => {
    nodeApply(undefined as never)
    expect(true).toBe(true)
  })

  it('registers the package-owned empty invariant installer', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    const dispose = await invariant.apply(ctx)
    expect(invariant.name).toBe('client-ui-model-selector-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-client-ui-model-selector',
      expect.any(Function),
    )
    expect(() => {
      (register.mock.calls[0]![1] as (inner: never) => void)(undefined as never)
    }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
