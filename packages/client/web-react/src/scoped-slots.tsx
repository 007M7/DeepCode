/**
 * ScopedSlots factory: the sole render surface over the slot registry.
 * renderSlot subscribes through uSES (SlotCore.subscribe/getVersion), renders
 * per slot kind, wraps every entry in an error boundary, and merges props from
 * three sources: standard injection (session slots get useSession), the
 * registrant's cached inject factory, then owner props (owner wins).
 *
 * Typing model (slot type-chain design §4): the key stays generic (`K`) from
 * renderSlot down to the outlet, so `entries<K>()` returns typed entries and
 * the per-entry render path is monomorphic — no existential casts in loops.
 */
import { Component, useSyncExternalStore, type FC, type ReactNode } from 'react'
import type {
  RenderOpts, RootBinding, ScopedSlots, SessionBinding as SlotSessionBinding,
  SlotCore, SlotEntry, SlotMap,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotAssemblyError, useRootBinding, useSessionBinding } from './session-provider.tsx'

type AnyKey = keyof SlotMap & string
type EntryOf<K extends AnyKey> = SlotEntry<SlotMap[K]>
type InjectedProps = Record<string, unknown>

/**
 * Inject results cache: root slots per entry, session slots per (entry x binding).
 * WeakMap keys are the entry objects (stable across entries() snapshots per
 * the SlotCore contract); values are the registrant's injected share. Storage
 * erases the per-entry `I` — the single budgeted cast per cache restores it.
 */
const rootInjectCache = new WeakMap<object, InjectedProps>()
const sessionInjectCache = new WeakMap<object, WeakMap<object, InjectedProps>>()

function cachedRootInject<K extends AnyKey>(entry: EntryOf<K>, binding: RootBinding): InjectedProps {
  const inject = entry.options?.inject
  if (!inject) return {}
  let props = rootInjectCache.get(entry)
  if (!props) {
    // Root-scope factories accept RootBinding; the conditional-type parameter
    // only fails to dispatch because K is generic here — the outlet's
    // spec.scope branch guarantees the scope side (budgeted cast, one per cache).
    props = (inject as (b: RootBinding) => InjectedProps)(binding)
    rootInjectCache.set(entry, props)
  }
  return props
}

function cachedSessionInject<K extends AnyKey>(entry: EntryOf<K>, binding: SlotSessionBinding): InjectedProps {
  const inject = entry.options?.inject
  if (!inject) return {}
  let perBinding = sessionInjectCache.get(entry)
  if (!perBinding) {
    perBinding = new WeakMap()
    sessionInjectCache.set(entry, perBinding)
  }
  let props = perBinding.get(binding)
  if (!props) {
    // Same scope-dispatch note as the root cache: the session branch of the
    // outlet guarantees this factory's binding side (budgeted cast).
    props = (inject as (b: SlotSessionBinding) => InjectedProps)(binding)
    perBinding.set(binding, props)
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

interface OutletProps<K extends AnyKey> {
  core: SlotCore
  slotKey: K
  ownerProps: object
  opts?: RenderOpts | undefined
}

/**
 * One rendered entry: standard injection + cached inject + owner props.
 * Inject factories run inside these component bodies ON PURPOSE — the outlet
 * wraps every Entry element in the per-entry error boundary, so a throwing
 * factory blacks out only its own entry. The three-source merge composes the
 * entry's full props contract; TS cannot prove the composition against
 * `SlotMap[K]['props']` (the shares are erased at the registry boundary), so
 * each Entry renders through a props-widened view of the component — the
 * design-budgeted composition point, one per scope branch.
 */
function SessionEntry<K extends AnyKey>({ entry, ownerProps }: {
  entry: EntryOf<K>; ownerProps: object
}) {
  const binding = useSessionBinding()
  const Comp = entry.component as FC<InjectedProps>
  const injected = cachedSessionInject(entry, binding)
  return <Comp useSession={binding.session.useSelector} {...injected} {...ownerProps} />
}

function RootEntry<K extends AnyKey>({ entry, ownerProps }: {
  entry: EntryOf<K>; ownerProps: object
}) {
  const hasInject = entry.options?.inject !== undefined
  const Comp = entry.component as FC<InjectedProps>
  // Only inject-bearing entries need the root binding channel; plain entries
  // must render fine in shells that never mounted RootBindingProvider.
  if (!hasInject) return <Comp {...ownerProps} />
  return <RootInjectEntry entry={entry} ownerProps={ownerProps} />
}

function RootInjectEntry<K extends AnyKey>({ entry, ownerProps }: {
  entry: EntryOf<K>; ownerProps: object
}) {
  const binding = useRootBinding()
  const Comp = entry.component as FC<InjectedProps>
  const injected = cachedRootInject(entry, binding)
  return <Comp {...injected} {...ownerProps} />
}

function SlotOutlet<K extends AnyKey>({ core, slotKey, ownerProps, opts }: OutletProps<K>) {
  // Version tick drives entries() re-read; SlotCore batches per microtask.
  useSyncExternalStore(
    (fn) => core.subscribe(slotKey, fn),
    () => core.getVersion(slotKey),
  )
  const spec = core.spec(slotKey)
  if (!spec) throw new Error(`renderSlot('${slotKey}') before define`)
  const entries = core.entries(slotKey)
  const Entry: FC<{ entry: EntryOf<K>; ownerProps: object }> =
    spec.scope === 'session' ? SessionEntry : RootEntry

  // The boundary must wrap the Entry ELEMENT, not live inside it: inject
  // factories and binding lookups run in the Entry body and must land in the
  // per-entry fallback rather than escaping to the tree above.
  const guarded = (entry: EntryOf<K>, key?: string | number) => (
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
    const entry = entries.find((e) => e.options && 'key' in e.options && e.options.key === opts?.entryKey)
    if (!entry) return <>{opts?.fallback ?? null}</>
    return guarded(entry)
  }
  // list: registration order refined by explicit order, optional id filter.
  const withListOptions = entries.map((entry) => ({
    entry,
    id: entry.options && 'id' in entry.options ? entry.options.id : undefined,
    order: entry.options && 'order' in entry.options ? entry.options.order ?? 0 : 0,
  }))
  let list = [...withListOptions].sort((a, b) => a.order - b.order)
  if (opts?.only !== undefined) list = list.filter((item) => item.id === opts.only)
  if (list.length === 0) return <>{opts?.fallback ?? null}</>
  return <>{list.map((item, i) => guarded(item.entry, item.id ?? i))}</>
}

/**
 * Build a whitelist-narrowed ScopedSlots render surface over a SlotCore.
 * The type parameter narrows compile-time access; the runtime whitelist
 * backstops plain-JS callers.
 * @param core - the slot registry core.
 * @param keys - whitelisted slot keys the caller may render.
 * @returns the ScopedSlots facade.
 */
export function scopedSlots<K extends AnyKey>(core: SlotCore, ...keys: K[]): ScopedSlots<K> {
  const allowed = new Set<string>(keys)
  return {
    renderSlot(key, props, opts) {
      if (!allowed.has(key)) throw new Error(`slot '${key}' is not in this ScopedSlots whitelist`)
      return <SlotOutlet core={core} slotKey={key} ownerProps={props} opts={opts} />
    },
  }
}
