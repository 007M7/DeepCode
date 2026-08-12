# @deepseek-ai/dsh-client-ui-plugins

English | [中文](README.zh.md)

Read-only Plugins section for Web Settings. The browser plugin registers one localized `settings.section` contribution with id `plugin-inventory`, after Models, and lets the Settings shell supply its ordinary fallback icon. It performs no Remote read during plugin activation; mounting the section lazily calls `ctx.remote.pluginInventory.list()` through [`api-remotes`](../../api/remotes/README.md).

The page renders a searchable two-column catalog of compact disclosure cards. Each collapsed card uses the local Loader id as its title, a colored root-Fiber status dot, and a small effective-enablement tag. Expanding one card reveals its Loader-tree entry value without a redundant field label, followed by the effective configuration and Cordis status. Loading, empty, no-match, and generic failure states stay local to the mounted component, and a failed read can be retried without exposing transport details. The registration uses `ctx.slots.inject()`, so it follows late Settings declaration, redeclaration, locale changes, and teardown without owning another global store.

## Model Experience

None, as this package only visualizes a Host-owned deployment snapshot in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per mount or retry** — the page does not subscribe to Loader changes or automatically refetch after reconnect; reopening the section obtains a new snapshot.
- **Read-only Loader view** — local search does not add provenance, current-browser activation diagnosis, grouping by source, or plugin mutation controls.
