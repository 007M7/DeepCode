// Deliverables: the produced-file row a finished turn ends with. The paths come
// from the mutation tools' follow-along locations (see turnDeliverables), never
// from the closing prose, so the answer carries its own output whether or not
// the model remembered to name it. Clicking one goes through the same openFile
// the tool rows use — in the browser that is a new tab served from the session
// workspace, and outside it the Host's own opener.

import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './Deliverables.module.css'

/** Files past this stay counted but unlisted: a refactor turn must not bury the answer. */
const SHOWN = 6

/** Trailing path segment, the part that identifies the file at a glance. */
function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * Render one turn's produced files as openable chips.
 * @param props - the turn's paths (tool order, already deduped), the chat
 * view's file opener, and the owning view's locale seat.
 * @returns The row, or `null` when the turn produced nothing.
 */
export function Deliverables({ paths, openFile, t }: {
  paths: readonly string[]
  openFile: (path: string) => void
  t: ChatViewSlotProps['t']
}) {
  if (paths.length === 0) return null
  const shown = paths.slice(0, SHOWN)
  const hidden = paths.length - shown.length
  return (
    <div className={css.root}>
      <span className={css.label}>{t('produced.label')}</span>
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
      {hidden > 0 && <span className={css.more}>{t('produced.more', { count: String(hidden) })}</span>}
    </div>
  )
}
