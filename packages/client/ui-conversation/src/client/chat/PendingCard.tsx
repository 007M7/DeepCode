// PendingCard: approval placeholder card. Questions take over the composer.

import { memo } from 'react'
import type { PendingInteraction } from '@deepseek-ai/dsh-client-runtime/client'
import css from './PendingCard.module.css'

export interface PendingCardProps {
  item: Extract<PendingInteraction, { kind: 'approval' }>
}

export const PendingCard = memo(function PendingCard({ item }: PendingCardProps) {
  return (
    <div className={css.card}>
      <div className={css.title}>等待审批：<span className={css.mono}>{item.toolName}</span></div>
      {item.reason !== undefined && <div className={css.reason}>{item.reason}</div>}
      <div className={css.hint}>请在原客户端处理（web 端作答后续里程碑提供）</div>
    </div>
  )
})
