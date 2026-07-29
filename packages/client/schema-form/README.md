# @deepseek-ai/dsh-client-schema-form

English | [中文](README.zh.md)

Schema-driven React form renderer for settings sections. The wire's `settings.describe` carries each namespace's serialized schemastery schema (`schema.toJSON()` ref envelope); `SchemaForm` rehydrates it with `new Schema(json)` and renders every declared field as an editable control — the same schema object that validates a section on the host validates and drives the form in the browser, so there is no second form definition to drift.

## Contract

`SchemaForm` is a controlled component over a **draft user section**: `draft` is the object being edited (never mutated; every edit calls `onChange` with a new root), and `fallback` is the resolved value (schema defaults → composition base → user layer) used for inherited display. A field's presence in the draft marks it **overridden** and shows a per-field Reset that deletes the key, falling back to the inherited layer — presence semantics, not value comparison, exactly mirroring the settings seam's layering.

Controls by schema node: `object` → labeled field groups (JSDoc `description` rendered, `required` starred), `string`/`number`/`boolean` → inputs with the inherited value as placeholder, `union` of literals → select whose empty option means "inherit", `array` → positional rows with add/remove (arrays replace wholesale on write), `dict` → keyed rows where a union-typed `sKey` becomes the add-select's vocabulary. `role('secret')` renders a **write-only** password input: the stored value never arrives (the wire strips it), and the `secrets` slot list (`{path, set}`) supplies the placeholder state. A node the renderer cannot faithfully edit (non-literal unions, transforms) renders a read-only JSON view with a notice instead of disappearing — a schema field is never silently dropped.

`renderField(context)` is the role-aware override hook: return a node to replace the default control for one leaf. The Models settings page uses it to mount the credential-reference control (`role('credential-ref')`) that talks to `credentials.*` — this package stays wire-free and side-effect-free.

`validateDraft(schema, draft)` runs the rehydrated validator and returns its failure message, letting pages validate before writing; the path helpers (`getPath`/`hasPath`/`setPath`/`deletePath`) expose the same immutable draft editing the controls use.

## Model Experience

None, as this package renders browser configuration forms; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Validation is form-level, not per-field** — `validateDraft` reports schemastery's first failure message (which names the `$.path`); inline per-field error placement is deferred until a second consumer needs it.
- **Strings are built-in English** — the `labels` prop overrides every user-visible string, but there is no locale-dictionary wiring inside this package; the embedding page owns localization.
- **Non-literal unions and transforms render read-only** — faithful editing of those shapes needs per-shape controls; today they fall back to the JSON view with a notice.
- **Array editing replaces wholesale** — element-level merge does not exist at the settings seam either; the form mirrors that contract rather than hiding it.
