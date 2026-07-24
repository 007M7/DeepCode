# @deepseek-ai/dsh-storage

Storage hub (`ctx.storage`) for non-session data: a named backend registry plus mounted data-form facilities. The hub performs no IO itself — backends own media, data forms own semantics. Design and trade-offs: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Shape

- `ctx.storage.backend` — name → backend table. Multiple backends stay mounted side by side (`json`, `sqlite`); which backend serves a consumer is that consumer's configuration (the domain layer's route table), never a hub-global choice. `register()` returns the disposer; duplicate names and unknown lookups fail loud.
- `ctx.storage.mount(form, facility)` / `ctx.storage.form(form)` — data-form mounting. `StorageForms` is merge-extensible; the domain layer merges `domain` and is reached as `ctx.storage.domain`.
- A backend owns one medium (file-tree root, database file) and exposes optional data-shape **facets** — `kv` today; an append-log facet is reserved for the future session-backend migration. `src/backend.ts` is the normative contract text; `tests/contract.ts` exports the shared conformance suite every backend runs.

## Packages in this group

| Package | Role |
| --- | --- |
| `dsh-storage` | The hub service + backend vocabulary + shared conformance suite |
| `dsh-storage-json` | JSON backend: one unit per human-readable file, atomic whole-file rewrite |
| `dsh-storage-sqlite` | SQLite backend: one database hosting all routed units, document-per-row |
| `dsh-domain` | Domain data form (`ctx.storage.domain`): typed schemas, write chain, change events |
