/**
 * Normalize persisted content arrays and single ACP update blocks.
 * @param value - Persisted model content or one ACP update block.
 * @returns The content blocks in encounter order.
 */
export function contentBlocks(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return typeof asRecord(value).type === 'string' ? [value] : []
}

/**
 * Render model content into the compact plain-text form used by the desktop UI.
 * @param value - Model content or one ACP update block.
 * @returns Plain text suitable for transcript previews.
 */
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  return contentBlocks(value).map((block) => {
    const record = asRecord(block)
    if (record.type === 'text' || record.type === 'reasoning') return stringValue(record.text)
    if (record.type === 'tool-call') return `[tool-call ${stringValue(record.name)}] ${displayValue(record.arguments)}`
    if (record.type === 'resource_link') return `[resource ${stringValue(record.name)}] ${stringValue(record.uri)}`
    return JSON.stringify(record)
  }).filter(Boolean).join('\n')
}

/**
 * Extract only assistant-visible text blocks from model content.
 * @param value - Persisted assistant content.
 * @returns Visible text joined by paragraph breaks.
 */
export function assistantText(value: unknown): string {
  if (typeof value === 'string') return value
  return contentBlocks(value)
    .filter(block => asRecord(block).type === 'text')
    .map(block => stringValue(asRecord(block).text))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Extract only reasoning blocks from model content.
 * @param value - Persisted assistant content.
 * @returns Reasoning text joined by paragraph breaks.
 */
export function reasoningText(value: unknown): string {
  return contentBlocks(value)
    .filter(block => asRecord(block).type === 'reasoning')
    .map(block => stringValue(asRecord(block).text))
    .filter(Boolean)
    .join('\n\n')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined ? '' : JSON.stringify(value)
}
