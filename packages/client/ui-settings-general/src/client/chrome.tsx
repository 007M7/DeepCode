/**
 * Shell chrome content registered into the shell's trigger/header seats: the
 * trigger row icon + label (figma sidebar foot) and the panel title text.
 * The shell renders the surrounding chrome (button, nav heading row) and
 * reads each entry's `label` option for aria text.
 */
import { IconSettingsOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './chrome.module.css'

/** Injected face of both chrome seats: the settings-namespace translate. */
export interface ChromeInjected {
  /** Translate a `settings` dictionary key to the active-locale text. */
  t: (key: string) => string
}

/** Trigger content props: the sidebar column state + translate. */
export type TriggerContentProps = PropsRuntime<'settings.trigger'> & ChromeInjected

/** Header content props: translate only. */
export type HeaderContentProps = PropsRuntime<'settings.header'> & ChromeInjected

/**
 * Render the trigger row content (icon; label only in the wide column).
 * @param props - composed slot props.
 * @returns the trigger content fragment.
 */
export function TriggerContent({ wide, t }: TriggerContentProps) {
  return (
    <>
      <IconSettingsOutline14 size={wide ? 14 : 18} />
      {wide && <span className={css.triggerLabel}>{t('trigger')}</span>}
    </>
  )
}

/**
 * Render the panel title text.
 * @param props - composed slot props.
 * @returns the title text node.
 */
export function HeaderContent({ t }: HeaderContentProps) {
  return <>{t('title')}</>
}

/** Close-button label text props: translate only. */
export type CloseLabelProps = PropsRuntime<'settings.close'> & ChromeInjected

/**
 * Render the close button's visually-hidden label text.
 * @param props - composed slot props.
 * @returns the label text node.
 */
export function CloseLabel({ t }: CloseLabelProps) {
  return <>{t('close')}</>
}
