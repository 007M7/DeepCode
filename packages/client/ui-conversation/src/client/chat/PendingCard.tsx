// PendingCard: approval/question placeholder card (visible, not answerable —
// the composer-takeover approval panel is a P-II item; wire pending semantics
// already exist so the flow must show them).

import { memo } from 'react'
import type { PendingInteraction } from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PendingCard.module.css'

export interface PendingCardProps {
  item: PendingInteraction
}

export const PendingCard = memo(function PendingCard({ item }: PendingCardProps) {
  return (
    <div className={css.card}>
      {item.kind === 'approval' ? (
        <>
          <div className={css.title}>等待审批：<span className={css.mono}>{item.toolName}</span></div>
          {item.reason !== undefined && <div className={css.reason}>{item.reason}</div>}
        </>
      ) : (
        <>
          <div className={css.title}>等待回答（{item.questions.length} 题）</div>
          <JsonBlock label="问题内容" payload={item.questions} />
        </>
      )}
      <div className={css.hint}>请在原客户端处理（web 端作答后续里程碑提供）</div>
    </div>
  )
})
