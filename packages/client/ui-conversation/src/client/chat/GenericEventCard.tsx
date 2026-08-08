// GenericEventCard: the visible fallback for a Host-presented durable event.
// A domain plugin may replace it through the keyed eventview slot; without
// one, the durable event type and JSON sidecar remain inspectable in the flow.

import { useMemo, useState } from 'react'
import { DisclosureRow, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, EventRowOwnerProps } from '../contract/slots.ts'
import css from './ContextInjectionRow.module.css'

/** Card props: the event owner payload plus the render site's locale seat. */
export interface GenericEventCardProps extends EventRowOwnerProps {
  t: ChatViewSlotProps['t']
}

/** Render an unregistered event presentation as a visible JSON disclosure. */
export function GenericEventCard({ node, t }: GenericEventCardProps) {
  const [open, setOpen] = useState(false)
  const body = useMemo(() => open ? JSON.stringify(node.view, null, 2) : '', [node.view, open])
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconSparkle16 size={14} />}
      chevronClassName={css.chevron}
      title={t('message.presentedEvent', { key: node.eventType })}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <pre className={css.body} data-presented-event-body>{body}</pre>
    </DisclosureRow>
  )
}
