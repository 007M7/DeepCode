// ConversationRoot: the conversation slot's skeleton (figma Header 39:27730 +
// Tab_Group + view area + composer). Pure component — everything arrives via
// props: the framework standard kit (useSession/sessionId/useSessions), the
// declared chat store's useStore/actions, the injected business face, and the
// renderSlot share for the declared 'conversation.view' child slot (views are
// slot entries; the active one renders via the list `only` filter).
// Breadcrumbs derive from useSessions with a pure parentId walk; the active
// view id lives in the chat store's `view` field (per-session by store scope).

import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { shallowEqual } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps } from '../contract/slots.ts'
import { InputBar } from './InputBar.tsx'
import type { InputBarError } from './InputBar.tsx'
import css from './ConversationRoot.module.css'

/** Full props = the automatic shares & injected share — composed by reference
 *  from the contract, never re-typed here (share-ownership rule). */
export type ConversationRootProps = ConversationSlotProps

/** Breadcrumb chain: walk parentId links (root ancestor first, self last;
 *  empty when unknown; a broken link stops the walk). Pure twin of the
 *  sessions service's ancestry — components derive, they don't subscribe. */
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

export function ConversationRoot({
  sessionId, useSession, useSessions, useStore, actions, renderSlot,
  views, send, stop, open,
}: ConversationRootProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  // The store's persisted view id may be stale (view plugin unloaded); the
  // slot ledger is the runtime validator — unknown ids fall to the first view.
  const activeId = useStore(s => s.view) ?? 'chat'
  const active = tabs.find(v => v.id === activeId) ?? tabs[0]

  const ancestry = useSessions(s => deriveAncestry(s, sessionId), shallowEqual)
  const draft = useStore(s => s.draft)
  const running = useSession(s => s.running)
  const removed = useSession(s => s.removed)
  const promptError = useSession(s => s.promptError)
  const turns = useSession(s => countTurns(s))

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
                    onClick={() => { open(s.id) }}
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
        {tabs.length > 1 && (
          <div className={css.tabs} role="tablist">
            {tabs.map(v => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.id === active?.id}
                className={clsx(css.tab, v.id === active?.id && css.tabActive)}
                onClick={() => { actions.setView(v.id) }}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className={css.viewArea}>
        {active !== undefined && renderSlot('conversation.view', {}, { only: active.id })}
      </div>

      <InputBar
        draft={draft}
        running={running}
        disabled={removed}
        error={error}
        variant="composer"
        onDraftChange={actions.setDraft}
        onSend={(mode) => { send(draft, mode) }}
        onStop={stop}
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
