/**
 * Pure protocol translation for the local host: what the server's capabilities allow, and how its
 * `Location`/`LocationLink`/`Hover` payloads normalize into the seam's closed result unions. No I/O
 * or process state — every function here is a pure transform, which the fake-stdio tests pin exactly.
 * @module @deepseek-ai/dsh-lsp-local/translate
 */

import type {
  LspHover,
  LspLocation,
  LspOperation,
  LspRange,
} from '@deepseek-ai/dsh-lsp'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type {
  WireHover,
  WireLocation,
  WireLocationLink,
  WireMarkedString,
  WireProviderCapability,
  WireRange,
  WireServerCapabilities,
  WireTextDocumentSyncKind,
  WireTextDocumentSyncOptions,
} from './protocol.ts'

/**
 * The `textDocument/*` request method for each seam operation.
 * @param operation - the seam operation to map.
 * @returns the LSP request method name.
 */
export function requestMethod(operation: LspOperation): string {
  switch (operation) {
    case 'definition': return 'textDocument/definition'
    case 'references': return 'textDocument/references'
    case 'implementation': return 'textDocument/implementation'
    case 'hover': return 'textDocument/hover'
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'requestMethod')
  }
}

/** The `ServerCapabilities` provider field backing each operation. */
function capabilityValue(capabilities: WireServerCapabilities, operation: LspOperation): WireProviderCapability {
  switch (operation) {
    case 'definition': return capabilities.definitionProvider
    case 'references': return capabilities.referencesProvider
    case 'implementation': return capabilities.implementationProvider
    case 'hover': return capabilities.hoverProvider
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'capabilityValue')
  }
}

/** A provider capability is present when the server sent `true` or an options object (not `false`/absent). */
function supportsCapability(value: WireProviderCapability): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return true
}

/**
 * Whether the server advertises the requested operation.
 * @param capabilities - the server's `initialize` capabilities.
 * @param operation - the seam operation to check.
 * @returns true when the corresponding provider capability is present.
 */
export function supportsOperation(capabilities: WireServerCapabilities, operation: LspOperation): boolean {
  return supportsCapability(capabilityValue(capabilities, operation))
}

/**
 * Whether a `textDocumentSync` value permits the transient `didOpen`/`didClose` this host relies on.
 * @param sync - the server's advertised `textDocumentSync` capability.
 * @returns true when transient open/close is supported.
 */
export function supportsTransientOpen(sync: WireServerCapabilities['textDocumentSync']): boolean {
  if (sync === undefined) return false
  if (typeof sync === 'number') return isOpenCloseKind(sync)
  return sync.openClose === true || (sync.openClose === undefined && changeAllowsOpenClose(sync))
}

/** Legacy enum: `Full` (1) or `Incremental` (2) imply open/close support; `None` (0) does not. */
function isOpenCloseKind(kind: WireTextDocumentSyncKind): boolean {
  return kind === 1 || kind === 2
}

/** Options without an explicit `openClose` fall back to the legacy `change` enum's implication. */
function changeAllowsOpenClose(sync: WireTextDocumentSyncOptions): boolean {
  return sync.change !== undefined && isOpenCloseKind(sync.change)
}

/**
 * Normalize the negotiated position encoding. An omitted encoding defaults to `utf-16`; any value
 * other than `utf-16` is a protocol error this host does not support.
 * @param encoding - the server's advertised `positionEncoding`, if any.
 * @returns the string `'utf-16'`.
 * @throws Error for any non-`utf-16` encoding.
 */
export function negotiatePositionEncoding(encoding: string | undefined): 'utf-16' {
  if (encoding === undefined || encoding === 'utf-16') return 'utf-16'
  throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`)
}

/** Convert a wire range to the seam's range (structurally identical, but re-shaped as `readonly`). */
function toRange(range: WireRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/** Whether a record is a `LocationLink` (has `targetUri` + `targetSelectionRange`). */
function isLocationLink(value: Record<string, unknown>): boolean {
  return typeof value.targetUri === 'string' && isRange(value.targetSelectionRange)
}

/** Whether a record is a `Location` (has string `uri` + a range). */
function isLocation(value: Record<string, unknown>): boolean {
  return typeof value.uri === 'string' && isRange(value.range)
}

/** Structural range guard used by both location shapes. */
function isRange(value: unknown): value is WireRange {
  if (value === null || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  return isPosition(range.start) && isPosition(range.end)
}

/** Structural position guard. */
function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const position = value as Record<string, unknown>
  return typeof position.line === 'number' && typeof position.character === 'number'
}

/**
 * Normalize a navigation result (`Location`, `Location[]`, `LocationLink[]`, or `null`) to the seam's
 * locations. `Location` maps directly; `LocationLink` maps `targetUri` + `targetSelectionRange`.
 * @param payload - the raw `textDocument/definition|references|implementation` result.
 * @returns the normalized locations (empty for `null`/`[]`).
 * @throws Error when an element is neither a `Location` nor a `LocationLink`.
 */
export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null || payload === undefined) return []
  const elements = Array.isArray(payload) ? payload : [payload]
  const locations: LspLocation[] = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') {
      throw new Error('LSP navigation result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (isLocationLink(record)) {
      const link = record as unknown as WireLocationLink
      locations.push({ uri: link.targetUri, range: toRange(link.targetSelectionRange) })
    } else if (isLocation(record)) {
      const location = record as unknown as WireLocation
      locations.push({ uri: location.uri, range: toRange(location.range) })
    } else {
      throw new Error('LSP navigation result contained neither a Location nor a LocationLink')
    }
  }
  return locations
}

/** Render one `MarkedString` (string form verbatim; object form as a language-tagged fenced block). */
function renderMarkedString(value: WireMarkedString): string {
  if (typeof value === 'string') return value
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

/**
 * Normalize a `Hover` (or `null`) to the seam's hover. `MarkupContent` uses its `value`; a string
 * `MarkedString` is verbatim; a language-tagged `MarkedString` becomes a fenced code block; an array
 * joins its rendered parts with one blank line. `maxHoverChars` is NOT applied here — the tool caps.
 * @param payload - the raw `textDocument/hover` result.
 * @returns the normalized hover, or `null` when there is no content.
 * @throws Error when the payload is a non-null, non-object, or structurally invalid hover.
 */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null || payload === undefined) return null
  if (typeof payload !== 'object') throw new Error('LSP hover result was not an object')
  const hover = payload as unknown as WireHover
  const contents = renderHoverContents(hover.contents)
  if (contents === '') return null
  const range = hover.range
  return range !== undefined && isRange(range) ? { contents, range: toRange(range) } : { contents }
}

/** Render the three `Hover.contents` encodings into one string (input is untrusted wire data). */
function renderHoverContents(contents: unknown): string {
  if (contents === null || contents === undefined) {
    throw new Error('LSP hover result had no contents')
  }
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map(renderMarkedString).join('\n\n')
  }
  if (typeof contents !== 'object') {
    throw new Error('LSP hover contents were not MarkupContent, MarkedString, or an array')
  }
  const record = contents as Record<string, unknown>
  if (record.kind === 'markdown' || record.kind === 'plaintext') {
    return typeof record.value === 'string' ? record.value : ''
  }
  if (typeof record.language === 'string' && typeof record.value === 'string') {
    return renderMarkedString({ language: record.language, value: record.value })
  }
  throw new Error('LSP hover contents were not MarkupContent, MarkedString, or an array')
}
