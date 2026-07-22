// ConversationRoot: the conversation slot's skeleton (figma Header 39:27730 +
// Tab_Group + view area + composer). Zero framework imports — everything
// arrives via props from the inject factory: breadcrumb feed, view registry
// read face, per-view render, and the composer's draft/send choreography.
// The active view id lives in layout.viewFor (shell viewing state), read and
// written through injected accessors.

import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { ConversationSlotProps } from '../contract/slots.ts'
import { InputBar } from './InputBar.tsx'
import type { InputBarError } from './InputBar.tsx'
import css from './ConversationRoot.module.css'

/**
 * Full props = owner share (sessionId) & standard share (useSession) &
 * injected share — composed by reference from the contract, never re-typed
 * here (share-ownership rule).
 */
export type ConversationRootProps = ConversationSlotProps

export function ConversationRoot({
  sessionId, useSession, useAncestry, views, useActiveView, composer, actions, renderView,
}: ConversationRootProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const list = views.list()
  const activeId = useActiveView() ?? 'chat'
  const active = list.find(v => v.id === activeId) ?? list[0]

  const ancestry = useAncestry()
  const draft = composer.useDraft()
  const running = useSession(s => (s as { running: boolean }).running)
  const removed = useSession(s => (s as { removed: boolean }).removed)
  const promptError = useSession(s => (s as { promptError: { op: 'send' | 'stop'; error: { message: string; code: string } } | null }).promptError)
  const turns = useSession(s => countTurns(s as { nodes: readonly { kind: string }[] }))

  const error: InputBarError | null = promptError === null
    ? null
    : { op: promptError.op, message: `${promptError.error.message}（${promptError.error.code}）` }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <div className={css.crumbRow}>
          <nav className={css.crumbs} aria-label="会话层级">
            {ancestry.map((s, i) => {
              const last = i === ancestry.length - 1
              return (
                <span key={s.id} className={css.crumbSeg}>
                  {i > 0 && <span className={css.crumbSep}>/</span>}
                  <button
                    type="button"
                    className={clsx(css.crumb, last && css.crumbCurrent)}
                    disabled={last}
                    onClick={() => { actions.open(s.id) }}
                  >
                    {s.title}
                  </button>
                </span>
              )
            })}
            {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
            <span className={css.meta}>· {turns} turns</span>
          </nav>
          {/* Header button row (Fork / Session log / I/O Details): a P-I visual
              placeholder registry slot is deferred — buttons land with their features. */}
        </div>
        {list.length > 1 && (
          <div className={css.tabs} role="tablist">
            {list.map(v => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.id === active?.id}
                className={clsx(css.tab, v.id === active?.id && css.tabActive)}
                onClick={() => { actions.openView(v.id) }}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className={css.viewArea}>
        {active !== undefined && renderView(active)}
      </div>

      <InputBar
        draft={draft}
        running={running}
        disabled={removed}
        error={error}
        variant="composer"
        onDraftChange={composer.setDraft}
        onSend={composer.send}
        onStop={composer.stop}
      />
    </div>
  )
}

/** Turn count = user message nodes in the window (display meta; exact host count deferred). */
function countTurns(s: { nodes: readonly { kind: string }[] }): number {
  let n = 0
  for (const node of s.nodes) if (node.kind === 'user') n += 1
  return n
}
