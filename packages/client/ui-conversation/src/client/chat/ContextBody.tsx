// Expanded bodies for the context disclosure, one per durable context form.
// The producer declares the form; this module only chooses a presentation for
// it. Every form falls back to OpaqueBody, which is the documented default for
// an absent, unknown, or malformed form — a resumed or foreign log must render
// even when this UI version has never seen its producer.

import type { ReactNode } from 'react'
import type { ContextMessageNode, KnownContextForm } from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ContextBody.module.css'

/** Model-facing text stays bounded at the disclosure, not at the producer. */
const MAX_CHARS = 20_000

type Translate = ChatViewSlotProps['t']

/** One durable source narrowed to the readable-record shape; null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Concatenated text of the content blocks, with the non-text blocks kept aside.
 * Context is text in practice (every producer injects one text block), but the
 * block union is merge-extensible, so an unknown block keeps its own fallback
 * rather than vanishing.
 *
 * Blocks join with no separator, matching how provider adapters flatten them:
 * inserting a line break here would show the reader a line the model never saw.
 */
function partitionContent(content: ContextMessageNode['content']): { text: string; rest: unknown[] } {
  const texts: string[] = []
  const rest: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push(block.text)
    else rest.push(block)
  }
  return { text: texts.join(''), rest }
}

/** The model-facing text, truncated to the display bound. */
function boundedText(text: string, t: Translate): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n${t('json.truncated', { total: text.length })}`
    : text
}

/**
 * One source field rendered as a value row; nested shapes stay compact JSON.
 * Bounded on its own, because provenance is as unbounded as the text: an unknown
 * producer may record an arbitrarily large string or array.
 */
function fieldValue(value: unknown, t: Translate): string {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  return boundedText(text, t)
}

/**
 * Provenance fields as a key/value list. `kind` is omitted because the row
 * header already names the producer, and `form` because the presentation the
 * reader is looking at IS that value.
 */
function SourceFields({ source, t }: { source: unknown; t: Translate }): ReactNode {
  const record = asRecord(source)
  if (record === null) return null
  const rows = Object.entries(record).filter(([key]) => key !== 'kind' && key !== 'form')
  if (rows.length === 0) return null
  return (
    <dl className={css.fields} data-context-fields>
      {rows.map(([key, value]) => (
        <div key={key} className={css.field}>
          <dt className={css.fieldKey}>{key}</dt>
          <dd className={css.fieldValue}>{fieldValue(value, t)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The model-facing content of one context, shared by every form that shows it:
 * the text with its real line breaks, then any block this UI version does not
 * know, which keeps its own fallback rather than vanishing.
 * @param props - Durable content and the locale seat.
 * @returns The content blocks as the model received them.
 */
function ModelFacingContent({ content, t }: {
  content: ContextMessageNode['content']
  t: Translate
}): ReactNode {
  const { text, rest } = partitionContent(content)
  return (
    <>
      {text !== '' && <pre className={css.text} data-context-text>{boundedText(text, t)}</pre>}
      {rest.map((block, index) => (
        <JsonBlock
          key={index}
          label={t('message.unknownBlock')}
          payload={block}
          truncatedLabel={total => t('json.truncated', { total })}
        />
      ))}
    </>
  )
}

/**
 * Default presentation: the model-facing text as text, with its real line
 * breaks, and the remaining provenance beneath it. This is what every form
 * this UI version does not recognize renders as.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The opaque context body.
 */
export function OpaqueBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  return (
    <>
      <ModelFacingContent content={content} t={t} />
      <SourceFields source={source} t={t} />
    </>
  )
}

/** One reconciled instruction file, as the durable source records it. */
interface InstructionChange {
  action: string
  path: string
  digest?: string
}

/**
 * Instruction changes read off the source, or null when the record is not a
 * usable instruction list.
 *
 * The read is all-or-nothing: silently dropping one unreadable entry would show
 * a confident, incomplete file list for a log this version cannot fully read.
 * Paths are deduplicated in first-seen order, matching how the header label is
 * derived from the same array.
 */
function instructionChanges(source: unknown): InstructionChange[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['changes']
  if (!Array.isArray(list)) return null
  const changes: InstructionChange[] = []
  const seen = new Set<string>()
  for (const entry of list as readonly unknown[]) {
    const change = asRecord(entry)
    if (change === null) return null
    const path = change['path']
    if (typeof path !== 'string' || path === '') return null
    const action = change['action']
    const digest = change['digest']
    if (seen.has(path)) continue
    seen.add(path)
    changes.push({
      action: typeof action === 'string' ? action : '',
      path,
      ...typeof digest === 'string' ? { digest } : {},
    })
  }
  return changes.length === 0 ? null : changes
}

/**
 * `instructions` form: the files this context reconciled, then their text.
 *
 * The text keeps its `<system-reminder>` framing verbatim — the framing is part
 * of what the model read, so hiding it would misreport the request.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The instructions context body, or the opaque body when the change
 * list is unreadable.
 */
export function InstructionsBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const changes = instructionChanges(source)
  if (changes === null) return <OpaqueBody content={content} source={source} t={t} />
  const baseline = asRecord(source)?.['baseline'] === true
  return (
    <>
      <ul className={css.files} data-context-files>
        {changes.map(change => (
          <li key={change.path} className={css.file} title={change.digest}>
            <span className={css.filePath}>{change.path}</span>
            <span className={css.fileAction}>
              {t(`message.context.instructions.${change.action === 'remove' ? 'removed' : baseline ? 'loaded' : 'updated'}`)}
            </span>
          </li>
        ))}
      </ul>
      <ModelFacingContent content={content} t={t} />
    </>
  )
}

/** One catalog entry, as the durable source records it. */
interface CatalogEntry {
  name: string
  description: string
}

/**
 * Catalog entries read off the source, or null when the record is not a usable
 * catalog. All-or-nothing for the same reason as the instruction list: this body
 * replaces the model-facing text, so a partial list would hide the only complete
 * account of what the model read.
 */
function catalogEntries(source: unknown): CatalogEntry[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['entries']
  if (!Array.isArray(list)) return null
  const entries: CatalogEntry[] = []
  for (const item of list as readonly unknown[]) {
    const entry = asRecord(item)
    if (entry === null) return null
    const name = entry['name']
    const description = entry['description']
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return null
    entries.push({ name, description })
  }
  return entries.length === 0 ? null : entries
}

/**
 * `catalog` form: the published entries as a list, read from the source rather
 * than re-parsed out of the model-facing prose.
 *
 * A catalog whose source carries no usable entries falls through to the opaque
 * body, so an older or hand-edited log still shows its text.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The catalog context body, or the opaque body when the entry list is
 * unreadable.
 */
export function CatalogBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const entries = catalogEntries(source)
  if (entries === null) return <OpaqueBody content={content} source={source} t={t} />
  const update = asRecord(source)?.['update'] === true
  return (
    <>
      {update && <p className={css.catalogNotice} data-context-catalog-update>{t('message.context.catalog.replaced')}</p>}
      <ul className={css.entries} data-context-entries>
        {entries.map((entry, index) => (
          // Index key: a hand-edited or foreign log may repeat a name, and a
          // duplicate React key would drop a row the model did see.
          <li key={index} className={css.entry}>
            <code className={css.entryName}>{entry.name}</code>
            <span className={css.entryDescription}>{entry.description}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Choose the body for one context node.
 *
 * Returns the form the body actually rendered as, which is not always the
 * declared one: a declared form whose fields are unreadable falls back to
 * opaque, and the caller labels the row with what it really shows.
 * @param form - the producer-declared form projected onto the node.
 * @param props - durable content, its source, and the locale seat.
 * @returns the rendered form (null for opaque) and its body.
 */
export function contextBody(
  form: ContextMessageNode['form'],
  props: { content: ContextMessageNode['content']; source: unknown; t: Translate },
): { rendered: KnownContextForm | null; body: ReactNode } {
  switch (form) {
    case 'instructions':
      return instructionChanges(props.source) === null
        ? { rendered: null, body: <OpaqueBody {...props} /> }
        : { rendered: 'instructions', body: <InstructionsBody {...props} /> }
    case 'catalog':
      return catalogEntries(props.source) === null
        ? { rendered: null, body: <OpaqueBody {...props} /> }
        : { rendered: 'catalog', body: <CatalogBody {...props} /> }
    case null:
      return { rendered: null, body: <OpaqueBody {...props} /> }
    /* v8 ignore next 4 -- closed-union backstop; the compiler rejects a new
    KnownContextForm here rather than letting it degrade to opaque silently. */
    default: {
      const unreachable: never = form
      throw new Error(`unreachable context form: ${String(unreachable)}`)
    }
  }
}
