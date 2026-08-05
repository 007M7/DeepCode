// Expanded bodies for the context disclosure, one per durable context form.
// The producer declares the form; this module only chooses a presentation for
// it. Every form falls back to OpaqueBody, which is the documented default for
// an absent, unknown, or malformed form — a resumed or foreign log must render
// even when this UI version has never seen its producer.

import type { ReactNode } from 'react'
import type { ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
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
 */
function partitionContent(content: ContextMessageNode['content']): { text: string; rest: unknown[] } {
  const texts: string[] = []
  const rest: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push(block.text)
    else rest.push(block)
  }
  return { text: texts.join('\n'), rest }
}

/** The model-facing text, truncated to the display bound. */
function boundedText(text: string, t: Translate): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n${t('json.truncated', { total: text.length })}`
    : text
}

/** One source field rendered as a value row; nested shapes stay compact JSON. */
function fieldValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Provenance fields as a key/value list. `kind` is omitted because the row
 * header already names the producer, and `form` because the presentation the
 * reader is looking at IS that value.
 */
function SourceFields({ source }: { source: unknown }): ReactNode {
  const record = asRecord(source)
  if (record === null) return null
  const rows = Object.entries(record).filter(([key]) => key !== 'kind' && key !== 'form')
  if (rows.length === 0) return null
  return (
    <dl className={css.fields} data-context-fields>
      {rows.map(([key, value]) => (
        <div key={key} className={css.field}>
          <dt className={css.fieldKey}>{key}</dt>
          <dd className={css.fieldValue}>{fieldValue(value)}</dd>
        </div>
      ))}
    </dl>
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
      <SourceFields source={source} />
    </>
  )
}

/** One reconciled instruction file, as the durable source records it. */
interface InstructionChange {
  action: string
  path: string
  digest?: string
}

/** Instruction changes read off the source; empty when the shape is unusable. */
function instructionChanges(source: unknown): InstructionChange[] {
  const record = asRecord(source)
  const list = record === null ? undefined : record['changes']
  if (!Array.isArray(list)) return []
  const changes: InstructionChange[] = []
  for (const entry of list) {
    const change = asRecord(entry)
    if (change === null) continue
    const path = change['path']
    if (typeof path !== 'string' || path === '') continue
    const action = change['action']
    const digest = change['digest']
    changes.push({
      action: typeof action === 'string' ? action : '',
      path,
      ...typeof digest === 'string' ? { digest } : {},
    })
  }
  return changes
}

/**
 * `instructions` form: the files this context reconciled, then their text.
 *
 * The text keeps its `<system-reminder>` framing verbatim — the framing is part
 * of what the model read, so hiding it would misreport the request.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The instructions context body.
 */
export function InstructionsBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const changes = instructionChanges(source)
  const baseline = asRecord(source)?.['baseline'] === true
  const { text, rest } = partitionContent(content)
  return (
    <>
      {changes.length > 0 && (
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
      )}
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

/** One catalog entry, as the durable source records it. */
interface CatalogEntry {
  name: string
  description: string
}

/** Catalog entries read off the source; empty when the shape is unusable. */
function catalogEntries(source: unknown): CatalogEntry[] {
  const record = asRecord(source)
  const list = record === null ? undefined : record['entries']
  if (!Array.isArray(list)) return []
  const entries: CatalogEntry[] = []
  for (const item of list) {
    const entry = asRecord(item)
    if (entry === null) continue
    const name = entry['name']
    if (typeof name !== 'string' || name === '') continue
    const description = entry['description']
    entries.push({ name, description: typeof description === 'string' ? description : '' })
  }
  return entries
}

/**
 * `catalog` form: the published entries as a list, read from the source rather
 * than re-parsed out of the model-facing prose.
 *
 * A catalog whose source carries no usable entries falls through to the opaque
 * body, so an older or hand-edited log still shows its text.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The catalog context body.
 */
export function CatalogBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const entries = catalogEntries(source)
  if (entries.length === 0) return <OpaqueBody content={content} source={source} t={t} />
  return (
    <ul className={css.entries} data-context-entries>
      {entries.map(entry => (
        <li key={entry.name} className={css.entry}>
          <code className={css.entryName}>{entry.name}</code>
          <span className={css.entryDescription}>{entry.description}</span>
        </li>
      ))}
    </ul>
  )
}
