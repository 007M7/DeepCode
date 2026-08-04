/**
 * Creating, reading, and deleting locally authored presets.
 *
 * Authoring is confined to a `user` root: the shipped `.system` set is part of
 * the deployment, and letting a browser rewrite it would turn "reset to a known
 * preset" into something the same caller could have broken first.
 * @module @deepseek-ai/dsh-agent-presets/authoring
 */

import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@cordisjs/plugin-include'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { expandHomePath } from '@deepseek-ai/dsh-paths'
import { COMPOSITION_FILE } from './discovery.ts'
import type { AgentPreset, PresetRoot } from './types.ts'

/**
 * Ids a preset directory may use.
 *
 * The id becomes a path segment, so this is a containment boundary rather than
 * a style rule: `..`, a separator, or an absolute-looking name would place the
 * composition outside the root the deployment authorised.
 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** A preset id that cannot be used as a directory name under a root. */
export class InvalidPresetIdError extends Error {
  constructor(
    /** The rejected id. */
    readonly presetId: string,
  ) {
    super(
      `agent-presets: preset id ${JSON.stringify(presetId)} must match ${String(PRESET_ID)} — `
      + 'the id is a directory name, so anything else could escape the preset root',
    )
  }
}

/** A composition that is not a usable entry list. */
export class InvalidCompositionError extends Error {
  constructor(
    /** Why the text cannot be a composition. */
    readonly reason: string,
  ) {
    super(`agent-presets: composition is not a valid entry list: ${reason}`)
  }
}

/** Authoring was attempted where the deployment allows none. */
export class PresetNotWritableError extends Error {
  constructor(
    /** What the caller tried to change, for the diagnostic. */
    readonly presetId: string,
    reason: string,
  ) {
    super(`agent-presets: preset "${presetId}" cannot be written: ${reason}`)
  }
}

/**
 * The root locally authored presets are written to.
 * @param roots - the configured roots in precedence order.
 * @returns the absolute path of the first `user` root.
 * @throws when the deployment configured no writable root.
 */
export function writableRoot(roots: readonly PresetRoot[]): string {
  const root = roots.find(candidate => candidate.trust === 'user')
  if (root === undefined) {
    throw new PresetNotWritableError('', 'this deployment configures no user-writable preset root')
  }
  return resolve(expandHomePath(root.path))
}

/**
 * Validate one composition's text without mounting it.
 *
 * This is the shape check the Include performs when it reads a file — a
 * top-level list of entries. It cannot prove the composition mounts (that
 * needs the plugins), so it is a guard against saving something no session
 * could ever load, not a substitute for trying it.
 * @param content - the YAML text.
 * @throws when the text does not parse or is not a top-level array.
 */
export function assertComposition(content: string): void {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    /* v8 ignore next -- js-yaml rejects with a YAMLException, which is an Error; the
       fallback keeps a hostile throw readable rather than printing `undefined`. */
    throw new InvalidCompositionError(error instanceof Error ? error.message : String(error))
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidCompositionError('a composition must be a top-level list of plugin rows')
  }
}

/**
 * Read one preset's composition text.
 * @param preset - the resolved preset.
 * @returns the file's contents.
 */
export async function readComposition(preset: AgentPreset): Promise<string> {
  return await readFile(preset.path, 'utf8')
}

/**
 * Create or replace a locally authored preset.
 * @param roots - the configured roots; the first `user` one receives the write.
 * @param id - the preset id, which becomes its directory name.
 * @param content - the composition text.
 * @returns the absolute path written.
 * @throws when the id is unusable, the content is not an entry list, or the
 * deployment has no writable root.
 */
export async function writeComposition(
  roots: readonly PresetRoot[],
  id: string,
  content: string,
): Promise<string> {
  if (!PRESET_ID.test(id)) throw new InvalidPresetIdError(id)
  assertComposition(content)
  const dir = join(writableRoot(roots), id)
  const path = join(dir, COMPOSITION_FILE)
  // Owner-only: a composition names the plugins a session runs, so it carries
  // the same weight as the settings document beside it.
  await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
  return path
}

/**
 * Delete a locally authored preset.
 *
 * A shipped preset is refused: it belongs to the deployment. A preset a live
 * session mounted is NOT refused — the composition was read at creation and is
 * never re-read, so that session keeps running exactly as it was.
 * @param roots - the configured roots.
 * @param preset - the resolved preset to remove.
 * @throws when the preset ships with the deployment or lies outside the writable root.
 */
export async function deleteComposition(
  roots: readonly PresetRoot[],
  preset: AgentPreset,
): Promise<void> {
  if (preset.trust !== 'user') {
    throw new PresetNotWritableError(preset.id, 'it ships with the deployment')
  }
  const dir = join(writableRoot(roots), preset.id)
  // Belt and braces over the id pattern: the resolved directory must still be
  // the one the writable root owns, whatever discovery reported.
  if (!isAbsolute(preset.path) || !preset.path.startsWith(dir)) {
    throw new PresetNotWritableError(preset.id, 'it does not live under the writable preset root')
  }
  await rm(dir, { recursive: true, force: true })
}
