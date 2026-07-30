// Queue dock entry: renders the authoritative transient inbox snapshot and
// addresses per-row mutations through the session-scoped conversation face.
//
// The 'conversation.input.dock' SlotMap declaration lives in
// ../contract/slots.ts beside the other input-region slots.
import type { Context } from 'cordis'
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconCheckOutline16, IconCloseOutline16, IconEditOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { QueueAction, QueueItemId } from '../contract/queue.ts'
import css from './QueueDock.module.css'

/** Queue operations injected by the session-scoped registration. */
export interface QueueDockInjected {
  updateQueue: (itemId: QueueItemId, action: QueueAction) => Promise<void>
  notify: (level: 'info' | 'error', text: string) => void
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat. */
export type QueueDockProps = PropsRuntime<'conversation.input.dock'> & QueueDockInjected

/** Queue strip: one preview line per queued message; renders null when the queue is empty. */
export function QueueDock({ useSession, updateQueue, notify }: QueueDockProps) {
  const queue = useSession(s => s.queue)
  const [editing, setEditing] = useState<{ id: QueueItemId; text: string } | null>(null)
  const [busy, setBusy] = useState<QueueItemId | null>(null)

  useEffect(() => {
    if (editing !== null && !queue.some(row => row.id === editing.id)) setEditing(null)
  }, [editing, queue])

  if (queue.length === 0) return null

  const applyAction = async (
    itemId: QueueItemId,
    action: QueueAction,
    failure: string,
  ): Promise<boolean> => {
    setBusy(itemId)
    try {
      await updateQueue(itemId, action)
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => current === itemId ? null : current)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === '') return
    if (await applyAction(
      editing.id,
      { kind: 'edit', content: [{ type: 'text', text: editing.text }] },
      '编辑失败：这条消息可能已经开始发送。',
    )) setEditing(null)
  }

  return (
    <div className={css.dock}>
      <div className={css.panel}>
        <ul className={css.list}>
          {queue.map(row => (
            <li key={row.id} className={css.row}>
              {editing?.id === row.id
                ? (
                  <input
                    autoFocus
                    className={css.editor}
                    aria-label="编辑排队消息"
                    value={editing.text}
                    onChange={(event) => { setEditing({ id: row.id, text: event.currentTarget.value }) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setEditing(null)
                        return
                      }
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void saveEdit()
                      }
                    }}
                  />
                )
                : <span className={css.preview}>{row.preview}</span>}
              <div className={css.actions}>
                {editing?.id === row.id
                  ? (
                    <>
                      <button
                        type="button"
                        className={css.action}
                        aria-label="保存排队消息"
                        title="保存排队消息"
                        disabled={busy !== null || editing.text.trim() === ''}
                        onClick={() => { void saveEdit() }}
                      >
                        <IconCheckOutline16 size={14} />
                      </button>
                      <button
                        type="button"
                        className={css.action}
                        aria-label="取消编辑"
                        title="取消编辑"
                        disabled={busy !== null}
                        onClick={() => { setEditing(null) }}
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </>
                  )
                  : (
                    <>
                      <button
                        type="button"
                        className={css.action}
                        aria-label="编辑排队消息"
                        title={row.text === null ? '包含非文本内容，暂不支持编辑' : '编辑排队消息'}
                        disabled={busy !== null || row.text === null}
                        onClick={() => {
                          if (row.text !== null) setEditing({ id: row.id, text: row.text })
                        }}
                      >
                        <IconEditOutline16 size={14} />
                      </button>
                      <button
                        type="button"
                        className={css.action}
                        aria-label="删除排队消息"
                        title="删除排队消息"
                        disabled={busy !== null}
                        onClick={() => {
                          void applyAction(
                            row.id,
                            { kind: 'remove' },
                            '删除失败：这条消息可能已经开始发送。',
                          )
                        }}
                      >
                        <IconTrashOutline16 size={14} />
                      </button>
                    </>
                  )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * The dock entry as a plain registrant plugin. The conversation service is the
 * ordering and action seam; session scopes provide the exact queue owner.
 */
export const queueDockEntry = {
  name: 'conversation-queue-dock',
  inject: ['slots', 'conversation', 'sessions'],
  /**
   * Register the queue strip into the input dock (list entry, order 0).
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'queue',
      order: 0,
      inject: (sessionId: SessionId): QueueDockInjected => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`queue dock: session "${sessionId}" resolved no scope`)
        const conversation = actx.get('conversation')
        if (conversation === undefined) throw new Error('queue dock: conversation service unavailable')
        return {
          updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
          notify: (level, text) => { conversation.input.for(actx).notify(level, text) },
        }
      },
    }, QueueDock)
  },
}
