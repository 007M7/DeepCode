/**
 * In-memory settings provider fixture: the smallest real subclass of the seam,
 * used by the base-class behavior suite in place of a file- or network-backed
 * provider. Kept in `tests/` because production providers live in their own
 * packages.
 */

import { Service } from 'cordis'
import { Settings, type SettingsNamespace } from '../src/index.ts'

/** In-memory provider exposing the protected seam hooks to tests. */
export class MemorySettings extends Settings {
  /** Raw document the provider "storage" currently holds. */
  doc: Record<string, unknown>
  /** Every persist() call observed, in order. */
  persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  /** When false, update() must reject before reaching persist(). */
  writableFlag: boolean

  constructor(ctx: ConstructorParameters<typeof Settings>[0], options?: {
    doc?: Record<string, unknown>
    writable?: boolean
  }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
    this.writableFlag = options?.writable ?? true
  }

  get writable(): boolean {
    return this.writableFlag
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.persisted.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }

  /** Simulate an external storage change reaching the provider. */
  pushExternal(doc: Record<string, unknown>): void {
    this.doc = structuredClone(doc)
    this.publish(structuredClone(doc))
  }

  async* [Service.init](): AsyncGenerator<() => void, void, void> {
    this.publish(await this.load())
    yield () => { this.persisted.length = 0 }
  }
}
