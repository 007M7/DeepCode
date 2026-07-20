# goal/ — persisted same-session goals

The goal family owns durable objective state independently of the model-facing tools and continuation policy that consume it.

| Package | Role | ctx key |
|---|---|---|
| `goal/` | Event-sourced goal lifecycle, replay fold, compare-and-set mutations, and process-local activation | `ctx.goals` |
| `goal-session/` | Same-session goal-round admission, outcome mapping, and lifecycle race fencing | — |
| `tool-goal/` | Model-facing read/create/update tools with execution-time authority checks | — |
| `command-goal/` | Human-facing `/goal` status and lifecycle control over the command plane | — |

Goal state is part of the owning session log. Consumers depend on `dsh-goal`, not on the concrete agent loop; continuation behavior belongs in a separate plugin on the public agent seams.
