/**
 * Filesystem discovery of agent presets. A preset is a directory holding
 * {@link COMPOSITION_FILE}, optionally beside a {@link METADATA_FILE} carrying
 * its display text; the directory name is the preset id. Discovery
 * re-reads the roots on every call so a preset authored while the process is
 * running is visible without a restart.
 * @module @deepseek-ai/dsh-agent-presets/discovery
 */

import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-paths'
import { readPresetMetadata } from './metadata.ts'
import type { AgentPreset, PresetRoot } from './types.ts'

/** The composition file that makes a directory a preset. */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/**
 * Whether `path` names an existing regular file.
 * @param path - absolute path to test.
 * @returns true when the path resolves to a file.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // Any stat failure — absent, unreadable, a dangling link — means this
    // directory does not present a composition, which is not an error: the
    // directory simply is not a preset.
    return false
  }
}

/**
 * Scan one root for preset directories.
 *
 * An absent root yields no presets rather than throwing: the user root does
 * not exist until the first locally authored preset, and naming a default
 * that no root supplies already fails loud at resolution.
 * @param root - the directory and the trust its presets inherit.
 * @returns the root's presets ordered by id.
 */
export async function scanRoot(root: PresetRoot): Promise<AgentPreset[]> {
  const dir = resolve(expandHomePath(root.path))
  let children
  try {
    children = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`agent-presets: cannot read preset root ${dir}: ${String(error)}`, { cause: error })
  }
  const found: AgentPreset[] = []
  for (const child of children) {
    if (!child.isDirectory()) continue
    const directory = join(dir, child.name)
    const path = join(directory, COMPOSITION_FILE)
    if (!await isFile(path)) continue
    // Display text only, and never fatal: a preset with unreadable metadata
    // still mounts, it just shows its id.
    const metadata = await readPresetMetadata(directory)
    found.push({ id: child.name, trust: root.trust, path, ...metadata })
  }
  return found.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Scan every root in precedence order.
 * @param roots - roots in precedence order; an earlier root wins a duplicate id.
 * @returns every discovered preset, first-root-wins per id.
 */
export async function discoverPresets(roots: readonly PresetRoot[]): Promise<AgentPreset[]> {
  const byId = new Map<string, AgentPreset>()
  for (const root of roots) {
    for (const preset of await scanRoot(root)) {
      if (byId.has(preset.id)) continue
      byId.set(preset.id, preset)
    }
  }
  return [...byId.values()]
}
