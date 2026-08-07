/**
 * The launch-time environment as one immutable snapshot that remembers which
 * layer supplied each value. The harness resolves user-facing values against
 * this rather than against `process.env`, because the layers differ in how
 * much they are trusted: an inherited variable is this run's explicit intent,
 * a file discovered under the invoking directory is whatever the project
 * happens to contain, and a consumer that cannot tell them apart cannot make
 * that distinction.
 *
 * Values still reach `process.env` as well — a user's own `--config` tree and
 * third-party libraries read it — but that flattened view is not the
 * authority for anything the harness itself resolves.
 * @module @deepseek-ai/dsh-environment
 */

import type { Context } from 'cordis'

/**
 * Which layer supplied a value, from most to least trusted: the environment
 * this process inherited, the invoking directory's `.env`, the Harness home's
 * `.env`.
 */
export type EnvironmentSource = 'process' | 'project-env' | 'user-env'

/** Layer order, most trusted first. */
const SOURCE_ORDER: readonly EnvironmentSource[] = ['process', 'project-env', 'user-env']

/** One resolved variable and the layer it came from. */
export interface EnvironmentEntry {
  /** The value as the layer supplied it; may be empty, which each owner judges for itself. */
  value: string
  /** The layer that supplied it. */
  source: EnvironmentSource
  /** Absolute path of the file that supplied it; absent for `process`. */
  path?: string
}

/**
 * The frozen environment of one launch. Construct through
 * {@link createEnvironmentSnapshot}; nothing mutates it afterwards, so a
 * later `chdir`, workspace switch, or resumed session observes the same
 * values a consumer resolved at boot.
 */
export interface EnvironmentSnapshot {
  /**
   * Resolve one name across every layer, most trusted first.
   * @param name - the variable name.
   * @returns the winning entry, or `undefined` when no layer supplies it.
   */
  get(name: string): EnvironmentEntry | undefined
  /**
   * Resolve one name across only the layers the caller trusts for this
   * decision. Omitting a layer is a refusal, not a demotion: a routing field
   * that must never come from a project directory omits `project-env` so no
   * ordering change can let it back in.
   * @param name - the variable name.
   * @param sources - the layers allowed in the canonical trust order.
   * @returns the first matching entry, or `undefined`.
   */
  getFrom(name: string, sources: readonly EnvironmentSource[]): EnvironmentEntry | undefined
}

/**
 * The map key one variable name resolves under. Windows treats environment
 * names case-insensitively; every other platform does not.
 * @param name - the variable name as written.
 * @returns the key to store and look up by.
 */
function lookupKey(name: string): string {
  /* v8 ignore next -- native Windows coverage exercises the folding arm; POSIX covers the exact one */
  return process.platform === 'win32' ? name.toUpperCase() : name
}

/** One layer's raw contents, as {@link createEnvironmentSnapshot} receives them. */
export interface EnvironmentLayerInput {
  source: EnvironmentSource
  /** Absolute path of the file behind this layer; omit for `process`. */
  path?: string
  values: Readonly<Record<string, string>>
}

/**
 * Build the snapshot from each layer's contents.
 * @param layers - the layers in any order; the result searches them by canonical trust order.
 * @returns the immutable snapshot.
 */
export function createEnvironmentSnapshot(layers: readonly EnvironmentLayerInput[]): EnvironmentSnapshot {
  // Copied per layer so a later mutation of `process.env` — or of a caller's
  // own object — cannot change what this snapshot reports. Windows environment
  // names are case-insensitive, so lookups there fold case: otherwise a shell
  // that set `deepseek_api_key` would be invisible to a consumer asking for
  // `DEEPSEEK_API_KEY`, and a lower-ranked layer spelling it in caps would win
  // a decision the launch had already made. POSIX names are case-sensitive and
  // must stay exact.
  const bySource = new Map<EnvironmentSource, { path?: string; values: Map<string, string> }>()
  for (const layer of layers) {
    bySource.set(layer.source, {
      ...layer.path === undefined ? {} : { path: layer.path },
      values: new Map(Object.entries(layer.values).map(([name, value]) => [lookupKey(name), value])),
    })
  }
  const getFrom = (name: string, sources: readonly EnvironmentSource[]): EnvironmentEntry | undefined => {
    const key = lookupKey(name)
    for (const source of SOURCE_ORDER) {
      if (!sources.includes(source)) continue
      const layer = bySource.get(source)
      const value = layer?.values.get(key)
      if (value === undefined) continue
      return { value, source, ...layer?.path === undefined ? {} : { path: layer.path } }
    }
    return undefined
  }
  return {
    get: name => getFrom(name, SOURCE_ORDER),
    getFrom,
  }
}

/** Context slot the launcher fills with this run's snapshot before any config entry mounts. */
export const DSH_ENVIRONMENT_KEY = 'launcherEnvironment'

/**
 * The snapshot to resolve against, whatever booted this tree: the launcher's
 * when the product CLI provided one, otherwise the inherited environment
 * alone.
 *
 * The fallback does not weaken the layer rules — it applies the same rules to
 * a host that has exactly one layer. An SDK embedder or a bare `cordis.yml`
 * never discovered a project or user file, so everything it has really is the
 * environment it was launched with, and `getFrom(..., ['process'])` is exactly
 * right for it.
 * @param ctx - the consuming plugin's context.
 * @returns the snapshot to resolve user-facing values against.
 */
export function environmentOf(ctx: Context): EnvironmentSnapshot {
  return ctx.get(DSH_ENVIRONMENT_KEY)
    ?? createEnvironmentSnapshot([{ source: 'process', values: process.env as Record<string, string> }])
}

declare module 'cordis' {
  interface Context {
    /** Launcher-owned snapshot of this run's environment; absent in compositions the product CLI did not boot. */
    launcherEnvironment?: EnvironmentSnapshot
  }
}
