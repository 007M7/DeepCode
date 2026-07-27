/**
 * React renderer for declarative slots. Per-entry bindings enforce child
 * authorization, and entry boundaries contain registrant failures.
 */
import { Component, useSyncExternalStore, type FC, type ReactNode } from 'react'
import {
  SlotOwnershipError, StaleAuthorizationError,
  type ChainRenderOpts, type RenderOpts, type SessionMaybeProvideInfo, type SessionProvideInfo,
  type SlotRenderer, type SlotRendererHost, type SlotScope, type StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  HostContext, SessionMaybeProvider, SessionProvider, SlotAssemblyError, maybeObservableHook,
  observableHook, useHost, useSessionMaybeProvideInfo,
} from './session-provider.tsx'

type InjectedProps = Record<string, unknown>

type RenderSlotBinding = (key: string, owner: object, opts?: RenderOpts) => ReactNode

type RenderSlotChainBinding = (key: string, owner: object, opts?: ChainRenderOpts) => ReactNode

/**
 * Per-entry renderSlot bindings. The binding is identity-stable per entry
 * (memoized components must not resubscribe on unrelated re-renders) and dies
 * with the entry: a retained closure calling after the entry's disposal hits
 * the in-ledger check and throws.
 */
const renderSlotCache = new WeakMap<StoredEntry, RenderSlotBinding>()

function boundRenderSlot(host: SlotRendererHost, entry: StoredEntry): RenderSlotBinding {
  let binding = renderSlotCache.get(entry)
  if (!binding) {
    binding = (key, owner, opts) => {
      if (!host.isLive(entry)) {
        throw new StaleAuthorizationError(`renderSlot('${key}') from a disposed registration`)
      }
      // Plain-JS backstop; typed callers are narrowed to the declared keys.
      const declared = entry.children?.[key]
      if (declared === undefined) {
        throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`)
      }
      if (declared.kind === 'chain') {
        throw new SlotOwnershipError(`slot '${key}' is declared 'chain' — use renderSlotChain`)
      }
      return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
    }
    renderSlotCache.set(entry, binding)
  }
  return binding
}

/**
 * Per-entry renderSlotChain bindings: identity-stable per entry (same cache
 * axis as renderSlot — a per-frame dispatch must not rebuild the binding) and
 * dead with the entry. The chain-kind check is the plain-JS backstop twin of
 * the declaration check; typed callers are narrowed to chain keys.
 */
const renderSlotChainCache = new WeakMap<StoredEntry, RenderSlotChainBinding>()

function boundRenderSlotChain(host: SlotRendererHost, entry: StoredEntry): RenderSlotChainBinding {
  let binding = renderSlotChainCache.get(entry)
  if (!binding) {
    binding = (key, owner, opts) => {
      if (!host.isLive(entry)) {
        throw new StaleAuthorizationError(`renderSlotChain('${key}') from a disposed registration`)
      }
      const declared = entry.children?.[key]
      if (declared === undefined) {
        throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`)
      }
      if (declared.kind !== 'chain') {
        throw new SlotOwnershipError(`slot '${key}' is declared '${declared.kind}', not 'chain' — use renderSlot`)
      }
      return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
    }
    renderSlotChainCache.set(entry, binding)
  }
  return binding
}

/**
 * Inject results cache: root entries per entry, session entries per
 * (entry x provide bundle). WeakMap keys are entry/info objects (both
 * identity-stable per registration/session scope), so cache lifetime rides
 * the same axes as the values it memoizes.
 */
const rootInjectCache = new WeakMap<StoredEntry, InjectedProps>()
const sessionInjectCache = new WeakMap<StoredEntry, WeakMap<SessionProvideInfo, InjectedProps>>()
const sessionMaybeInjectCache = new WeakMap<StoredEntry, WeakMap<SessionMaybeProvideInfo, InjectedProps>>()

function runInject(entry: StoredEntry, info: SessionMaybeProvideInfo | undefined, actions: object | undefined): InjectedProps {
  const inject = entry.inject
  if (!inject) return {}
  // Declaration-derived positional arguments: sessionId for session scope,
  // baked actions when a store is declared.
  const args: unknown[] = []
  if (info !== undefined) args.push(info.sessionId)
  if (actions !== undefined) args.push(actions)
  return (inject as (...args: unknown[]) => InjectedProps)(...args)
}

