# RFC: Scoped-layers store — one aggregate layer per scope behind a scheduling helper

Status: proposed

English | [中文](2026-07-12-scoped-layers-store.zh.md)

## Problem

Agent scoping ([the agent-scope RFC](../../implemented/architecture/2026-07-08-agent-scope-contexts.md), [runtime design](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md)) made "a registry with a global layer plus per-agent layers" a recurring shape, and every occurrence is hand-written. Seven registration sites exist today — `tools.register`/`tools.restrict`/`tools.guard` in `dsh-tools` and `section`/`tools`/`variable`/`protect` in `dsh-system-prompt` — each pairing a global container with its own `Map<ScopeKey, container>` and repeating the same 10-15-line effect choreography: read the calling context's tag, get-or-create the layer, validate, mutate, yield a rollback that deletes the entry, reclaims the emptied layer, and emits the change event, then emit and return the exact cordis effect disposer.

Beyond the duplication, the risk concentrates in the choreography details:
- The rollback must be collected before the change emit (so a throwing listener unwinds the insertion instead of leaking it)
- The returned disposer must be cordis's own function (a wrapper silently breaks nested ordered teardown)
- Emptied scoped layers must be reclaimed (a disposed agent must not leave residue keyed by its dead `ScopeKey`)

Every new consumer has to rewrite all of that correctly, and the copies have already diverged stylistically — two private `layerFor` helpers in `dsh-tools`, four inline IIFEs in `dsh-system-prompt`.

Finally, one agent's contribution to one service is scattered across several maps that know nothing of each other — there is no object that means "what this scope contributes here" — and the consumer count keeps growing: guards and prompt protections landed recently, and per-agent `fs/*` policy, `llm/*` overrides, and per-agent compaction policy are all queued on the same pattern.

## Proposal

`dsh-scope` gains a store module (a new `store.ts` under its `src/`, peer-dependent on cordis only, key-agnostic) built around one division of labor: **business logic lives in a layer class; the helper only schedules layers**. One helper instance per service; the value in its map is the aggregate of everything one scope contributes to that service.

- **`ScopedLayers<L>`** — a concrete scheduler, never subclassed. It owns the global layer plus one `Map<ScopeKey, L>`, builds layers on demand as `new layerClass(scope, this)`, reclaims a layer when `isEmpty()`, and funnels every write through `effect(ctx, action, options?)`. The single `ctx` parameter decides both the visible layer (`scopeOf(ctx)`) and the owning fiber (`ctx.effect`), so "visible to X, disposed with Y" stays unrepresentable — the same shape argument the agent-scope RFC used against explicit scope parameters. Actions may produce one undo, an iterable of undos, a promise, or an async iterable — the four shapes of cordis `Effect` — and undos may be async. The helper seals collected undos (run in LIFO), empty-layer reclamation, and the change notification into one disposer, and hands cordis that disposer **before** the notification runs: a throwing change listener therefore makes cordis execute the already-collected rollback and rethrow, exactly like the hand-written yield-before-emit today. Reads are `global`/`peek` plus three selector primitives lifting the table views across the two layers — `merge` (named entries, scoped shadows global, global position preserved, optional admit predicate), `values` (concatenation including anonymous entries, deliberately no shadowing), `keys` (the pre-restriction name universe) — and array-returning `forEach`/`filter`/`map` over all layers.
- **`createLayer({ name: table<V>(kind) })`** — a class factory in the `defineTool` DSL tradition. The generated base class builds every declared table in its constructor, threads the scope down, receives the sibling back-reference (`protected readonly layers: ScopedLayers<this>`, injected by the helper at construction; polymorphic `this` narrows it in subclasses), and aggregates `isEmpty()` over the declared tables. `layer.<table>` is a fully typed mapped property, so a misspelled table name is a compile error; the table names `scope`, `isEmpty`, and `layers` are reserved and throw. Business subclasses add domain methods in the class body — single-layer queries, registration validations, and cross-layer *reads* through `this.layers` (writes must still go through `effect`); a fully custom layer may instead implement the one-method `ScopeLayer` interface (`isEmpty()`).
- **`Entries<V>`** — the canned table: named entries (`insert`, same-layer duplicates throw one standardized message pair pointing at `agent.ctx`) and anonymous entries (`append`, process-unique symbol keys, O(1) undo removal) share one insertion-ordered map; read views (`keys`/`entries`/`values`) return array snapshots.

