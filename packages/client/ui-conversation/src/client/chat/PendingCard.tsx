// PendingCard: question pending placeholder in the message flow (visible
// while the question composer owns the takeover slot elsewhere). Approvals
// do not render here: they take over the composer (skeleton ApprovalPanel)
// per the designer draft.

import { memo } from 'react'
import type { PendingInteraction } from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PendingCard.module.css'

export interface PendingCardProps {
  item: Extract<PendingInteraction, { kind: 'question' }>
}

export const PendingCard = memo(function PendingCard({ item }: PendingCardProps) {
  return (
    <div className={css.card}>
      <div className={css.title}>等待回答（{item.payload.questions.length} 题）</div>
      <JsonBlock label="问题内容" payload={item.payload.questions} />
    </div>
  )
})
