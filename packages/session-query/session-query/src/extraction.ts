/** Semantic text extraction and stable provider snapshot fingerprints. */

import { createHash } from 'node:crypto'
import type { Context } from 'cordis'
import type { ContentBlock, ContentBlockMap, ContentBlockType } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session'
import type {
  SessionContentTextExtractor,
  SessionEventTextExtractor,
  SessionIndexDocument,
  SessionIndexSnapshot,
  SessionRecord,
} from './types.ts'
import { SessionQueryError } from './config.ts'
import { eventRecords } from './tracing.ts'

/** Canonical session source consumed by extraction and provider reconciliation. */
export interface LoadedSession {
  /** Logical source metadata. */
  record: SessionRecord
  /** Detached canonical events. */
  events: SessionEvent[]
}

interface StoredEventExtractor {
  version: string
  extract(event: SessionEvent): readonly string[]
}

interface StoredContentExtractor {
  version: string
  extract(block: ContentBlock): readonly string[]
}

/** Owns core/custom semantic extractors and builds versioned index snapshots. */
export class SessionTextExtractors {
  private readonly _eventExtractors = new Map<SessionEventType, StoredEventExtractor>()
  private readonly _contentExtractors = new Map<ContentBlockType, StoredContentExtractor>()

  constructor(private readonly _onChange: () => void) {
    this._installCoreExtractors()
  }

  /**
   * Register one effect-scoped event extractor.
   * @param ctx - contributing caller context.
   * @param type - event discriminant.
   * @param extractor - versioned semantic extractor.
   * @returns disposer for the registration.
   */
  registerEvent<K extends SessionEventType>(
    ctx: Context,
    type: K,
    extractor: SessionEventTextExtractor<K>,
  ): () => void {
    this._validateVersion(type, extractor.version)
    if (this._eventExtractors.has(type)) {
      throw new SessionQueryError(`session event text extractor "${type}" is already registered`, 'SESSION_QUERY_DUPLICATE_EXTRACTOR')
    }
    const stored: StoredEventExtractor = {
      version: extractor.version,
      extract: event => extractor.extract(event as SessionEvent<K>),
    }
    const dispose = ctx.effect(function* (this: SessionTextExtractors) {
      this._eventExtractors.set(type, stored)
      this._onChange()
      yield () => {
        this._eventExtractors.delete(type)
        this._onChange()
      }
    }.bind(this), `sessionQuery.eventExtractor(${type})`)
    return () => void dispose()
  }

  /**
   * Register one effect-scoped content-block extractor.
   * @param ctx - contributing caller context.
   * @param type - content-block discriminant.
   * @param extractor - versioned semantic extractor.
   * @returns disposer for the registration.
   */
  registerContent<K extends ContentBlockType>(
    ctx: Context,
    type: K,
    extractor: SessionContentTextExtractor<K>,
  ): () => void {
    this._validateVersion(type, extractor.version)
    if (this._contentExtractors.has(type)) {
      throw new SessionQueryError(`session content text extractor "${type}" is already registered`, 'SESSION_QUERY_DUPLICATE_EXTRACTOR')
    }
    const stored: StoredContentExtractor = {
      version: extractor.version,
      extract: block => extractor.extract(block as ContentBlockMap[K]),
    }
    const dispose = ctx.effect(function* (this: SessionTextExtractors) {
      this._contentExtractors.set(type, stored)
      this._onChange()
      yield () => {
        this._contentExtractors.delete(type)
        this._onChange()
      }
    }.bind(this), `sessionQuery.contentExtractor(${type})`)
    return () => void dispose()
  }

  /**
   * Build one provider-neutral snapshot and SHA-256 source/version fingerprint.
   * @param loaded - detached canonical source.
   * @returns lightweight documents and stable fingerprint.
   */
  buildSnapshot(loaded: LoadedSession): SessionIndexSnapshot {
    const records = eventRecords(loaded.record.header.id, loaded.events)
    const documents: SessionIndexDocument[] = []
    const eventVersions = new Set<string>()
    const blockVersions = new Set<string>()
    for (const event of loaded.events) {
      const extractor = this._eventExtractors.get(event.type)
      if (extractor === undefined) continue
      eventVersions.add(`${event.type}@${extractor.version}`)
      collectBlockVersions(event.data, this._contentExtractors, blockVersions)
      const text = normalizeText(extractor.extract(event))
      if (text.length === 0) continue
      // The event record array parallels the contiguous log.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      documents.push({ ...records[event.seq]!, text })
    }
    const fingerprint = createHash('sha256').update(canonicalJson({
      header: loaded.record.header,
      events: loaded.events,
      eventExtractors: [...eventVersions].sort(),
      contentExtractors: [...blockVersions].sort(),
    })).digest('hex')
    return {
      session: cloneRecord(loaded.record),
      fingerprint,
      documents,
    }
  }

