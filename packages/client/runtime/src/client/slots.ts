/**
 * SlotsService: cordis Service wrapper over the pure SlotCore (ui-slots).
 * Every mutation re-emits as the 'slots/changed' cordis event; define/register
 * run through the caller's ctx.effect so a plugin's registrations are
 * collected when its fiber unloads (cordis-native cascade).
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents --
 * `keyof SlotMap & string` is the declare-merge key pattern: SlotMap is empty
 * in this compilation unit (intersection reads `never`) but consumers merge
 * keys in; the rule fires on the empty-map view, not on real redundancy. */
import { Service } from 'cordis'
import type { Context } from 'cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposedProps, RegisterArgs, SlotComponent, SlotEntry, SlotEntryDef, SlotMap, SlotSpec } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from './index.ts'

/** cordis Service wrapper over the pure SlotCore; mutations re-emit as 'slots/changed'. */
export class SlotsService extends Service {
  private readonly _core = new SlotCore()

  /**
   * @param ctx - owning root context.
   */
  constructor(ctx: Context) {
    super(ctx, 'slots')
    this._core.onMutate((key) => { ctx.emit('slots/changed', key) })
  }

  /**
   * Record a slot spec (delegates to SlotCore.define; disposal follows the caller's fiber).
   * @param key - SlotMap key.
   * @param spec - kind/scope spec.
   * @returns disposer.
   */
  define<K extends keyof SlotMap & string>(key: K, spec: SlotSpec<SlotMap[K]>): () => void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(() => this._core.define(key, spec), 'slots.define()')
  }

  /**
   * Contribute a component (delegates to SlotCore.register; disposal follows the caller's fiber).
   * @param key - SlotMap key.
   * @param component - contributed component.
   * @param args - kind-shaped options (mandatory for keyed/list kinds); the
   * inject factory's binding is pinned to ClientContext.
   * @returns disposer.
   */
  register<K extends keyof SlotMap & string, I extends object = Record<string, unknown>>(
    // Client-context registrations have exactly one ctx shape: pin Ctx to
    // ClientContext so inject factories dot services without a cast.
    key: K, component: SlotComponent<ComposedProps<K, NoInfer<I>>>,
    ...args: RegisterArgs<SlotMap[K], I, ClientContext>): () => void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(() => this._core.register<K, I, ClientContext>(key, component, ...args), 'slots.register()')
  }

  /**
   * Snapshot entries for a key.
   * @param key - SlotMap key.
   * @returns registered entries (stable reference between mutations).
   */
  entries<K extends keyof SlotMap & string>(key: K): readonly SlotEntry<SlotMap[K]>[] {
    return this._core.entries(key)
  }

  /**
   * Look up a defined spec.
   * @param key - SlotMap key.
   * @returns spec or undefined.
   */
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined {
    return this._core.spec(key)
  }

  /**
   * Dynamic-key escape hatch for spec lookup (renderer-side string keys).
   * @param key - candidate slot key.
   * @returns wide-typed spec or undefined.
   */
  specDynamic(key: string): SlotSpec<SlotEntryDef> | undefined {
    return this._core.specDynamic(key)
  }

  /**
   * Subscribe to a key's registration changes (microtask-batched).
   * @param key - SlotMap key.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void {
    return this._core.subscribe(key, fn)
  }

  /**
   * Version counter for uSES pairing.
   * @param key - SlotMap key.
   * @returns current version.
   */
  getVersion(key: keyof SlotMap & string): number {
    return this._core.getVersion(key)
  }

  /** The wrapped pure core (web-react's scopedSlots outlet reads through this). */
  get core(): SlotCore {
    return this._core
  }
}
