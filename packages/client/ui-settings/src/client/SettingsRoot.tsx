/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. Modal open
 * state and the active section id are component-local viewing state; the
 * section ledger arrives through the injected face (nav labels are
 * registrant-localized — the shell owns no locale/theme subscription).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconCloseOutline16, IconDataOutline16, IconSettingsOutline14, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps } from './contract/slots.ts'
import css from './SettingsRoot.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  translate: SettingsRootComponentProps['translate']
  rows: ReturnType<SettingsRootComponentProps['sections']>
  renderSlot: SettingsRootComponentProps['renderSlot']
  onClose: () => void
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ translate, rows, renderSlot, onClose }: PanelProps) {
  // Local selection; entries can unmount underneath it, so the render-time
  // projection falls back to the first row when the id is gone.
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const active = rows.find((r) => r.id === activeId)?.id ?? rows[0]?.id

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-label={translate('settings:title')}>
        <nav className={css.nav} aria-label={translate('settings:title')}>
          <div className={css.navTitle}>{translate('settings:title')}</div>
          <div className={css.navList}>
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { setActiveId(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <button ref={closeButton} type="button" className={css.close} aria-label={translate('settings:close')} onClick={onClose}>
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', {}, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, translate, subscribeSections, sectionsVersion, sections, renderSlot } = props
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])

  // The ledger tick is the shell's only subscription: sections re-register
  // with freshly localized labels on locale change, so the version bump also
  // re-renders the shell's own translate()-read chrome copy.
  // State = ledger version: same-version notifications dedupe to no render.
  const [, setSectionsRev] = useState(() => sectionsVersion())
  useEffect(
    () => subscribeSections(() => { setSectionsRev(sectionsVersion()) }),
    [subscribeSections, sectionsVersion],
  )
  const rows = sections()

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-label={translate('settings:trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        <IconSettingsOutline14 size={wide ? 14 : 18} />
        {wide && <span className={css.triggerLabel}>{translate('settings:trigger')}</span>}
      </button>
      {open && <SettingsPanel translate={translate} rows={rows} renderSlot={renderSlot} onClose={close} />}
    </>
  )
}