function cachedRootInject(entry: StoredEntry, actions: object | undefined): InjectedProps {
  let props = rootInjectCache.get(entry)
  if (!props) {
    props = runInject(entry, undefined, actions)
    rootInjectCache.set(entry, props)
  }
  return props
}

function cachedSessionInject(entry: StoredEntry, info: SessionProvideInfo, actions: object | undefined): InjectedProps {
  let perInfo = sessionInjectCache.get(entry)
  if (!perInfo) {
    perInfo = new WeakMap()
    sessionInjectCache.set(entry, perInfo)
  }
  let props = perInfo.get(info)
  if (!props) {
    props = runInject(entry, info, actions)
    perInfo.set(info, props)
  }
  return props
}

function cachedSessionMaybeInject(
  entry: StoredEntry,
  info: SessionMaybeProvideInfo,
  actions: object | undefined,
): InjectedProps {
  let perInfo = sessionMaybeInjectCache.get(entry)
  if (!perInfo) {
    perInfo = new WeakMap()
    sessionMaybeInjectCache.set(entry, perInfo)
  }
  let props = perInfo.get(info)
  if (!props) {
    props = runInject(entry, info, actions)
    perInfo.set(info, props)
  }
  return props
}

/**
 * Entry-identity React keys for chain boundaries. A chain outlet renders ONE
 * elected entry through an error boundary; without a key, a boundary that
 * failed on entry A would survive a re-election and keep a healthy entry B
 * blacked out. Keying by entry identity remounts the boundary fresh whenever
 * the election changes (entries are identity-stable per registration, so the
 * key is stable while the same entry stays elected).
 */
let nextEntryKey = 0
const entryKeys = new WeakMap<StoredEntry, number>()

function entryKeyOf(entry: StoredEntry): number {
  let key = entryKeys.get(entry)
  if (key === undefined) {
    key = nextEntryKey++
    entryKeys.set(entry, key)
  }
  return key
}

/**
 * Per-entry isolation: one registrant crashing (component render or inject
 * factory) must not take down siblings. Assembly errors (missing providers)
 * rethrow — a miswired shell must fail loud, not degrade into fallbacks.
 */
class SlotErrorBoundary extends Component<
  { slotKey: string; children: ReactNode }, { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(error: unknown): { failed: boolean } {
    if (error instanceof SlotAssemblyError) throw error
    return { failed: true }
  }
  override componentDidCatch(error: unknown): void {
    console.error(`slot entry crashed in '${this.props.slotKey}':`, error)
  }
  override render(): ReactNode {
    if (this.state.failed) return <div data-slot-error={this.props.slotKey} />
    return this.props.children
  }
}

/**
 * Standard-kit synthesis shared by both scope branches: the global
 * useSessions/useWorkspaces hooks, the per-session provide bundle (every
 * `hooks` source becomes a `use<Name>` selector hook — useSession is the
 * runtime's own 'session' contribution, no special case — and `props` spread
 * verbatim), the store pair when declared, the renderSlot binding when
 * children are declared, and the SessionProvider seat when the children
 * declare a session-scope slot. Hosts hand out BARE observable sources
 * (hooks never cross the host contract); every hook is bound HERE, cached
 * per source (observableHook), so spreading a fresh kit object per render
 * never churns child subscriptions.
 */
function standardKit(
  host: SlotRendererHost,
  entry: StoredEntry,
  scope: SlotScope,
  info: SessionMaybeProvideInfo | undefined,
): {
  kit: InjectedProps
  actions: object | undefined
} {
  const kit: InjectedProps = {
    useSessions: observableHook(host.sessions.list),
    useWorkspaces: observableHook(host.workspaces.list),
  }
  if (scope !== 'root' && info !== undefined) {
    for (const [name, source] of Object.entries(info.hooks)) {
      const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
      if (scope === 'session-maybe') {
        kit[hookName] = maybeObservableHook(source)
      } else {
        if (source === undefined) throw new SlotAssemblyError(`strict session hook '${name}' has no source`)
        kit[hookName] = observableHook(source)
      }
    }
    Object.assign(kit, info.props)
    kit['sessionId'] = info.sessionId
  }
  const store = scope === 'session-maybe' && info?.sessionId === undefined
    ? undefined
    : host.storeOf(entry, info?.sessionId)
  if (store !== undefined) {
    // The instance IS an observable snapshot source (contract getSnapshot/
    // subscribe); the useStore hook binds here, cached per instance.
    kit['useStore'] = observableHook(store)
    kit['actions'] = store.actions
  }
  if (entry.children !== undefined) {
    kit['renderSlot'] = boundRenderSlot(host, entry)
    // renderSlotChain rides the same declaration source: only entries whose
    // children include a chain-kind slot receive the chain dispatch seat.
    if (Object.values(entry.children).some(spec => spec.kind === 'chain')) {
      kit['renderSlotChain'] = boundRenderSlotChain(host, entry)
    }
    // SessionProvider standard seat: entries declaring a session-scope child
    // render the session area, so the framework hands them the self-wired
    // provider (module-level component = stable reference; no value import).
    if (Object.values(entry.children).some(spec => spec.scope === 'session')) {
      kit['SessionProvider'] = SessionProvider
    }
  }
  return { kit, actions: store?.actions }
}

