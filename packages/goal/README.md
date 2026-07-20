# goal/ — persisted same-session goals

The goal family owns durable objective state independently of the model-facing tools and continuation policy that consume it.

| Package | Role | ctx key |
|---|---|---|
| `goal/` | Event-sourced goal lifecycle, replay fold, compare-and-set mutations, and process-local activation | `ctx.goals` |
| `tool-goal/` | Model-facing read/create/update tools with execution-time authority checks | — |

Goal state is part of the owning session log. Consumers depend on `dsh-goal`, not on the concrete agent loop; continuation behavior belongs in a separate plugin on the public agent seams.
