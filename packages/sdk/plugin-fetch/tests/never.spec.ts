import { describe, expect, it } from 'vitest'
import { assertNever } from '../src/never.ts'

describe('assertNever', () => {
  it('throws with the rendered value and a context label', () => {
    expect(() => assertNever('surprise' as never, 'demo')).toThrow(
      /unreachable variant in demo: "surprise"/,
    )
  })

  it('omits the context clause when none is given', () => {
    expect(() => assertNever(7 as never)).toThrow(/unreachable variant: 7$/)
  })

  it('falls back to String() when the value is not JSON-serializable', () => {
    // JSON.stringify(undefined) is undefined, exercising the String() fallback.
    expect(() => assertNever(undefined as never)).toThrow(/unreachable variant: undefined$/)
  })
})
