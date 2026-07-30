import { useState } from 'react'
import type { PermissionSelect as PermissionSelectValue } from '@deepseek-ai/dsh-permission/client'
import { Button, IconWarningOutline16, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PermissionSelect.module.css'

const FULL_ACCESS = 'danger-full-access'

/**
 * Display transform: kebab-case machine names render as title-case labels
 * (`workspace-write` → `Workspace Write`); non-kebab host-configured names
 * pass through. Twin of the /permission popup's (client ui-permission) — the
 * two permission surfaces must show the same text.
 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function optionLabel(option: PermissionSelectValue['options'][number]): string {
  return option.value === FULL_ACCESS ? 'Full access' : displayName(option.name)
}

export interface PermissionSelectProps {
  value: PermissionSelectValue | undefined
  locked: boolean
  command: (line: string) => Promise<boolean>
  t: (key: string) => string
}

export function PermissionSelect({ value, locked, command, t }: PermissionSelectProps) {
  const [pick, setPick] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  if (value === undefined) return null

  const currentValue = pick ?? value.currentValue
  const current = value.options.find(option => option.value === currentValue)
  const busy = pick !== null || confirmation !== null

  const items: MenuEntry[] = value.options
    .filter(o => o.value !== 'custom')
    .map(option => ({ id: option.value, label: optionLabel(option) }))

  const submit = (id: string): void => {
    setPick(id)
    void command(`/permission ${id}`)
      .catch(() => false)
      .then(() => { setPick(null) })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (id === value.currentValue) return
    if (id === FULL_ACCESS) {
      setAcknowledged(false)
      setConfirmation(id)
      return
    }
    submit(id)
  }

  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirmation(null)
  }

  const confirmFullAccess = (): void => {
    if (!acknowledged || confirmation === null) return
    const id = confirmation
    closeConfirmation()
    submit(id)
  }

  return (
    <>
      <Menu
        open={open}
        items={items}
        selectedId={currentValue}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        anchor={
          <button
            type="button"
            className={css.trigger}
            aria-label={`Access mode, current: ${current === undefined ? displayName(currentValue) : optionLabel(current)}`}
            title={current?.description}
            disabled={locked || busy}
            onClick={() => { setOpen(!open) }}
          >
            <span className={css.triggerLabel}>{current === undefined ? displayName(currentValue) : optionLabel(current)}</span>
            <svg className={css.chevron} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
        }
      />
      <Modal
        open={confirmation !== null}
        onClose={closeConfirmation}
        title={t('confirm.title')}
        className={css.confirmation ?? ''}
        contentClassName={css.confirmationContent ?? ''}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeConfirmation}>
              {t('confirm.cancel')}
            </Button>
            <Button
              variant="primary"
              className={css.confirmAction}
              disabled={!acknowledged}
              onClick={confirmFullAccess}
            >
              {t('confirm.enable')}
            </Button>
          </>
        )}
      >
        <div className={css.warning}>
          <IconWarningOutline16 size={18} className={css.warningIcon} />
          <p>{t('confirm.description')}</p>
        </div>
        <label className={css.acknowledgement}>
          <input
            type="checkbox"
            checked={acknowledged}
            autoFocus
            onChange={(event) => { setAcknowledged(event.currentTarget.checked) }}
          />
          <span>{t('confirm.acknowledge')}</span>
        </label>
      </Modal>
    </>
  )
}
