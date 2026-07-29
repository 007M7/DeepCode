# skill/ - skill capability family

English | [中文](README.zh.md)

The canonical three-package capability seam for reusable agent instructions: a provider registry, a local implementation, and the model-facing catalog/loader consumer. All are **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `skill/` | Provider registry, precedence resolution, complete/incomplete catalog snapshots, and full-definition lookup | `ctx.skills` |
| `skill-local/` | Project/custom/user filesystem provider with membership watching | (registers on `ctx.skills`) |
| `tool-skill/` | Initial and replacement catalogs plus the model-facing `skill` loader | (registers on `ctx.tools`) |

The interface lives at `skill/skill/`. Providers register synchronously and perform asynchronous discovery through `ctx.skills`; `tool-skill` consumes only that interface, so an embedded or remote provider can replace or complement `skill-local` without changing the model-facing contract. `agent-core` loads this family by default, but it remains a capability outside the core control spine, parallel to [`bash/`](../bash/README.md), [`fs/`](../fs/README.md), [`web/`](../web/README.md), and [`subagent/`](../subagent/README.md).
