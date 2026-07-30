import type { Context } from 'cordis'
import { Credentials } from '../src/index.ts'
import type { CredentialRef } from '../src/index.ts'

/** In-memory read-only credentials provider for seam tests. */
export class MemoryCredentials extends Credentials {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<string | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0 ? undefined : value)
  }
}
