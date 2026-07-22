/**
 * Client plugin body: provide the conversation service and toolview registry,
 * register the conversation/details slot occupants and the no-session empty
 * state, and mount the chat view with its samples. Assembly only — components
 * receive everything through inject factories; nothing here renders directly.
 */
import { createElement, Fragment, type ReactNode } from 'react'
import type { Context } from 'cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { scopedSlots, shallowEqual } from '@deepseek-ai/dsh-client-web-react'
import type { SnapshotSelectorHook, UseSession } from '@deepseek-ai/dsh-client-web-react'
import type {
  SessionId, SessionListState, SessionsService, SlotsService,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { LayoutService } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { I18nService } from '@deepseek-ai/dsh-client-i18n/client'
import type { ConvViewProps, SelectionTarget, ViewEntry, ViewId } from './contract/views.ts'
import type { ConversationInjected, DetailsInjected, EmptyStateInjected } from './contract/slots.ts'
import { ConversationService } from './service.ts'
import { ToolViewRegistry } from './toolviews/registry.ts'
import { childSessionScope, registerChat } from './chat/register.ts'
import { registerBashSamples } from './toolviews/bash-sample.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { DetailsPanel } from './skeleton/DetailsPanel.tsx'
import { EmptyState } from './skeleton/EmptyState.tsx'

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots', 'layout', 'sessions', 'i18n']

/** Resolve a service via ctx.get, failing loud. Property access is reserved
 *  for contexts whose fiber declares the inject (scope fibers do not). */
// T is the caller-named cast target; inlining `as T` per call site would scatter the budgeted cast.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function need<T>(ctx: Context, name: string): T {
  const value = ctx.get(name) as T | undefined
  if (value === undefined) throw new Error(`ui-conversation: ${name} service unavailable`)
  return value
}

/** Per-list-state cwd set (deduped, list order) for the empty-state picker. */
const cwdsCache = new WeakMap<SessionListState, readonly string[]>()
function cwdsOf(state: SessionListState): readonly string[] {
  let cached = cwdsCache.get(state)
  if (cached === undefined) {
    const seen = new Set<string>()
    for (const id of state.ids) {
      const cwd = state.byId[id]?.cwd
      if (cwd !== undefined && cwd !== '') seen.add(cwd)
    }
    cached = [...seen]
    cwdsCache.set(state, cached)
  }
  return cached
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const sessions = need<SessionsService>(ctx, 'sessions')
  const layout = need<LayoutService>(ctx, 'layout')
  const i18n = need<I18nService>(ctx, 'i18n')
  const slots = need<SlotsService>(ctx, 'slots')

  const conversation = new ConversationService(ctx)
  const toolviews = new ToolViewRegistry()
  ctx.provide('toolviews', toolviews)

  const t = i18n.bind('conversation')
  // Chat view + StatsLine footer; bash samples assembled here (apply is the
  // only cross-domain point — chat consumes the resolver face, samples come
  // from the toolviews domain). registerView inside registerChat is already
  // effect-scoped; the raw sample registrations need the effect wrapper to
  // ride the fiber cascade.
  ctx.effect(
    () => registerChat({ conversation, toolviews, t }),
    'ui-conversation: chat view')
  ctx.effect(
    () => registerBashSamples(toolviews, childSessionScope(sessions.list)),
    'ui-conversation: bash toolview samples')

  // ConvViewProps.slots is ScopedSlots<never>: a real outlet with an empty
  // whitelist (uncallable by type, correct runtime shape for future grants).
  const emptySlots = scopedSlots<never>(slots.core)

  /** conversation slot: skeleton surface assembled once per (entry x session). */
  const conversationInject = (b: SessionBinding): ConversationInjected => {
    const bctx = b.ctx as Context
    const scoped = need<ConversationService>(bctx, 'conversation')
    const id = b.sessionId as SessionId
    const useSession = b.session.useSelector as UseSession
    const selectionStore = scoped.selection
    const draftsStore = scoped.drafts
    const session = sessions.manager.get(id)
    // Watch-driven history pull: assembling the surface IS the watch signal
    // (once per entry x session; open() is idempotent and self-recovers).
    void session.open()

    const viewProps: Omit<ConvViewProps, 'slots'> = {
      sessionId: id,
      useSession,
      useSelection: selectionStore.useSelector,
      actions: {
        openDetails: (target: SelectionTarget) => { scoped.openDetails(target) },
        loadOlder: () => { void session.loadOlder() },
      },
    }

    const injected: ConversationInjected = {
      useAncestry: () => sessions.list.useSelector(
        () => sessions.ancestry(id),
        (a, b) => shallowEqual(a, b)),
      views: {
        list: () => conversation.views(),
        subscribe: fn => conversation.subscribeViews(fn),
        version: () => conversation.viewsVersion(),
      },
      // layout's viewFor value type is its own looser ViewId; the registry is
      // the runtime validator (unknown ids fall back to the first view).
      useActiveView: () => layout.current.useSelector(s => s.viewFor[id]) as ViewId | undefined,
      composer: {
        useDraft: () => draftsStore.useSelector(s => s),
        setDraft: (text) => { draftsStore.set(text) },
        send: (mode) => {
          const text = draftsStore.getSnapshot().trim()
          if (text === '') return
          // Optimistic clear with failure restore (choreography lives with the
          // sender; the business failure also lands in snapshot.promptError).
          draftsStore.set('')
          void scoped.send(text, mode).catch(() => {
            if (draftsStore.getSnapshot() === '') draftsStore.set(text)
          })
        },
        stop: () => {
          scoped.cancel().catch(() => {
            // Stop failure surfaces via snapshot.promptError; nothing to restore.
          })
        },
      },
      actions: {
        openView: (view: ViewId) => { layout.openView(id, view) },
        open: (target: SessionId) => { layout.open(target) },
      },
      renderView: (entry: ViewEntry): ReactNode => {
        const children: ReactNode[] = []
        if (entry.chrome?.header !== undefined) {
          children.push(createElement(entry.chrome.header, { key: 'header', sessionId: id, useSession }))
        }
        children.push(createElement(entry.component, { key: 'view', ...viewProps, slots: emptySlots }))
        if (entry.chrome?.footer !== undefined) {
          children.push(createElement(entry.chrome.footer, { key: 'footer', sessionId: id, useSession }))
        }
        return createElement(Fragment, null, ...children)
      },
    }
    return injected
  }

  /** details slot: minimal selection-driven panel. */
  const detailsInject = (b: SessionBinding): DetailsInjected => {
    const bctx = b.ctx as Context
    const scoped = need<ConversationService>(bctx, 'conversation')
    const injected: DetailsInjected = {
      useSelection: scoped.selection.useSelector,
      actions: { closeDetails: () => { layout.closeDetails() } },
    }
    return injected
  }

  /** conversation.empty root slot: the NEW SESSION hero. */
  const emptyInject = (): EmptyStateInjected => {
    const useCwds: SnapshotSelectorHook<readonly string[]> = (sel, eq) =>
      sessions.list.useSelector(s => sel(cwdsOf(s)), eq)
    const injected: EmptyStateInjected = {
      useCwds,
      actions: { startSession: opts => conversation.startSession(opts) },
    }
    return injected
  }

  slots.register('conversation', ConversationRoot, { inject: conversationInject })
  slots.register('details', DetailsPanel, { inject: detailsInject })
  slots.register('conversation.empty', EmptyState, { inject: emptyInject })
}