  private _installCoreExtractors(): void {
    this._contentExtractors.set('text', { version: '1', extract: block => [(block as ContentBlockMap['text']).text] })
    this._contentExtractors.set('reasoning', { version: '1', extract: block => [(block as ContentBlockMap['reasoning']).text] })
    this._contentExtractors.set('tool-call', {
      version: '1',
      extract: (block) => {
        const call = block as ContentBlockMap['tool-call']
        return [call.name, call.arguments]
      },
    })
    this._contentExtractors.set('tool-result', {
      version: '1',
      extract: block => this._extractBlocks((block as ContentBlockMap['tool-result']).content),
    })
    for (const type of ['user/message', 'assistant/message', 'context/message', 'steering/message'] as const) {
      this._eventExtractors.set(type, {
        version: '1',
        extract: event => this._extractBlocks((event as SessionEvent<typeof type>).data.content),
      })
    }
    this._eventExtractors.set('prompt/blocked', {
      version: '1',
      extract: (event) => {
        const data = (event as SessionEvent<'prompt/blocked'>).data
        return [...this._extractBlocks(data.content), data.reason]
      },
    })
    this._eventExtractors.set('tool/call', {
      version: '1',
      extract: (event) => {
        const data = (event as SessionEvent<'tool/call'>).data
        return [data.name, data.arguments]
      },
    })
    this._eventExtractors.set('tool/result', {
      version: '1',
      extract: (event) => {
        const data = (event as SessionEvent<'tool/result'>).data
        return [...this._extractBlocks(data.content), data.error?.name ?? '', data.error?.code ?? '']
      },
    })
    this._eventExtractors.set('todo/write', {
      version: '1',
      extract: event => (event as SessionEvent<'todo/write'>).data.todos.map(todo => `${todo.status} ${todo.content}`),
    })
    this._eventExtractors.set('turn/end', {
      version: '1',
      extract: (event) => {
        const reason = (event as SessionEvent<'turn/end'>).data.reason
        switch (reason.kind) {
          case 'error': return ['error', reason.message, reason.code ?? '']
          case 'aborted': return ['aborted', reason.reason ?? '']
          case 'rejected': return ['rejected', reason.reason]
          case 'disposed': return ['disposed']
          case 'max-tokens': return ['max-tokens']
          case 'interrupted': return ['interrupted']
          case 'completed': return []
          // TurnEndReasonMap is merge-extensible; unknown variants contribute no text.
          /* v8 ignore next -- only an external declaration-merged reason can reach this fallback */
          default: return []
        }
      },
    })
  }

  private _extractBlocks(blocks: readonly ContentBlock[]): string[] {
    const fragments: string[] = []
    for (const block of blocks) {
      const extractor = this._contentExtractors.get(block.type)
      if (extractor !== undefined) fragments.push(...extractor.extract(block))
    }
    return fragments
  }

  private _validateVersion(type: string, version: string): void {
    if (version.trim().length === 0) {
      throw new SessionQueryError(`session-query extractor "${type}" requires a non-blank version`, 'SESSION_QUERY_INVALID_EXTRACTOR')
    }
  }
}

/**
 * Encode canonical JSON with recursively sorted object keys.
 * @param value - JSON-compatible source value.
 * @returns deterministic JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

function normalizeText(fragments: readonly string[]): string {
  return fragments.map(fragment => fragment.trim()).filter(Boolean).join('\n')
}

function collectBlockVersions(
  value: unknown,
  extractors: ReadonlyMap<ContentBlockType, StoredContentExtractor>,
  versions: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBlockVersions(item, extractors, versions)
    return
  }
  if (value === null || typeof value !== 'object') return
  const object = value as Record<string, unknown>
  if (typeof object.type === 'string') {
    const type = object.type as ContentBlockType
    const extractor = extractors.get(type)
    if (extractor !== undefined) versions.add(`${type}@${extractor.version}`)
  }
  for (const nested of Object.values(object)) collectBlockVersions(nested, extractors, versions)
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record, header: structuredClone(record.header) }
}
