/**
 * createSlotRenderer(): the outlet machinery behind the runtime install seam
 * (slot terminal design §8). renderRoot mounts the host channel and renders
 * the built-in 'root' key; every deeper slot renders through a per-entry
 * renderSlot binding synthesized from the entry's children declaration.
 * Standard-kit synthesis per entry: the global useSessions hook, the session
 * pair (useSession + sessionId) under SessionProvider, the store pair
 * (useStore + actions) for store-declaring entries, and the renderSlot
 * binding (entry-identity bound, stale-checked) for children-declaring
 * entries. Inject factories run inside the entry component bodies ON PURPOSE
 * — the per-entry error boundary contains a throwing factory to its own
 * entry; parameters follow the declaration (sessionId for session slots,
 * baked actions when a store is declared).
 */
import { Component, useSyncExternalStore, type FC, type ReactNode } from 'react'
import {
  SlotOwnershipError, StaleAuthorizationError,
  type RenderOpts, type SessionCell, type SlotRenderer, type SlotRendererHost,
  type StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  HostContext, SessionProvider, SlotAssemblyError, observableHook, useHost, useSessionCell,
} from './session-provider.tsx'

type InjectedProps = Record<string, unknown>

/** Owner-facing renderSlot binding shape (typed narrowing lands on the wave-1 props seam). */
type RenderSlotBinding = (key: string, owner: object, opts?: RenderOpts) => ReactNode

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
      if (entry.children?.[key] === undefined) {
        throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`)
      }
      return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
    }
    renderSlotCache.set(entry, binding)
  }
  return binding
}

/**
 * Inject results cache: root entries per entry, session entries per
 * (entry x session cell). WeakMap keys are entry/cell objects (both
 * identity-stable per registration/session scope), so cache lifetime rides
 * the same axes as the values it memoizes.
 */
const rootInjectCache = new WeakMap<StoredEntry, InjectedProps>()
const sessionInjectCache = new WeakMap<StoredEntry, WeakMap<SessionCell, InjectedProps>>()

function runInject(entry: StoredEntry, cell: SessionCell | undefined, actions: object | undefined): InjectedProps {
  const inject = entry.inject
  if (!inject) return {}
  // Declaration-derived positional arguments: sessionId for session scope,
  // baked actions when a store is declared.
  const args: unknown[] = []
  if (cell !== undefined) args.push(cell.sessionId)
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

function cachedSessionInject(entry: StoredEntry, cell: SessionCell, actions: object | undefined): InjectedProps {
  let perCell = sessionInjectCache.get(entry)
  if (!perCell) {
    perCell = new WeakMap()
    sessionInjectCache.set(entry, perCell)
  }
  let props = perCell.get(cell)
  if (!props) {
    props = runInject(entry, cell, actions)
    perCell.set(cell, props)
  }
  return props
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
 * useSessions hook, the session pair, the store pair when declared, the
 * renderSlot binding when children are declared, and the SessionProvider
 * seat when the children declare a session-scope slot. Hosts hand out BARE
 * observable sources (hooks never cross the host contract); every hook is
 * bound HERE, cached per source (observableHook), so spreading a fresh kit
 * object per render never churns child subscriptions.
 */
function standardKit(host: SlotRendererHost, entry: StoredEntry, cell: SessionCell | undefined): {
  kit: InjectedProps; actions: object | undefined
} {
  const kit: InjectedProps = { useSessions: observableHook(host.sessions.list) }
  if (cell !== undefined) {
    kit['useSession'] = observableHook(cell.session)
    kit['sessionId'] = cell.sessionId
  }
  const store = host.storeOf(entry, cell?.sessionId)
  if (store !== undefined) {
    // The instance IS an observable snapshot source (contract getSnapshot/
    // subscribe); the useStore hook binds here, cached per instance.
    kit['useStore'] = observableHook(store)
    kit['actions'] = store.actions
  }
  if (entry.children !== undefined) {
    kit['renderSlot'] = boundRenderSlot(host, entry)
    // SessionProvider standard seat: entries declaring a session-scope child
    // render the session area, so the framework hands them the self-wired
    // provider (module-level component = stable reference; no value import).
    if (Object.values(entry.children).some((spec) => spec.scope === 'session')) {
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
function SessionEntry({ entry, ownerProps }: { entry: StoredEntry; ownerProps: object }) {
  const host = useHost()
  const cell = useSessionCell()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, actions } = standardKit(host, entry, cell)
  const injected = cachedSessionInject(entry, cell, actions)
  return <Comp {...kit} {...injected} {...ownerProps} />
}

function RootEntry({ entry, ownerProps }: { entry: StoredEntry; ownerProps: object }) {
  const host = useHost()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, actions } = standardKit(host, entry, undefined)
  const injected = cachedRootInject(entry, actions)
  return <Comp {...kit} {...injected} {...ownerProps} />
}

function SlotOutlet({ slotKey, ownerProps, opts }: {
  slotKey: string; ownerProps: object; opts?: RenderOpts | undefined
}) {
  const host = useHost()
  // Version tick drives entries() re-read; the host batches per microtask.
  useSyncExternalStore(
    (fn) => host.subscribe(slotKey, fn),
    () => host.getVersion(slotKey),
  )
  const spec = host.specOf(slotKey)
  // Undeclared (or no-longer-declared) keys render empty: a declaring entry's
  // unload returns the slot to the undeclared state while retained elements
  // may still be mounted — natural empty, not an ownership failure (§9).
  if (!spec) return null
  const entries = host.entriesOf(slotKey)
  const Entry = spec.scope === 'session' ? SessionEntry : RootEntry

  // The boundary must wrap the Entry ELEMENT, not live inside it: inject
  // factories and kit synthesis run in the Entry body and must land in the
  // per-entry fallback rather than escaping to the tree above.
  const guarded = (entry: StoredEntry, key?: string | number) => (
    <SlotErrorBoundary slotKey={slotKey} key={key}>
      <Entry entry={entry} ownerProps={ownerProps} />
    </SlotErrorBoundary>
  )

  if (spec.kind === 'single') {
    const entry = entries[0]
    if (!entry) return <>{opts?.fallback ?? null}</>
    return guarded(entry)
  }
  if (spec.kind === 'keyed') {
    const entry = entries.find((e) => e.options?.key === opts?.entryKey)
    if (!entry) return <>{opts?.fallback ?? null}</>
    return guarded(entry)
  }
  // list: registration order refined by explicit order, optional id filter.
  const withListOptions = entries.map((entry) => ({
    entry,
    id: entry.options?.id,
    order: entry.options?.order ?? 0,
  }))
  let list = [...withListOptions].sort((a, b) => a.order - b.order)
  if (opts?.only !== undefined) list = list.filter((item) => item.id === opts.only)
  if (list.length === 0) return <>{opts?.fallback ?? null}</>
  return <>{list.map((item, i) => guarded(item.entry, item.id ?? i))}</>
}

/** Root outlet: the shell's single ctx-level render entry — an unregistered 'root' is a boot-order failure, never a silent blank (§1). */
function RootOutlet({ ownerProps }: { ownerProps: object }) {
  const host = useHost()
  useSyncExternalStore(
    (fn) => host.subscribe('root', fn),
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
          <RootOutlet ownerProps={ownerProps} />
        </HostContext.Provider>
      )
    },
  }
}
