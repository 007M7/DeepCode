# User Settings

English | [中文](settings.zh.md)

The user-settings seam of [dsh-settings](../../packages/settings/settings) holds one user-owned document of per-namespace sections and resolves each registered namespace as schema defaults, then the registrant's composition `base`, then the user section. Providers such as [dsh-settings-local](../../packages/settings/settings-local) store the raw document and push external edits; consumer plugins register a schema and read or observe the resolved value. Composition config stays in `cordis.yml` — a namespace carries only the user-editable subset.

Source: [`packages/settings/settings/src/index.ts`](../../packages/settings/settings/src/index.ts)

## Identity

A namespace names one plugin-owned section of the user document. The brand keeps namespaces from mixing with other cross-boundary ids; construction validates the lowercase kebab-case shape.

```ts type-equiv
/** Nominal id of one registered settings namespace. */
type SettingsNamespace = Branded<'SettingsNamespace'>
```

## Registration

Registration binds a schemastery schema to a namespace on the calling plugin's fiber — disposing that fiber removes the namespace and its observers. The options carry the composition layer and the owner's effect timing.

```ts type-equiv
/** Registration options beyond the namespace schema. */
interface SettingsRegisterOptions<T> {
  /** Composition-layer values resolved below the user layer (entry-config subset). */
  base?: Partial<T>
  /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
  applies?: SettingsApplies
}
```

`applies` is a UI hint, not a mechanism: a `restart` owner simply never watches, so its value is read once at construction and configuration surfaces can badge the pending change.

```ts type-equiv
/** When a namespace's changes take effect for its owner. */
type SettingsApplies = 'live' | 'restart'
```

## Owner scope

The scope is the owner-facing handle. `update` merges a sparse patch over the user section only (never into `base`); `replace` sets the section wholesale, which is the removal/reset path — keys absent from the replacement re-inherit `base` and schema defaults. Writes to one namespace are serialized in call order, and resolved values are deep-frozen snapshots.

```ts type-equiv
/** Owner-facing handle for one registered namespace. */
interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /**
   * Observe committed changes to this namespace's resolved value. Invocations
   * of one callback run asynchronously, one at a time, in commit order; a
   * rejection is contained and logged like a sync throw. After the disposer
   * returns, no further invocation starts — one already queued is skipped;
   * one already started still settles, and service disposal waits for it.
   * @param callback - invoked after each commit with the next and previous values.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /**
   * Merge a partial patch into this namespace's user layer and persist it.
   * @param patch - plain-object patch over the user section; JSON-shaped data
   * only (non-JSON values reject with their path before anything persists).
   */
  update(patch: object): Promise<void>
  /**
   * Replace this namespace's user section wholesale; absent keys re-inherit
   * the composition `base` and schema defaults (`replace({})` resets all).
   * @param section - the complete next user section; JSON-shaped data only,
   * as for {@link update}.
   */
  replace(section: object): Promise<void>
}
```

## Descriptors

`describe()` serializes every registered namespace for configuration surfaces: the schemastery `toJSON()` envelope drives schema-rendered forms, and the resolved value fills them.

```ts type-equiv
/** One registered namespace as surfaced to configuration UIs. */
interface SettingsDescriptor {
  /** The registered namespace. */
  ns: SettingsNamespace
  /** Serialized schemastery schema (`schema.toJSON()`). */
  schema: unknown
  /** Current resolved value. */
  value: unknown
  /** Owner's declared effect timing. */
  applies: SettingsApplies
}
```

## Change commits

Every committed change — an in-process write or an externally observed provider edit — emits `settings/updated (ns, next, prev, source)` after the new value is authoritative, and never when the resolved value is deep-equal. The source tag separates the two entry paths.

```ts type-equiv
/** Origin of one committed settings change. */
type SettingsUpdateSource = 'update' | 'provider'
```
