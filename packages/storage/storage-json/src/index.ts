/**
 * JSON storage backend: one human-readable file per unit under a configured
 * root, published by atomic whole-file rewrite. Registers as backend `json`
 * on the storage hub.
 * @module @deepseek-ai/dsh-storage-json
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import z from 'schemastery'
import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { openJsonUnit } from './unit.ts'

/** Cordis plugin name. */
export const name = 'storage-json'
/** The hub must exist before the backend can register. */
export const inject = ['storage']

/**
 * Plugin configuration.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export interface Config {
  /** Directory holding one `<unit>.json` file per unit. */
  root: string
}

/** Config schema. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/** JSON backend: owns the file-tree root and serves the `kv` facet. */
export class JsonStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  private closed = false

  constructor(private readonly root: string) {}

  readonly kv: KvFacet = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'json backend is closed')
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name)) {
        throw new StorageError(
          'malformed-medium',
          `unit '${descriptor.name}' is already open; a unit has exactly one live handle`,
        )
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const path = join(this.root, `${descriptor.name}.json`)
      const unit = await openJsonUnit(descriptor, path, () => this.open.delete(descriptor.name))
      this.open.set(descriptor.name, unit)
      return unit
    },
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * Register the `json` backend on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  const backend = new JsonStorageBackend(config.root)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('json', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
}
