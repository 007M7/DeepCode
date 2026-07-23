// ConversationRoot: the conversation slot's skeleton (figma Header 39:27730 +
// Tab_Group + view area + composer). Pure component — everything arrives via
// props: the framework standard kit (useSession/sessionId/useSessions), the
// declared chat store's useStore/actions, and the injected business face.
// Breadcrumbs derive from useSessions with a pure parentId walk; the active
// view id lives in the chat store's `view` field (per-session by store scope).

import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { shallowEqual } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps } from '../contract/slots.ts'
import type { ConvViewProps, ViewEntry } from '../contract/views.ts'
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
  sessionId, useSession, useSessions, useStore, actions,
  views, send, stop, openDetails, loadOlder, open,
}: ConversationRootProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const list = views.list()
  // The store's persisted view id may be stale (view plugin unloaded); the
  // registry is the runtime validator — unknown ids fall to the first view.
  const activeId = useStore(s => s.view) ?? 'chat'
  const active = list.find(v => v.id === activeId) ?? list[0]

  const ancestry = useSessions(s => deriveAncestry(s, sessionId), shallowEqual)
  const draft = useStore(s => s.draft)
  const running = useSession(s => s.running)
  const removed = useSession(s => s.removed)
  const promptError = useSession(s => s.promptError)
  const turns = useSession(s => countTurns(s))

  const error: InputBarError | null = promptError === null
    ? null
    : { op: promptError.op, message: `${promptError.error.message}（${promptError.error.code}）` }

  // Views receive the shares this component already holds (hook transfer is
  // plain props passing); the callback slice is referentially stable per
  // injected identity so memoized view rows hold.
  const viewProps = useMemo<ConvViewProps>(() => ({
    sessionId, useSession, useStore,
    actions: { openDetails, loadOlder },
  }), [sessionId, useSession, useStore, openDetails, loadOlder])

  const renderView = (entry: ViewEntry): ReactNode => {
    const Header = entry.chrome?.header
    const Footer = entry.chrome?.footer
    const View = entry.component
    return (
      <>
        {Header !== undefined && <Header sessionId={sessionId} useSession={useSession} />}
        <View {...viewProps} />
        {Footer !== undefined && <Footer sessionId={sessionId} useSession={useSession} />}
      </>
    )
  }

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
        {list.length > 1 && (
          <div className={css.tabs} role="tablist">
            {list.map(v => (
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
        {active !== undefined && renderView(active)}
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
