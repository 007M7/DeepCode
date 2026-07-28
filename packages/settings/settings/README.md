# @deepseek-ai/dsh-settings

English | [中文](README.zh.md)

Abstract user-settings seam (`ctx.settings`). One provider holds a raw document of per-namespace sections; plugins register a namespace schema and read a resolved value layered as schema defaults, then the registrant's composition `base` (its cordis.yml entry-config subset), then the user document section. Without a mounted provider nothing changes for consumers: they keep resolving entry config alone, so every composition works with or without settings.

## Service API

- `register(ns, schema, { base?, applies? })` — returns the owner `SettingsScope` (`get`/`watch`/`update`). The registration is an effect on the calling plugin's fiber: disposing that fiber removes the namespace and its observers. A stored section the schema rejects fails the registration itself; a duplicate namespace fails loud.
- `describe()` — one descriptor per namespace (`schema.toJSON()` envelope, resolved value, `applies`) for configuration surfaces.
- `get(ns)` — resolved value, `undefined` while unregistered.
- `update(ns, patch)` — deep-merges the plain-object patch into the user section only (never the `base`), validates the resolved candidate, persists through the provider, then commits. Validation failure rejects before anything is persisted; a read-only provider (`writable: false`) rejects every update.
- Resolved values are deep-frozen snapshots; watchers receive `(next, prev)` after each commit, and watcher failures are contained.

## Provider contract

Subclasses implement `writable`, `load()`, and `persist(ns, section)`, and push externally observed documents through the protected `publish(doc)`. At publish, each registered namespace re-resolves independently: an invalid section keeps that namespace's last good value and warns — a live reload never takes the process down — while boot-time and registration-time validation fail loud.

## Events

`settings/updated (ns, next, prev, source)` fires after each commit; `source` is `update` (in-process write) or `provider` (external change). It never fires for a deep-equal resolved value.

## Model Experience

Indirectly, through consumer plugins that resolve model-affecting values (for example a default model route) from their namespaces; each consumer's own surface documents the effect.

#### KV Cache effect

No direct invalidation; a consumer that folds a settings value into the request prefix owns that change.

## Known Limitations and Deferred Work

- **Single user layer** — resolution knows schema defaults, one composition `base`, and one user document; there is no project/managed layering or per-value provenance yet.
- **Cross-process concurrency is provider-defined** — the seam serializes nothing across processes; concurrent writers converge by provider behavior (the local file provider is last-write-wins).
- **No secret-field redaction** — `describe()` returns resolved values verbatim; a wire surface (RPC/UI) must redact `role('secret')` fields before exposure.
