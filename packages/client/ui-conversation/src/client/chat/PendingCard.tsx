// PendingCard: approval placeholder card (visible, not answerable — the
// composer-takeover approval panel is a P-II item; wire pending semantics
// already exist so the flow must show them). Question waits render through
// the ask_user_question toolview row + the composer takeover instead.

import { memo } from 'react'
import type { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import css from './PendingCard.module.css'

export interface PendingCardProps {
  item: PendingWait<'approval'>
}

export const PendingCard = memo(function PendingCard({ item }: PendingCardProps) {
  return (
    <div className={css.card}>
      <div className={css.title}>等待审批：<span className={css.mono}>{item.payload.toolName}</span></div>
      {item.payload.reason !== undefined && <div className={css.reason}>{item.payload.reason}</div>}
      <div className={css.hint}>请在原客户端处理（web 端审批后续里程碑提供）</div>
    </div>
  )
})
