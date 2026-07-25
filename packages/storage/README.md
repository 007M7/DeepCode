# storage/ — non-session storage family

The storage family persists everything that is not a session event log: a hub where named backends and typed data forms meet. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

| Package | Role | ctx key |
|---|---|---|
| `storage/` | The hub: named backend registry + merge-extensible data-form mounts, backend facet vocabulary, shared conformance suite | `ctx.storage` |
| `storage-json/` | JSON backend: one human-readable file per unit, atomic whole-file rewrite | registers backend `json` |
| `storage-sqlite/` | SQLite backend: one database hosting all routed units, document-per-row | registers backend `sqlite` |
| `domain/` | Domain data form: zod-validated records, per-domain write chain, `domain/changed` events, backend routing by configuration | mounts `ctx.storage.domain` |

Backends own one medium each and expose data-shape **facets** (`kv` today; an append-log facet is reserved for the future session-backend migration). Consumers never touch backends directly — they open declared domains through the domain form.