/**
 * One rendered entry: standard kit + cached inject + owner props (owner
 * wins). The kit and injected shares are erased at the render boundary — the
 * register seam already proved the composed contract — so each Entry renders
 * through a props-widened view of the component (the design-budgeted
 * composition point, one per scope branch).
 */
function SessionEntry({ entry, ownerProps, info }: {
  entry: StoredEntry
  ownerProps: object
  info: SessionProvideInfo
}) {
  const host = useHost()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, actions } = standardKit(host, entry, 'session', info)
  const injected = cachedSessionInject(entry, info, actions)
  return <Comp {...kit} {...injected} {...ownerProps} />
}

function SessionMaybeEntry({ entry, ownerProps }: { entry: StoredEntry; ownerProps: object }) {
  const host = useHost()
  const info = useSessionMaybeProvideInfo()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, actions } = standardKit(host, entry, 'session-maybe', info)
  const injected = cachedSessionMaybeInject(entry, info, actions)
  return <Comp {...kit} {...injected} {...ownerProps} />
}

function RootEntry({ entry, ownerProps }: { entry: StoredEntry; ownerProps: object }) {
  const host = useHost()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, actions } = standardKit(host, entry, 'root', undefined)
  const injected = cachedRootInject(entry, actions)
  return <Comp {...kit} {...injected} {...ownerProps} />
}

function StrictSessionEntry({ slotKey, entry, ownerProps }: {
  slotKey: string
  entry: StoredEntry
  ownerProps: object
}) {
  const info = useSessionMaybeProvideInfo()
  if (info.sessionId === undefined) return null
  return (
    <SlotErrorBoundary slotKey={slotKey} key={info.sessionId}>
      <SessionEntry entry={entry} ownerProps={ownerProps} info={info as SessionProvideInfo} />
    </SlotErrorBoundary>
  )
}

