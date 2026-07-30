import { EntryTree, isJsExpr, type EntryOptions } from '@cordisjs/plugin-loader'
import { Context, Service } from 'cordis'
import { extname } from 'node:path'
import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const writable: Record<string, string> = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

const supported = new Set(Object.keys(writable))

/** Runtime patch applied to entries loaded from an included config file. */
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}

/** Config namespace for the file-backed include loader. */
export namespace Include {
  /** Config for a file-backed loader subtree. */
  export interface Config {
    /** YAML or JSON path resolved from `ctx.baseUrl`. */
    path: string
    /** Entry list written when the file does not already exist. */
    initial?: any[]
    /** Runtime patches applied after reading the file. */
    patches?: PatchOptions[]
    /** Enables loader apply/reload/unload logs for this subtree. */
    enableLogs?: boolean
  }
}

/** Loader entry tree backed by a YAML or JSON file. */
export class Include extends EntryTree {
  static inject = ['loader']

  public filename: string
  private type?: string
  private readonly: boolean
  private content?: string
  private data?: EntryOptions[]
  private writeTask?: NodeJS.Timeout

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false
    this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
    const ext = extname(this.filename)
    if (!supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.type = writable[ext]
    this.readonly = !this.type
    this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href

    ctx.on('internal/update', (config, _, next) => {
      if (config.path !== this.config.path) return next()
      // Veto the fiber restart (children update in place), but persist the new
      // config ourselves — `Fiber.update` only assigns `this.config` behind
      // `next()`, and a stale `this.config.patches` would make the next
      // `refresh()` re-apply the old overlay.
      this.config = config
      this.root.update(this.applyPatches(this.data!, config.patches)).catch((error) => {
        this.ctx.logger.warn('config update at %C failed', this.filename)
        this.ctx.logger.warn(error)
      })
    })
  }

  private async checkAccess() {
    if (!this.type) return
    try {
      await access(this.filename, constants.W_OK)
    } catch {
      this.readonly = true
    }
  }

  private async read(forced = false) {
    const content = await readFile(this.filename, 'utf8')
    if (!forced && this.content === content) return false
    let data: any
    if (this.type === 'application/yaml') {
      data = yaml.load(content, { schema })
    } else if (this.type === 'application/json') {
      data = JSON.parse(content)
    } else {
      const module = await import(/* @vite-ignore */ this.filename)
      data = module.default || module
    }
    // An empty or truncated file (common mid-edit: editors and `sed -i` write
    // through temp states) parses to `undefined`, not an error; reject every
    // non-array shape here so callers see one "invalid file" signal. Content
    // and data commit only on success, so an edit that is later reverted to
    // the exact last good content correctly reads as "unchanged".
    if (!Array.isArray(data)) {
      throw new TypeError(`config file must be a top-level array of entries: ${this.filename}`)
    }
    this.content = content
    this.data = data
    await this.checkAccess()
    return true
  }

  private applyPatches(data: EntryOptions[], patches = this.config.patches): EntryOptions[] {
    // Always detach from the cached parse: patching shared entry objects would
    // bake earlier patch values into `this.data`, so repeated application
    // (config hot-reloads) could never revert a removed or changed patch. The
    // supported extensions guarantee JSON-safe plain data, so `structuredClone`
    // cannot throw here.
    if (!patches?.length) return [...data]
    data = structuredClone(data)

    const entryMap = new Map<string, EntryOptions>()
    const buildMap = (entries: EntryOptions[]) => {
      for (const entry of entries) {
        if (entry.id) entryMap.set(entry.id, entry)
        if (entry.group && Array.isArray(entry.config)) {
          buildMap(entry.config)
        }
      }
    }
    buildMap(data)

    for (const patch of patches) {
      const { id, insert, name, ...overrides } = patch

      if (insert) {
        if (id) {
          const target = entryMap.get(id)
          if (!target) {
            this.ctx.root.logger?.('loader').warn('patch insert: entry %C not found', id)
            continue
          }
          if (!target.group) {
            this.ctx.root.logger?.('loader').warn('patch insert: entry %C is not a group', id)
            continue
          }
          if (!Array.isArray(target.config)) target.config = []
          target.config.push(...insert)
        } else {
          data.push(...insert)
        }
        // Index what this patch added so a LATER patch in the same list can
        // target it. Patch lists compose one layer per source (surface overlay,
        // then `--config`, then the user's), and a layer must be able to
        // configure or disable a row an earlier layer inserted; without this,
        // inserted rows were silently unpatchable.
        buildMap(insert)
        continue
      }

      if (!id) {
        this.ctx.root.logger?.('loader').warn('patch: id is required for non-insert patches')
        continue
      }

      const target = entryMap.get(id)
      if (!target) {
        this.ctx.root.logger?.('loader').warn('patch: entry %C not found', id)
        continue
      }

      if (name && name !== target.name) {
        this.ctx.root.logger?.('loader').warn(
          'patch: name mismatch for %C (expected %C, got %C), skipping',
          id, target.name, name,
        )
        continue
      }

      for (const [key, value] of Object.entries(overrides)) {
        if (key === 'id') continue
        target[key] = value
      }
    }

    return data
  }

  async* [Service.init]() {
    try {
      await this.read()
    } catch (error) {
      // Only a missing file falls back to `initial` (or the not-found error):
      // an existing-but-invalid file must fail loud with its real parse error,
      // never be mislabelled as absent or silently overwritten.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      if (this.config.initial) {
        this.writeFile(this.config.initial as any)
        await this.read()
      } else {
        throw new Error(`config file not found: ${this.filename}`)
      }
    }

    yield () => this.stop()
    await this.root.update(this.applyPatches(this.data!))
  }

  stop() {
    this.root.stop()
  }

  /**
   * Re-read the file and refresh child entries when content changed. An
   * unreadable or unparsable file logs a warning and keeps the last good
   * tree: a hot-reload of a live app must never take the process down.
   */
  async refresh() {
    try {
      if (!await this.read()) return
      await this.root.update(this.applyPatches(this.data!))
    } catch (error) {
      this.ctx.logger.warn('config reload at %C failed; keeping the running tree', this.filename)
      this.ctx.logger.warn(error)
    }
  }

  private async _writeFile(config: EntryOptions[]) {
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      this.content = yaml.dump(config, { schema })
    } else if (this.type === 'application/json') {
      this.content = JSON.stringify(config, null, 2)
    }
    await writeFile(this.filename + '.tmp', this.content!)
    await rename(this.filename + '.tmp', this.filename)
  }

  private writeFile(config: EntryOptions[]) {
    clearTimeout(this.writeTask)
    this.writeTask = setTimeout(() => {
      this.writeTask = undefined
      this._writeFile(config)
    }, 0)
  }

  /** Schedule a write of the current root entry data. */
  write() {
    this.context.emit('loader/config-update')
    return this.writeFile(this.root.data)
  }
}

export default Include
