// ProducedFiles: the produced-file row a finished turn ends with. The paths
// come pre-matched by the turn-tail chain from the mutation tools'
// follow-along locations, never from the closing prose. Clicking one goes
// through the same openFile the tool rows use — the Host's own opener, on the
// Host machine.

import { useLayoutEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { basename } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './ProducedFiles.module.css'

/** At most six chips compete for the one-line summary; every other path stays counted. */
const SHOWN_LIMIT = 6

/**
 * Select the largest prefix whose measured chips and exact remainder fit.
 * @param available - usable width of the one-line file lane.
 * @param gap - computed flex gap between adjacent visible items.
 * @param chipWidths - measured widths for the candidate file chips.
 * @param moreWidthsByShown - exact localized remainder width for each shown count.
 * @returns Number of leading chips to render.
 */
export function fitProducedFiles(
  available: number,
  gap: number,
  chipWidths: readonly number[],
  moreWidthsByShown: readonly (number | undefined)[],
): number {
  if (available <= 0) return chipWidths.length
  const prefix = [0]
  for (const width of chipWidths) prefix.push((prefix.at(-1) ?? 0) + width)
  for (let shown = chipWidths.length; shown >= 0; shown -= 1) {
    const more = moreWidthsByShown[shown]
    const items = shown + (more === undefined ? 0 : 1)
    const needed = (prefix[shown] ?? 0) + (more ?? 0) + Math.max(0, items - 1) * gap
    if (needed <= available) return shown
  }
  return 0
}

/** Matched paths plus the opener and locale seats needed to present them. */
export type ProducedFilesProps = Pick<TurnTailOwnerProps, 'openFile'> & {
  matched: readonly string[]
  /** True only when this loopback deployment exposes a user-visible native opener. */
  canOpenPath: boolean
} & PropsLocale<typeof NS>

/** Slot-owned props before the connection capability is injected. */
export type ProducedFilesSeatProps = Omit<ProducedFilesProps, 'canOpenPath'>

function moreLabel(t: ProducedFilesProps['t'], count: number): string {
  return count === 1 ? t('produced.moreOne') : t('produced.more', { count: String(count) })
}

/**
 * Render one turn's produced files as openable chips.
 * @param props - selector-matched paths, the chat view's file opener, and the locale seat.
 * @returns The produced-files row.
 */
export function ProducedFiles({ matched: paths, openFile, canOpenPath, t }: ProducedFilesProps) {
  const limit = Math.min(paths.length, SHOWN_LIMIT)
  const [shownCount, setShownCount] = useState(limit)
  const rowRef = useRef<HTMLDivElement>(null)
  const chipProbes = useRef<Array<HTMLButtonElement | null>>([])
  const moreProbes = useRef<Array<HTMLSpanElement | null>>([])

  useLayoutEffect(() => {
    const row = rowRef.current
    if (row === null) return
    const measure = (): void => {
      const styles = getComputedStyle(row)
      const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0
      const chips = chipProbes.current.slice(0, limit)
        .map(probe => probe?.getBoundingClientRect().width ?? 0)
      const more = Array.from({ length: limit + 1 }, (_, candidate) =>
        paths.length === candidate
          ? undefined
          : moreProbes.current[candidate]?.getBoundingClientRect().width)
      setShownCount(fitProducedFiles(row.clientWidth, gap, chips, more))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    for (const probe of [...chipProbes.current, ...moreProbes.current]) {
      if (probe !== null) observer.observe(probe)
    }
    return () => { observer.disconnect() }
  }, [limit, paths, t])

  const visibleCount = Math.min(shownCount, limit)
  const shown = paths.slice(0, visibleCount)
  const hidden = paths.length - shown.length
  return (
    <div className={css.root}>
      <span className={css.label}>{t('produced.label')}</span>
      <div ref={rowRef} className={css.row} data-produced-files-row>
        {shown.map(path => (
          <button
            key={path}
            type="button"
            className={css.file}
            // The full path is the disambiguator when two turns produce files
            // that share a basename; the chip itself stays short.
            title={path}
            aria-label={t('produced.open', { name: path })}
            onClick={() => { openFile(path) }}
          >
            {basename(path)}
          </button>
        ))}
        {hidden > 0 && <span className={css.more}>{moreLabel(t, hidden)}</span>}
      </div>
      {hidden > 0 && canOpenPath && (
        <button type="button" className={css.showFolder} onClick={() => { openFile('.') }}>
          {t('produced.showInFolder')}
        </button>
      )}
      <div className={css.measure} aria-hidden="true">
        {paths.slice(0, limit).map((path, index) => (
          <button
            key={path}
            ref={(node) => { chipProbes.current[index] = node }}
            type="button"
            tabIndex={-1}
            className={`${css.file} ${css.probe}`}
          >
            {basename(path)}
          </button>
        ))}
        {Array.from({ length: limit + 1 }, (_, candidate) => {
          const remaining = paths.length - candidate
          if (remaining === 0) return null
          return (
            <span
              key={candidate}
              ref={(node) => { moreProbes.current[candidate] = node }}
              className={`${css.more} ${css.probe}`}
            >
              {moreLabel(t, remaining)}
            </span>
          )
        })}
      </div>
    </div>
  )
}
