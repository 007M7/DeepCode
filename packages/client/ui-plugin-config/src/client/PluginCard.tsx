/**
 * One plugin's card: a header naming the plugin and what its settings govern,
 * disclosing that plugin's controls in place.
 *
 * The header is its own button rather than a shared disclosure row because a
 * card stacks its name over its description, while that row lays the two side
 * by side — the layout, not the behavior, is what differs. Disclosure is
 * card-local state: which card a user has open is a reading gesture, not
 * something the Host or the section has any stake in.
 *
 * A card renders nothing while its namespace is unavailable: a deployment that
 * does not compose the owning plugin should show no trace of it, rather than a
 * disabled card the user cannot act on.
 */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginConfigKey } from './locales.ts'
import css from './PluginCard.module.css'

/** Card chrome shared by every plugin section. */
export interface PluginCardProps {
  /** Locale reader for this section's copy. */
  t: (key: PluginConfigKey) => string
  /** Locale key of the plugin's name. */
  titleKey: PluginConfigKey
  /** Locale key of the line describing what this plugin's settings govern. */
  descriptionKey: PluginConfigKey
  /** False while the namespace is not served to this client. */
  available: boolean
  /** True when the Host document is read-only, which disables the fields. */
  readOnly: boolean
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render one plugin card.
 * @param props - the plugin's copy keys, its availability, and its controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps) {
  const [open, setOpen] = useState(false)
  if (!props.available) return null
  const title = props.t(props.titleKey)
  return (
    <li className={clsx(css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${props.t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{props.t(props.descriptionKey)}</span>
        </span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {props.readOnly ? <p className={css.readOnly} role="status">{props.t('readOnly')}</p> : null}
            {props.children}
          </div>
        )
        : null}
    </li>
  )
}
