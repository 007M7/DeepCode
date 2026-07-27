import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './SubagentReadOnlyComposer.module.css'

/** Full chain props after the read-only subagent selector accepts the owner currency. */
export type SubagentReadOnlyComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: ComposerChainProps }

/**
 * Explain why the normal composer is unavailable for a parentless child.
 * @returns A read-only composer replacement.
 */
export function SubagentReadOnlyComposer() {
  return (
    <div className={css.frame} role="status">
      <strong>此子代理暂时只读</strong>
      <span>父会话当前不在线，重新打开父会话后即可继续发送消息。</span>
    </div>
  )
}
