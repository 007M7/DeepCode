/**
 * Read-only credential seam (`ctx.credentials`). Configuration carries
 * branded references to secrets; providers resolve their current values.
 * @module @deepseek-ai/dsh-credentials
 */

import { Context, Service } from 'cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Nominal reference to one credential: a POSIX-style environment-variable name. */
export type CredentialRef = Branded<'CredentialRef'>

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 */
export function credentialRef(value: string): CredentialRef {
  if (!REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value as CredentialRef
}

declare module 'cordis' {
  interface Context {
    credentials: Credentials
  }
}

/** Abstract read-only credential service. */
export abstract class Credentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Resolve one reference to its current non-empty value. Consumers call once
   * per operation and do not cache across operations.
   * @param ref - the reference to resolve.
   * @returns the current value, or `undefined` while unconfigured.
   */
  abstract resolve(ref: CredentialRef): Promise<string | undefined>
}

export default Credentials
