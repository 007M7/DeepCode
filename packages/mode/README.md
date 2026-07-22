# mode/ — session-mode policy family

Session modes: named, logged, per-agent collaboration states, with **plan mode** as the first shipped definition. A single **product** package — there is no interface/implementation seam here, because a mode's variable part is a config value (the section text), not a swappable implementation.

| Package | Role | ctx key |
|---|---|---|
| `mode/` | `mode/set` vocabulary + fold, the `ctx.modes` service (list/get/set with the turn-boundary flush), the `mode:policy` guidance section, and the model-facing `exit_plan_mode` review tool | `ctx.modes` |

The mode in force is a pure function of the session log (`SessionEventMap['mode/set']`, last one wins), so resume and fork restore it with no extra machinery. The deployment supplies plan instructions through Cordis config, while `exit_plan_mode` remains registered in every mode to keep the request tool catalog stable. UIs read flips off `session/event`; the [ACP bridge](../ui/acp) maps the vocabulary to the session-mode picker, and a composed [command registry](../ui/commands) gains one entry command per configured definition (`/plan [message]` for the required definition, with an optional next-step message). Design: [plan-mode Agent Note](../../.agents/notes/implemented/feature/2026-07-07-plan-mode.md).
