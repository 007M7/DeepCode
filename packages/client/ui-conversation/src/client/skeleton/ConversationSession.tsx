/** Strict per-session conversation content: header, view ring, and chat store bindings. */

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session slot contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

export function ConversationSession({
  sessionId, useSession, useSessions, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, wrapActiveBody,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const activeId = useStore(s => s.view) ?? 'chat'
  const active = tabs.find(view => view.id === activeId) ?? tabs[0]
  const title = useSessions(s => s.byId[sessionId]?.displayTitle ?? sessionId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  // `?? null`: persisted snapshots from before the inspect field rehydrate without it.
  const inspect = useStore(s => s.inspect ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  // Blank hero/settling: keep the same header + body tree shape so a
  // wrapActiveBody-hosted composer keeps its DOM identity across the first
  // send (hero → active). Chrome is hidden; the draft-persistence mirror
  // still runs because this component stays mounted.
  const hideChrome = blank && composerPhase === 'blank'

  const view: ReactNode = hideChrome ? null : (
    <div className={css.viewArea}>
      {active !== undefined && renderSlot('conversation.view', {
        inspect,
        onInspectDone: () => { actions.setInspect(null) },
      }, { only: active.id })}
    </div>
  )

  return (
    <>
      <header
        className={clsx(css.header, hideChrome && css.headerHidden)}
        aria-hidden={hideChrome || undefined}
      >
        {!hideChrome && (
          <>
            <div className={css.titleRow}>
              <h1 className={css.sessionTitle}>{title}</h1>
            </div>
            {tabs.length > 1 && (
              <div className={css.tabs} role="tablist">
                {tabs.map(viewTab => (
                  <button
                    key={viewTab.id}
                    type="button"
                    role="tab"
                    aria-selected={viewTab.id === active?.id}
                    className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                    onClick={() => { actions.setView(viewTab.id) }}
                  >
                    {viewTab.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </header>
      {wrapActiveBody !== undefined ? wrapActiveBody(view) : view}
    </>
  )
}