`dsh-tools` migrates its three tables into one `ToolLayer` (domain methods `addRestriction` — empty-filter/read-once/reserved-name/known-names validation with the reserved list passed in as data, since it reads service state — plus `admits` and `guardReason`), and `dsh-system-prompt` its four into one `PromptLayer` (`addProtection` with the global-conflict self-check via the back-reference, plus the `shadowedSections` predicate). Every facade becomes a single `effect` call carrying per-call `label`, `silent` (guards emit no change event), or `scopedOnly` (boolean, or a string carrying the domain error message) options. `assemble` stays in the facade for three hard reasons: it has no legal receiver (the subject scope's layer may not exist, and reads never create layers), shadowing forces merge-before-evaluate (per-layer rendering would evaluate shadowed providers, an observable change), and the assemble waterfall, `toolOrder`, and protection restore need service-level resources a layer must not hold.

Migration is behavior-preserving with two declared exceptions: the three duplicate-name messages unify into one template (tests asserting the old wording update in the same change), and validations move relative to the effect boundary (restrict/protect checks move inside the action, the variable name regex moves to the facade), so the error *order* for multiply-invalid inputs can change while every single-fault path is unchanged. Two knowingly unobservable differences: an aggregate layer is reclaimed only when all its tables are empty, and read views are snapshots rather than live containers (visible only to a callback that registers during its own iteration).

## API sketch

```ts ignore-check
interface ScopeLayer {
  isEmpty(): boolean
}

type LayerClass<L extends ScopeLayer> = new (scope: ScopeKey | undefined, layers: ScopedLayers<L>) => L

declare function table<V>(kind: string): TableSpec<V>
declare function createLayer<S extends Record<string, TableSpec<unknown>>>(
  spec: S,
): LayerClass<ScopeLayer & { readonly [K in keyof S]: Entries<EntryTypeOf<S[K]>> }>

type Undo = () => unknown
type LayerAction<L> = (layer: L) =>
  | Undo
  | Iterable<Undo, void, void>
  | Promise<Undo>
  | AsyncIterable<Undo, void, void>

class ScopedLayers<L extends ScopeLayer> {
  constructor(layerClass: LayerClass<L>, options: { label: string; onChange?: () => void })
  readonly global: L
  peek(scope: ScopeKey | undefined): L | undefined
  merge<T>(scope: ScopeKey | undefined, pick: (layer: L) => Entries<T>, admitGlobal?: (name: string) => boolean): Map<string, T>
  values<T>(scope: ScopeKey | undefined, pick: (layer: L) => Entries<T>): T[]
  keys<T>(scope: ScopeKey | undefined, pick: (layer: L) => Entries<T>): string[]
  effect(ctx: Context, action: LayerAction<L>, options?: { label?: string; silent?: boolean; scopedOnly?: boolean | string }): () => Promise<void> | void
  forEach(fn: (layer: L, scope: ScopeKey | undefined) => void): void
  filter(fn: (layer: L, scope: ScopeKey | undefined) => boolean): L[]
  map<T>(fn: (layer: L, scope: ScopeKey | undefined) => T): T[]
}

class Entries<V> {
  constructor(kind: string, scope: ScopeKey | undefined)
  insert(name: string, value: V): () => void
  append(value: V): () => void
  get(name: string): V | undefined
  has(name: string): boolean
  keys(): string[]
  entries(): ReadonlyArray<readonly [string, V]>
  values(): readonly V[]
  isEmpty(): boolean
}
```

What a migrated consumer looks like — the heaviest current site shrinks from 30+ lines of choreography to a declaration and one-line facades:

```ts ignore-check
class ToolLayer extends createLayer({
  tools: table<ToolDefinition>('tool'),
  restrictions: table<ToolRestriction>('tool restriction'),
  guards: table<ToolGuardRegistration>('tool guard'),
}) {
  addRestriction(filter: ToolRestriction, reserved: readonly string[]): () => void { /* validate, snapshot, append */ }
  admits(name: string): boolean { /* intersection over this.restrictions.values() */ }
  guardReason(view: Readonly<ToolExecution>): string | undefined { /* first monotonic denial */ }
}

class ToolRegistry extends Service {
  private readonly layers = new ScopedLayers(ToolLayer, {
    label: 'tools',
    onChange: () => this.ctx.emit('tools/change'),
  })

  register(definition: ToolDefinition): () => Promise<void> | void {
    return this.layers.effect(this.ctx,
      layer => layer.tools.insert(definition.name, definition),
      { label: 'tools.register()' })
  }

  visible(scope?: ScopeKey): ToolDefinition[] {
    return Array.from(this.layers.merge(scope, layer => layer.tools, name => this.admits(scope, name)).values())
  }
}
```

## Alternatives considered

**Per-scope registry instances behind a parent/child delegation chain.** Instance explosion; the "deployment tools plus my tools" merged view needs a hand-built delegating registry per service; single-subscription observers (persistence, the ACP bridge) would have to discover and subscribe per instance; and a delegation chain cannot express subtraction (restrictions). A child registry would also have to reach back into a parent context, widening the exposure surface.

**Explicit scope parameters on registration APIs.** Already rejected by the agent-scope RFC: omitting the parameter silently registers globally, and the shape can express visible-to-X-disposed-with-Y, which is almost always a bug.

**Extracting only the data structure, leaving the choreography in services.** Removes the safe half of the duplication and keeps the dangerous half — the rollback-before-emit ordering, raw-disposer, and reclamation rules are exactly where the bugs live.

**A fixed-container helper with built-in view semantics.** Pins container shapes and merge policy inside the helper; business gets no freedom, and every naming or single-value variation becomes a helper feature request.

**One helper per table.** Reproduces today's scattered bookkeeping — that is the status quo being replaced, with N scope maps per service and no aggregate for an agent's contribution.

**`helper.get(ctx).effect(...)` two-step registration.** Splits layer creation from lifecycle attachment; a throw between the steps strands an empty layer, and the returned handle is an extra allocation per call.

**Layers holding a ctx and registering their own effects.** Turns data objects into lifecycle managers and reinstates the choreography once per business class.

## Acceptance criteria

- `store.ts` ships in `dsh-scope` (peer deps unchanged: cordis only; module-graph position unchanged) with per-file 100% coverage, including: layer bookkeeping and reclamation, all four action shapes, seal ordering, the throwing-change-listener rollback (the entry is rolled back and the duplicate check re-registers), failure reclamation of freshly created layers, `label`/`silent`/`scopedOnly` options, `createLayer` construction, reserved table names, back-reference typing, and `Entries` named/anonymous semantics.
- `dsh-tools` and `dsh-system-prompt` each collapse to one `ScopedLayers`; all existing tests pass with only the declared duplicate-message assertion updates; every registration facade is a single `effect` call and keeps returning the exact cordis effect disposer.
- Behavior matches the old baseline per the equivalence statement above: two declared exceptions (unified messages; error order for multiply-invalid inputs), two unobservable differences (aggregate reclamation timing; snapshot read views), nothing else.
- Documentation lands in the same change: `dsh-scope`/`dsh-tools`/`dsh-system-prompt` READMEs; on implementation this RFC moves to `implemented/` and the [runtime-design RFC](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md)'s registration section is updated in place.

## Risks

- The layer/facade boundary may not fit a future consumer's shape. Mitigation: the bare `ScopeLayer` interface remains the floor, and widening `LayerClass` to accept a factory (for layers with constructor dependencies) is a recorded non-breaking extension.
- `createLayer`'s mapped-type factory is deliberate type gymnastics. Accepted: the `defineTool` schema DSL is the repo precedent, and the gymnastics stay inside `dsh-scope`.
- The two equivalence exceptions can surprise tests that assert exact duplicate messages or multi-fault error order; they are declared here so review checks them rather than discovers them.
- Snapshot read views hide entries registered by a callback during its own iteration — a pathological pattern, but a visible one; snapshots make it deterministic instead.
- Two core registries migrate at once. Mitigated by the behavior comparison performed during design and by landing the store with equivalence-pinning tests before either migration commit.
