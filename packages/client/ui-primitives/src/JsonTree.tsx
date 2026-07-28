import clsx from 'clsx'
import { collapseAllNested, JsonView } from 'react-json-view-lite'
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, UIEvent as ReactUIEvent } from 'react'
import type { Props as LiteJsonViewProps } from 'react-json-view-lite'
import { IconCheckOutline16, IconCopyOutline16 } from './icons/index.tsx'
import { Menu } from './Menu.tsx'
import type { MenuEntry } from './Menu.tsx'
import css from './JsonTree.module.css'

const OBJECT_PREVIEW_LIMIT = 4
const ARRAY_PREVIEW_LIMIT = 5
const PREVIEW_DEPTH_LIMIT = 2
const VALUE_COPY_MENU_ITEMS: readonly MenuEntry[] = [
  { id: 'value', label: 'Copy value' },
  { id: 'json', label: 'Copy JSON' },
  { id: 'path', label: 'Copy property path' },
]
const OBJECT_COPY_MENU_ITEMS: readonly MenuEntry[] = [
  { id: 'prettyJson', label: 'Copy pretty JSON' },
  { id: 'json', label: 'Copy compact JSON' },
  { id: 'path', label: 'Copy property path' },
]

const TREE_STYLES: NonNullable<LiteJsonViewProps['style']> = {
  container: clsx(css.container),
  childFieldsContainer: clsx(css.children),
  basicChildStyle: clsx(css.row),
  label: clsx(css.label),
  clickableLabel: clsx(css.label, css.clickableLabel),
  nullValue: clsx(css.keywordValue),
  undefinedValue: clsx(css.keywordValue),
  numberValue: clsx(css.numberValue),
  stringValue: clsx(css.stringValue),
  booleanValue: clsx(css.keywordValue),
  otherValue: clsx(css.otherValue),
  punctuation: clsx(css.punctuation),
  expandIcon: clsx(css.expander, css.expandIcon),
  collapseIcon: clsx(css.expander, css.collapseIcon),
  collapsedContent: clsx(css.collapsedContent),
  noQuotesForStringValues: false,
  quotesForFieldNames: false,
  stringifyStringValues: true,
  ariaLables: {
    collapseJson: 'Collapse JSON node',
    expandJson: 'Expand JSON node',
  },
}

const EXPANDED_TOP_LEVEL_TREE_STYLES: NonNullable<LiteJsonViewProps['style']> = {
  ...TREE_STYLES,
  container: clsx(css.container, css.expandedTopLevelContainer),
}

