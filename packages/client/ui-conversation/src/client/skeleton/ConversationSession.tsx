/** Strict per-session conversation content: header, view ring, and chat store bindings. */

import { useEffect, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { shallowEqual } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session slot contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

function deriveAncestry(list: SessionListState, id: SessionId): readonly SessionSummary[] {
  const chain: SessionSummary[] = []
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined || chain.includes(summary)) break
    chain.unshift(summary)
    cursor = summary.parentId
  }
  return chain
}

export function ConversationSession({
  sessionId, useSession, useSessions, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, open,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const activeId = useStore(s => s.view) ?? 'chat'
  const active = tabs.find(view => view.id === activeId) ?? tabs[0]
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), shallowEqual)
  const turns = useSession(s => countTurns(s))
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  if (blank && composerPhase === 'blank') return null

  return (
    <>
      <header className={css.header}>
        <div className={css.crumbRow}>
          <nav className={css.crumbs} aria-label="Session hierarchy">
            {ancestry.map((summary, index) => {
              const last = index === ancestry.length - 1
              return (
                <span key={summary.id} className={css.crumbSeg}>
                  {index > 0 && <span className={css.crumbSep}>/</span>}
                  <button
                    type="button"
                    className={clsx(css.crumb, last && css.crumbCurrent)}
                    disabled={last}
                    onClick={() => { open(summary.id) }}
                  >
                    {summary.displayTitle}
                  </button>
                </span>
              )
            })}
            {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
            <span className={css.meta}>· {turns} turns</span>
          </nav>
        </div>
        {tabs.length > 1 && (
          <div className={css.tabs} role="tablist">
            {tabs.map(view => (
              <button
                key={view.id}
                type="button"
                role="tab"
                aria-selected={view.id === active?.id}
                className={clsx(css.tab, view.id === active?.id && css.tabActive)}
                onClick={() => { actions.setView(view.id) }}
              >
                {view.label}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className={css.viewArea}>
        {active !== undefined && renderSlot('conversation.view', {}, { only: active.id })}
      </div>
    </>
  )
}

function countTurns(snapshot: { nodes: readonly { kind: string }[] }): number {
  let count = 0
  for (const node of snapshot.nodes) if (node.kind === 'user') count += 1
  return count
}
