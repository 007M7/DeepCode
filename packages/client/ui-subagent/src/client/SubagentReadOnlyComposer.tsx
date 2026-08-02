import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SubagentReadOnlyComposer.module.css'

/** Why a catalog-addressed conversation cannot accept human input. */
export interface SubagentReadOnlyMatch {
  reason: 'one-shot' | 'parent-unavailable'
}

/** Full chain props after the read-only subagent selector accepts the owner currency. */
export type SubagentReadOnlyComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: SubagentReadOnlyMatch }

/**
 * Explain why the normal composer is unavailable for an addressed child.
 * @param props - selector-owned read-only reason plus standard slot props.
 * @returns A read-only composer replacement.
 */
export function SubagentReadOnlyComposer({
  matched,
}: Pick<SubagentReadOnlyComposerProps, 'matched'>) {
  const oneShot = matched.reason === 'one-shot'
  return (
    <div className={css.frame} role="status">
      <strong>{oneShot ? '一次性子代理记录' : '此子代理暂时只读'}</strong>
      <span>
        {oneShot
          ? '一次性任务不支持后续消息，可在这里查看完整执行记录。'
          : '父会话当前不在线，重新打开父会话后即可继续发送消息。'}
      </span>
    </div>
  )
}
