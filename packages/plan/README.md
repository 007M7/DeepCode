# plan/ — plan collaboration state

Plan mode is one logged, per-agent collaboration state. It is a single **product** package, not a generic mode registry or a capability-seam trio.

| Package | Role | ctx key |
|---|---|---|
| `plan-mode/` | `plan/mode` vocabulary + fold, boundary-applied state, the `plan:policy` guidance section, `/plan [message]`, and the model-facing `exit_plan_mode` review tool | `ctx.planMode` |

The active state is a pure function of the session log, so resume and fork restore it without extra machinery. The deployment supplies plan instructions through Cordis config, while `exit_plan_mode` stays registered when planning is inactive to keep the request tool catalog stable. ACP maps this capability onto its generic `default` / `plan` picker; sandbox mode and approval policy remain independent enforcement settings. Design: [plan-mode Agent Note](../../.agents/notes/implemented/feature/2026-07-07-plan-mode.md) and [plan-specific state simplification](../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md).