function SlotOutlet({ slotKey, ownerProps, opts }: {
  slotKey: string
  ownerProps: object
  opts?: (RenderOpts & ChainRenderOpts) | undefined
}) {
  const host = useHost()
  // Version tick drives entries() re-read; the host batches per microtask.
  useSyncExternalStore(
    fn => host.subscribe(slotKey, fn),
    () => host.getVersion(slotKey),
  )
  const sessionInfo = useSessionMaybeProvideInfo()
  const spec = host.specOf(slotKey)
  // Undeclared (or no-longer-declared) keys render empty: a declaring entry's
  // unload returns the slot to the undeclared state while retained elements
  // may still be mounted — natural empty, not an ownership failure (§9).
  if (!spec) return null
  const strictSessionAbsent = spec.scope === 'session' && sessionInfo.sessionId === undefined
  if (strictSessionAbsent && (spec.kind !== 'chain' || !opts?.overlay)) {
    return <>{opts?.fallback ?? null}</>
  }
  // An absent strict overlay chain follows its ordinary empty-election path,
  // preserving the Fragment/fallback-wrapper shape across session arrival.
  const entries = strictSessionAbsent ? [] : host.entriesOf(slotKey)

  // The boundary must wrap the Entry ELEMENT, not live inside it: inject
  // factories and kit synthesis run in the Entry body and must land in the
  // per-entry fallback rather than escaping to the tree above.
  const guarded = (entry: StoredEntry, key?: string | number, owner: object = ownerProps) => (
    spec.scope === 'session'
      ? <StrictSessionEntry slotKey={slotKey} entry={entry} ownerProps={owner} key={key} />
      : (
        <SlotErrorBoundary slotKey={slotKey} key={key}>
          {spec.scope === 'session-maybe'
            ? <SessionMaybeEntry entry={entry} ownerProps={owner} />
            : <RootEntry entry={entry} ownerProps={owner} />}
        </SlotErrorBoundary>
      )
  )

  if (spec.kind === 'single') {
    const entry = entries[0]
    if (!entry) return <>{opts?.fallback ?? null}</>
    return guarded(entry)
  }
  if (spec.kind === 'keyed') {
    const entry = entries.find(e => e.options.key === opts?.entryKey)
    if (!entry) return <>{opts?.fallback ?? null}</>
    return guarded(entry)
  }
  if (spec.kind === 'chain') {
    // Entries arrive priority-sorted from the ledger (the core orders at
    // register, ties keep registration sequence). Selectors are pure
    // functions of the owner props (register-face contract), so the routing
    // pass runs per render with zero mount side effects: the first non-null
    // election renders, decliners never mount.
    let elected: ReactNode = null
    for (const entry of entries) {
      let matched: unknown
      try {
        // Chain entries always carry select (SlotCore register validation).
        matched = (entry.select as (owner: object) => unknown)(ownerProps)
      } catch (error) {
        // A throwing selector is a registrant contract breach (select MUST be
        // pure and total), but it runs before the entry's SlotErrorBoundary
        // exists — uncontained it would black out the whole owner region. So
        // it degrades to a decline: the chain and the fallback stay intact,
        // and the breach is reported like a crashed entry.
        console.error(
          `chain selector crashed in '${slotKey}' (${entry.registrant ?? 'unknown registrant'}), treating as declined:`,
          error)
        continue
      }
      if (matched !== null) {
        elected = guarded(entry, entryKeyOf(entry), { ...ownerProps, matched })
        break
      }
    }
    if (opts?.overlay) {
      // Overlay chain (ChainRenderOpts.overlay): the fallback stays mounted
      // through elections — hidden via inline display:none (decisive over any
      // author CSS), shown via display:contents so the wrapper never affects
      // the owner's layout. The wrapper's tree position is constant, so React
      // reconciles instead of remounting and fallback state survives takeover.
      return (
        <>
          <div
            data-chain-overlay-fallback={slotKey}
            style={{ display: elected === null ? 'contents' : 'none' }}
          >
            {opts.fallback ?? null}
          </div>
          {elected}
        </>
      )
    }
    return elected ?? <>{opts?.fallback ?? null}</>
  }
  // list: registration order refined by explicit order, optional id filter.
  const withListOptions = entries.map(entry => ({
    entry,
    id: entry.options.id,
    order: entry.options.order ?? 0,
  }))
  let list = [...withListOptions].sort((a, b) => a.order - b.order)
  if (opts?.only !== undefined) list = list.filter(item => item.id === opts.only)
  if (list.length === 0) return <>{opts?.fallback ?? null}</>
  return <>{list.map((item, i) => guarded(item.entry, item.id ?? i))}</>
}

/** Root outlet: the shell's single ctx-level render entry — an unregistered 'root' is a boot-order failure, never a silent blank (§1). */
function RootOutlet({ ownerProps }: { ownerProps: object }) {
  const host = useHost()
  useSyncExternalStore(
    fn => host.subscribe('root', fn),
    () => host.getVersion('root'),
  )
  const entry = host.entriesOf('root')[0]
  if (!entry) throw new SlotAssemblyError("renderSlot('root') before any 'root' registration (boot order)")
  return (
    <SlotErrorBoundary slotKey="root">
      <RootEntry entry={entry} ownerProps={ownerProps} />
    </SlotErrorBoundary>
  )
}

/**
 * Build the renderer the shell installs into the runtime SlotsService
 * (ctx.slots.install(createSlotRenderer()) at boot; the service owns the
 * install/renderSlot seam and the double-install/not-installed throws).
 * @returns the renderer.
 */
export function createSlotRenderer(): SlotRenderer {
  return {
    renderRoot(host, ownerProps) {
      return (
        <HostContext.Provider value={host}>
          <SessionMaybeProvider>
            <RootOutlet ownerProps={ownerProps} />
          </SessionMaybeProvider>
        </HostContext.Provider>
      )
    },
  }
}
