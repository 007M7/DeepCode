// MessageItem: simple chat nodes — user bubble (right-aligned, with copy /
// branch / edit IconActions), steering (badged bubble), context injection,
// retry disclosure and unknown-surface JSON rows. Props are frozen node slices
// off the snapshot cache; memo holds across streaming because unchanged nodes
// keep their references.

import { memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import type {
  ContextMessageNode, ModelRetryNode, SteeringMessageNode, UnknownSurfaceNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconBranchOutline16, IconCopyOutline16, IconEditOutline16,
  JsonBlock, MessageText, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
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
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
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

/** Best-effort clipboard write; rejections stay swallowed (no success chrome). */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Denied permissions / iframe policy.
    }
    return
  }
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    exec('copy')
  } catch {
    // Clipboard unavailable; the button stays idle.
  }
  el.remove()
}

/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only. Two
 * shapes decorate: legacy `<skill>name</skill>` spans (pre-decision-21
 * history) and plain-text `/name` / `@name` word-boundary tokens (decision
 * 21: the sent text IS the reference — the bubble uses the same plainest
 * token scan as the composer, minus the lexicon: sent tokens were validated
 * at compose time, so shape alone decorates).
 */
function projectUserText(text: string): ReactNode {
  const re = /<skill>([^<]+)<\/skill>|(^|\s)([/@][\w-]+)(?=\s|$)/g
  const parts: ReactNode[] = []
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const legacy = m[1] !== undefined
    const tokenStart = legacy ? m.index : m.index + (m[2]?.length ?? 0)
    const label = legacy ? `/${m[1]}` : m[3] ?? ''
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    parts.push(
      <span key={tokenStart} className={css.refChip} data-ref-chip={label.startsWith('@') ? 'subagent' : 'skill'}>
        {label}
      </span>,
    )
    cursor = legacy ? m.index + m[0].length : tokenStart + label.length
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

/** User-bubble IconActions (figma 659:38820): copy is live; branch/edit are chrome stubs. */
function UserActions({ text }: { text: string }) {
  const onCopy = useCallback(() => {
    void writeClipboard(text)
  }, [text])
  return (
    <div className={css.actions}>
      <Tooltip label="复制" side="bottom">
        <button type="button" className={css.action} aria-label="复制" onClick={onCopy}>
          <IconCopyOutline16 />
        </button>
      </Tooltip>
      <Tooltip label="在新对话中分支" side="bottom">
        <button type="button" className={css.action} aria-label="在新对话中分支">
          <IconBranchOutline16 />
        </button>
      </Tooltip>
      <Tooltip label="编辑" side="bottom">
        <button type="button" className={css.action} aria-label="编辑">
          <IconEditOutline16 />
        </button>
      </Tooltip>
    </div>
  )
}

export const MessageItem = memo(function MessageItem({ node, retryActive = false }: MessageItemProps) {
  switch (node.kind) {
    case 'user': {
      const { text, rest } = contentText(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.bubble}>
            {projectUserText(text)}
            {rest.map((block, i) => <JsonBlock key={i} label="附加内容块" payload={block} />)}
          </div>
          <UserActions text={text} />
        </div>
      )
    }
    case 'steering': {
      const { text, rest } = contentText(node.content)
      return (
        <div className={css.userRow}>
          <div className={css.bubble}>
            <span className={css.badge}>插话</span>
            {projectUserText(text)}
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
