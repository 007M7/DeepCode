/**
 * One plugin's card: an expandable row whose body is that plugin's controls.
 * A card renders nothing while its namespace is unavailable — a deployment
 * that does not compose the owning plugin should show no trace of it, rather
 * than an empty or disabled card the user cannot act on.
 */

import type { ReactNode } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PluginCard.module.css'

/** Card chrome shared by every plugin section. */
export interface PluginCardProps {
  /** Plugin name shown on the row. */
  title: string
  /** One line describing what this plugin's settings govern. */
  description: string
  /** False while the namespace is not served to this client. */
  available: boolean
  /** Whether the card body is showing. */
  open: boolean
  /** Toggle the card body. */
  onToggle: () => void
  /** Copy shown when the settings document refuses writes. */
  readOnlyLabel?: string | undefined
  /** True when the Host document is read-only. */
  readOnly: boolean
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render one plugin card.
 * @param props - card chrome, disclosure state, and the plugin's controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps) {
  if (!props.available) return null
  return (
    <li className={css.card}>
      <DisclosureRow
        icon={null}
        title={props.title}
        open={props.open}
        expandable
        expandOnRowClick
        onToggle={props.onToggle}
        rowClassName={css.row}
        titleClassName={css.title}
        collapsedContent={<span className={css.description}>{props.description}</span>}
      >
        <div className={css.body}>
          {props.readOnly && props.readOnlyLabel !== undefined
            ? <p className={css.readOnly} role="status">{props.readOnlyLabel}</p>
            : null}
          {props.children}
        </div>
      </DisclosureRow>
    </li>
  )
}
