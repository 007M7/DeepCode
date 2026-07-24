# @deepseek-ai/dsh-domain

Domain data form for the DeepSeek Harness storage hub: mounts `ctx.storage.domain`, opening schema-validated KV domains over configured storage backends. A domain is declared once with `defineDomain` (zod record schemas, `z.infer`-derived types), opened through `DomainFacility.open`, and served from authoritative in-memory state — reads are synchronous, writes serialize on one per-domain chain, land durably on the routed backend, then emit `domain/changed`.

Design rationale, open semantics, and the storage/domain layer split live in the [Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Configuration

| key | meaning |
| --- | --- |
| `backend` | Default backend name for every domain (required; no universally correct medium exists). |
| `routes` | Per-domain overrides: domain name → backend name. |

## Model Experience

No model-visible surface: the package registers no tools, injects no prompts, and emits no context. Token and KV-cache cost are zero.

## Known Limitations and Deferred Work

- Single-process only: `domain/changed` is an in-process event; cross-process observation (GUI reconnect) is deferred to the revision pattern noted in the Agent Note's non-goals.
- No cross-table transactions, secondary indexes, or multi-segment keys; triggers and rework points are tabled in the Agent Note.
