/**
 * Read-only credential provider layering the live process environment over a
 * `$DSH_HOME/.env` document read on demand.
 * @module @deepseek-ai/dsh-credentials-local
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'dotenv'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import { Credentials } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Plugin config: the optional credential document location. */
export interface Config {
  /** Credentials document path; defaults to `.env` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Fully resolved provider parameters. */
interface ResolvedSpec {
  filename: string
}

/**
 * Resolve the runtime spec from plugin config.
 * @param config - raw plugin config.
 * @returns the absolute credential document path.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return { filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), '.env')) }
}

/** Whether a filesystem error means absence; every non-ENOENT failure surfaces. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** File-backed credentials provider (`$DSH_HOME/.env`). */
export class CredentialsLocal extends Credentials {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
  })

  private readonly spec: ResolvedSpec

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.spec = resolveSpec(config)
  }

  override async resolve(ref: CredentialRef): Promise<string | undefined> {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return ambient

    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
    const stored = parse(text)[ref]
    return stored === undefined || stored.length === 0 ? undefined : stored
  }
}

export default CredentialsLocal
