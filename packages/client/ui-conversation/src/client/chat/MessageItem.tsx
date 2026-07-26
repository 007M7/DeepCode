// MessageItem: simple chat nodes — user bubble (right-aligned), steering
// (badged bubble), context injection, retry disclosure and unknown JSON rows.
// Props are frozen node slices off the snapshot cache; memo holds across
// streaming because unchanged nodes keep their references.

import { memo, useEffect, useState } from 'react'
import type {
  ContextMessageNode, ModelRetryNode, SteeringMessageNode, UnknownSurfaceNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MessageItem.module.css'

export interface MessageItemProps {
  node: UserMessageNode | SteeringMessageNode | ContextMessageNode | ModelRetryNode | UnknownSurfaceNode
  retryActive?: boolean
}

function contentText(content: readonly unknown[]): { text: string; rest: unknown[] } {
  const texts: string[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else rest.push(block)
  }
  return { text: texts.join(''), rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function ModelRetryItem({ node, active }: { node: ModelRetryNode; active: boolean }) {
  const deadline = node.time + node.delayMs
  const scheduledSeconds = retrySeconds(node.delayMs)
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active || retrySeconds(deadline - Date.now()) === 1) return
    const timer = window.setInterval(() => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      if (next === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {active ? '正在重试' : '已重试'}模型请求（{node.retry}/{node.maxRetries}） · {active ? remainingSeconds : scheduledSeconds}s
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div><span className={css.retryDetailLabel}>重试延迟：</span>{Math.round(node.delayMs)}ms</div>
        <div><span className={css.retryDetailLabel}>失败原因：</span>{node.failure.message}</div>
      </div>
    </details>
  )
}

export const MessageItem = memo(function MessageItem({ node, retryActive = false }: MessageItemProps) {
  switch (node.kind) {
    case 'user':
    case 'steering': {
      const { text, rest } = contentText(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.bubble}>
            {node.kind === 'steering' && <span className={css.badge}>插话</span>}
            <MessageText text={text} />
            {rest.map((block, i) => <JsonBlock key={i} label="附加内容块" payload={block} />)}
          </div>
        </div>
      )
    }
    case 'context':
      return (
        <div className={css.contextRow}>
          <JsonBlock label="上下文注入" payload={{ content: node.content, meta: node.meta }} />
        </div>
      )
    case 'model-retry':
      return <ModelRetryItem node={node} active={retryActive} />
    default:
      return (
        <div className={css.contextRow}>
          <JsonBlock label={`未知 surface 事件：${node.type}`} payload={node.data} />
        </div>
      )
  }
})