function previewPrimitive(value: unknown): ReactNode {
  if (value === null) return <span className={css.keywordValue}>null</span>
  if (typeof value === 'string') {
    return <span className={css.stringValue}>{JSON.stringify(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className={css.numberValue}>{String(value)}</span>
  }
  if (typeof value === 'boolean') {
    return <span className={css.keywordValue}>{String(value)}</span>
  }
  if (typeof value === 'bigint') {
    return <span className={css.otherValue}>{value.toString()}</span>
  }
  if (typeof value === 'undefined') {
    return <span className={css.otherValue}>undefined</span>
  }
  if (typeof value === 'symbol') {
    return <span className={css.otherValue}>{value.description ?? 'Symbol'}</span>
  }
  return <span className={css.otherValue}>{value.name || 'Function'}</span>
}

function previewValue(value: unknown, depth: number): ReactNode {
  if (typeof value !== 'object' || value === null) return previewPrimitive(value)

  const array = Array.isArray(value)
  const entries = array
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value)
  const limit = array ? ARRAY_PREVIEW_LIMIT : OBJECT_PREVIEW_LIMIT
  const visible = entries.slice(0, limit)
  const open = array ? '[' : '{'
  const close = array ? ']' : '}'

  return (
    <>
      <span className={css.punctuation}>{open}</span>
      {depth >= PREVIEW_DEPTH_LIMIT
        ? <span className={css.previewEllipsis}>…</span>
        : visible.map(([key, item], index) => (
          <span key={key}>
            {index > 0 && <span className={css.punctuation}>, </span>}
            {!array && (
              <>
                <span className={css.previewProperty}>{key}</span>
                <span className={css.punctuation}>: </span>
              </>
            )}
            {previewValue(item, depth + 1)}
          </span>
        ))}
      {depth < PREVIEW_DEPTH_LIMIT && entries.length > limit && (
        <span className={css.previewEllipsis}>{visible.length > 0 ? ', …' : '…'}</span>
      )}
      <span className={css.punctuation}>{close}</span>
    </>
  )
}

function renderExpandableValue(value: object): ReactNode {
  return <span className={css.preview}>{previewValue(value, 0)}</span>
}

interface CopyTarget {
  left: number
  path: readonly (number | string)[]
  side: 'bottom' | 'top'
  top: number
  value: unknown
}

function fieldOf(row: HTMLElement): string | undefined {
  const label = Array.from(row.children).find(
    child => child instanceof HTMLElement && child.classList.contains(clsx(css.label)),
  )
  const text = label?.textContent
  return text === undefined ? undefined : text.slice(0, -1)
}

function resolveRow(data: object | unknown[], row: HTMLElement, expandTopLevel: boolean): {
  path: readonly (number | string)[]
  value: unknown
} | undefined {
  if (row.hasAttribute('data-json-root-row')) return { path: [], value: data }

  const lineage: HTMLElement[] = []
  let cursor: HTMLElement | null = row
  while (cursor !== null) {
    lineage.unshift(cursor)
    const group: HTMLElement | null = cursor.parentElement
    const parentRow: Element | null = group?.getAttribute('role') === 'group'
      ? group.parentElement?.closest('[role="treeitem"]') ?? null
      : null
    cursor = parentRow instanceof HTMLElement ? parentRow : null
  }

  let value: unknown = data
  const path: (number | string)[] = []
  for (const item of expandTopLevel ? lineage : lineage.slice(1)) {
    const field = fieldOf(item)
    if (field === undefined) return undefined
    if (Array.isArray(value)) {
      const index = Number(field)
      if (!Number.isInteger(index)) return undefined
      path.push(index)
      value = value[index]
    } else if (typeof value === 'object' && value !== null) {
      path.push(field)
      value = (value as Record<string, unknown>)[field]
    } else {
      return undefined
    }
  }
  return { path, value }
}

function formattedPath(path: readonly (number | string)[]): string {
  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${String(part)}]`
    return /^[A-Za-z_$][\w$]*$/.test(part)
      ? `${result}.${part}`
      : `${result}[${JSON.stringify(part)}]`
  }, '$')
}

function copyText(target: CopyTarget, mode: 'json' | 'path' | 'prettyJson' | 'value'): string {
  if (mode === 'path') return formattedPath(target.path)
  if (mode === 'prettyJson') return JSON.stringify(target.value, null, 2)
  if (mode === 'json') return JSON.stringify(target.value)
  if (typeof target.value === 'string') return target.value
  if (typeof target.value === 'object' && target.value !== null) {
    return JSON.stringify(target.value, null, 2)
  }
  if (typeof target.value === 'undefined') return 'undefined'
  if (typeof target.value === 'bigint') return target.value.toString()
  if (typeof target.value === 'symbol') return target.value.description ?? 'Symbol'
  if (typeof target.value === 'function') return target.value.name || 'Function'
  return JSON.stringify(target.value)
}

/** Props for the read-only, token-themed JSON tree. */
export interface JsonTreeProps {
  /** Parsed JSON object or array. */
  data: object | unknown[]
  /** Accessible label for the tree. */
  label?: string
  /** Optional positioning class owned by the caller. */
  className?: string | undefined
  /** Whether JSON rows expose copy actions. */
  copyable?: boolean
  /** Whether the top-level object or array is always expanded. */
  expandTopLevel?: boolean
}

/**
 * Render parsed JSON as a compact, keyboard-accessible inspector tree.
 * @param props - Parsed data, accessible label, and display options.
 * @returns A read-only JSON tree with an optionally fixed-open top level.
 */
export function JsonTree({
  data,
  label = 'JSON',
  className,
  copyable = true,
  expandTopLevel = true,
}: JsonTreeProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLElement>()
  const copyButtonRef = useRef<HTMLButtonElement>(null)
  const copyMenuOpenRef = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>()
  const [copyTarget, setCopyTarget] = useState<CopyTarget>()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)

  useEffect(() => () => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    activeRowRef.current?.removeAttribute('data-json-copy-active')
  }, [])

  const setActiveRow = (row: HTMLElement | undefined) => {
    activeRowRef.current?.removeAttribute('data-json-copy-active')
    activeRowRef.current = row
    row?.setAttribute('data-json-copy-active', '')
  }

  const positionCopyButton = (row: HTMLElement, target: {
    path: readonly (number | string)[]
    value: unknown
  }) => {
    const root = rootRef.current
    if (root === null) return
    const rootRect = root.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    setCopyTarget({
      left: rootRect.left + root.clientWidth - 26,
      path: target.path,
      side: rowRect.top - rootRect.top > root.clientHeight / 2 ? 'top' : 'bottom',
      top: rowRect.top,
      value: target.value,
    })
  }

  useEffect(() => {
    const reposition = () => {
      const row = activeRowRef.current
      if (row === undefined) return
      const resolved = resolveRow(data, row, expandTopLevel)
      if (resolved !== undefined) positionCopyButton(row, resolved)
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [data, expandTopLevel])

  const clearCopyTarget = () => {
    setActiveRow(undefined)
    setCopyTarget(undefined)
    setCopyState('idle')
    copyMenuOpenRef.current = false
    setCopyMenuOpen(false)
  }

  const handleMouseOver = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!copyable || !(event.target instanceof Element)) return
    if (copyMenuOpenRef.current) return
    if (!event.currentTarget.contains(event.target)) return
    if (event.target.closest('[data-json-copy-button]') !== null) return
    const row = event.target.closest<HTMLElement>('[data-json-root-row], [role="treeitem"]')
    if (row === null) {
      clearCopyTarget()
      return
    }
    if (activeRowRef.current === row) return
    const resolved = resolveRow(data, row, expandTopLevel)
    if (resolved === undefined) return
    setActiveRow(row)
    setCopyState('idle')
    copyMenuOpenRef.current = false
    setCopyMenuOpen(false)
    positionCopyButton(row, resolved)
  }

  const handleScroll = (event: ReactUIEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target) return
    const row = activeRowRef.current
    if (row === undefined) return
    const resolved = resolveRow(data, row, expandTopLevel)
    if (resolved !== undefined) positionCopyButton(row, resolved)
  }

  const copy = async (mode: 'json' | 'path' | 'prettyJson' | 'value') => {
    if (copyTarget === undefined) return
    try {
      await navigator.clipboard.writeText(copyText(copyTarget, mode))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => { setCopyState('idle') }, 1_500)
  }

  const copyTargetIsObject = typeof copyTarget?.value === 'object' && copyTarget.value !== null
  const defaultCopyMode = copyTargetIsObject ? 'prettyJson' : 'value'
  const copyTitle = copyState === 'copied'
    ? 'Copied'
    : copyState === 'failed'
      ? 'Copy failed'
      : copyTargetIsObject ? 'Copy pretty JSON' : 'Copy value'

  return (
    <div
      ref={rootRef}
      className={clsx(css.root, className)}
      onMouseOver={handleMouseOver}
      onMouseLeave={() => {
        if (!copyMenuOpenRef.current) clearCopyTarget()
      }}
      onScroll={handleScroll}
    >
      {expandTopLevel
        ? (
          <div className={css.expandedTopLevel}>
            <div className={clsx(css.row, css.topLevelBracket)} data-json-root-row>
              <span className={css.punctuation}>{Array.isArray(data) ? '[' : '{'}</span>
            </div>
            <JsonView
              aria-label={label}
              compactTopLevel
              data={data}
              style={EXPANDED_TOP_LEVEL_TREE_STYLES}
              shouldExpandNode={collapseAllNested}
              clickToExpandNode
              renderExpandableValue={renderExpandableValue}
            />
            <div className={clsx(css.row, css.topLevelBracket)}>
              <span className={css.punctuation}>{Array.isArray(data) ? ']' : '}'}</span>
            </div>
          </div>
        )
        : (
          <JsonView
            aria-label={label}
            data={data}
            style={TREE_STYLES}
            shouldExpandNode={collapseAllNested}
            clickToExpandNode
            renderExpandableValue={renderExpandableValue}
          />
        )}
      {copyTarget !== undefined && (
        <span
          className={css.copyAnchor}
          style={{ left: copyTarget.left, top: copyTarget.top }}
        >
          <Menu
            open={copyMenuOpen}
            compact
            portal
            align="end"
            side={copyTarget.side}
            anchor={(
              <button
                ref={copyButtonRef}
                type="button"
                className={css.copyButton}
                data-json-copy-button
                data-state={copyState}
                aria-label={copyTitle}
                title={`${copyTitle}; right-click for copy options`}
                onClick={() => void copy(defaultCopyMode)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  copyMenuOpenRef.current = true
                  setCopyMenuOpen(true)
                }}
              >
                {copyState === 'copied'
                  ? <IconCheckOutline16 size={12} />
                  : <IconCopyOutline16 size={12} />}
              </button>
            )}
            items={copyTargetIsObject ? OBJECT_COPY_MENU_ITEMS : VALUE_COPY_MENU_ITEMS}
            onSelect={(id) => {
              if (id === 'value' || id === 'json' || id === 'prettyJson' || id === 'path') {
                void copy(id)
              }
              copyMenuOpenRef.current = false
              setCopyMenuOpen(false)
            }}
            onClose={clearCopyTarget}
            getAnchorRect={() => copyButtonRef.current?.getBoundingClientRect() ?? null}
          />
        </span>
      )}
    </div>
  )
}
