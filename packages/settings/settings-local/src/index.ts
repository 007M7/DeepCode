/**
 * File-backed settings provider. One YAML or JSON document under the user's
 * harness home carries every namespace section; external edits hot-publish
 * through the seam and `update()` writes back preserving the user's comments.
 * @module @deepseek-ai/dsh-settings-local
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import { Settings, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Settings document path; defaults to `settings.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/** Document format derived from the configured file extension. */
type SettingsFormat = 'yaml' | 'json'

const FORMATS: Record<string, SettingsFormat> = {
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  filename: string
  format: SettingsFormat
  watch: boolean
  debounceMs: number
}

/**
 * Resolve the runtime spec from plugin config: an explicit `path` wins,
 * otherwise the document lives at `<harness home>/settings.yaml`.
 * @param config - raw plugin config.
 * @returns the resolved file location, format, and watch behavior.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), 'settings.yaml'))
  const format = FORMATS[extname(filename)]
  if (format === undefined) {
    throw new Error(`settings-local: extension "${extname(filename)}" is not supported (use .yaml, .yml, or .json)`)
  }
  return {
    filename,
    format,
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** File-backed settings provider (`settings.yaml`/`.json`). */
export class SettingsLocal extends Settings {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  /**
   * Raw text of the last successfully parsed or persisted document;
   * `undefined` while the file is absent. Watcher events whose content equals
   * this cache are no-ops, which is also the self-write suppression.
   */
  private text: string | undefined
  /** Serializes watcher-triggered reloads so reads never interleave. */
  private refreshTask: Promise<void> = Promise.resolve()
  /** Set at dispose: refuse new watcher events and let in-flight work no-op. */
  private closed = false

  /** Opaque read of {@link closed}: control flow cannot narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed
  }

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  /** The local document is always writable through {@link Settings.update}. */
  get writable(): boolean {
    return true
  }

  protected async load(): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.text = undefined
      return {}
    }
    const doc = this.parse(text)
    this.text = text
    return doc
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    const output = this.spec.format === 'yaml'
      ? this.renderYaml(ns, section)
      : this.renderJson(ns, section)
    await mkdir(dirname(this.spec.filename), { recursive: true })
    // Exclusive-create (`wx`) a random-suffix sibling: the open refuses to
    // follow any planted symlink at a guessable temp path, and the fresh inode
    // carries owner-only permissions that survive the rename — a document that
    // may hold personal values is never world-readable and never a symlink.
    const temp = `${this.spec.filename}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temp, output, { mode: 0o600, flag: 'wx' })
      await rename(temp, this.spec.filename)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    this.text = output
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // The base init loads and publishes; a parse failure there is a boot
    // failure: an existing-but-invalid document must fail loud, never be
    // silently ignored or overwritten.
    yield* super[Service.init]()
    if (!this.spec.watch) return
    const watcher = chokidarWatch(this.spec.filename, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.spec.debounceMs,
        pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
      },
    })
    watcher.on('all', () => {
      if (this.closed) return
      this.refreshTask = this.refreshTask.then(() => this.refresh()).catch((error: unknown) => {
        // Only an invariant violation escaping the commit path can reject a
        // refresh; keep the reload queue alive and surface it as an error so
        // one poisoned commit cannot silently end hot reloading forever.
        this.ctx.logger.error('settings-local: reload commit failed at %s', this.spec.filename)
        this.ctx.logger.error(error)
      })
    })
    watcher.on('error', (error) => {
      this.ctx.logger.warn('settings-local: watcher error on %s', this.spec.filename)
      this.ctx.logger.warn(error)
    })
    yield async () => {
      // Quiesce: stop accepting events, close the watcher, then wait out any
      // queued or in-flight refresh so nothing publishes after disposal.
      this.closed = true
      await watcher.close()
      await this.refreshTask
    }
  }

  /** Parse one document text into raw sections, failing on a non-map root. */
  private parse(text: string): Record<string, unknown> {
    let root: unknown
    if (this.spec.format === 'yaml') {
      const document = parseDocument(text, { prettyErrors: true })
      if (document.errors.length > 0) {
        throw new Error(`settings-local: invalid document at ${this.spec.filename}: ${
          document.errors.map(error => error.message).join('; ')}`)
      }
      root = document.toJS() ?? {}
    } else {
      root = text.trim().length === 0 ? {} : JSON.parse(text)
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new TypeError(`settings-local: ${this.spec.filename} must be a map of namespace sections`)
    }
    return root as Record<string, unknown>
  }

  /**
   * Re-read the document after a watcher event. Unchanged content (including
   * this provider's own writes) is a no-op; an unreadable or unparsable
   * document keeps the last good sections and warns — a live hot-reload must
   * never take the process down.
   */
  private async refresh(): Promise<void> {
    if (this.closed) return
    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) {
        this.ctx.logger.warn('settings-local: reload failed at %s; keeping the last good document', this.spec.filename)
        this.ctx.logger.warn(error)
        return
      }
      if (this.text === undefined || this.isClosed()) return
      this.text = undefined
      this.publish({})
      return
    }
    if (text === this.text || this.isClosed()) return
    let doc: Record<string, unknown>
    try {
      doc = this.parse(text)
    } catch (error) {
      this.ctx.logger.warn('settings-local: reload failed at %s; keeping the last good document', this.spec.filename)
      this.ctx.logger.warn(error)
      return
    }
    this.text = text
    this.publish(doc)
  }

  /** Render the next YAML text by patching one namespace in the comment-preserving document. */
  private renderYaml(ns: SettingsNamespace, section: Record<string, unknown>): string {
    if (this.text === undefined) {
      return new Document({ [ns]: section }).toString()
    }
    // this.text only ever caches content that parsed successfully, so this
    // re-parse (for the mutable comment-preserving tree) cannot fail.
    const document = parseDocument(this.text)
    document.set(ns, section)
    return document.toString()
  }

  /** Render the next JSON text by replacing one namespace key. */
  private renderJson(ns: SettingsNamespace, section: Record<string, unknown>): string {
    const root = this.text === undefined
      ? {}
      : this.parse(this.text)
    root[ns] = section
    return `${JSON.stringify(root, null, 2)}\n`
  }
}

export default SettingsLocal
