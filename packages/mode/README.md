# mode/ — session-mode policy family

Session modes: named, logged, per-agent policy states, with **plan mode** as the first shipped definition. A single **product** package — there is no interface/implementation seam here, because a mode's variable parts are config values (allowlist, section text), not swappable implementations.

| Package | Role | ctx key |
|---|---|---|
| `mode/` | `mode/set` vocabulary + fold, the `ctx.modes` service (list/get/set with the turn-boundary flush), the soft layer (assemble filter + `mode:policy` section), the hard layer (`tools/pre-execute` deny-by-default gate), and the model-facing `exit_plan_mode` review tool | `ctx.modes` |

The mode in force is a pure function of the session log (`SessionEventMap['mode/set']`, last one wins), so resume and fork restore it with no extra machinery; the default mode is the absence of policy, keeping the plugin invisible until a mode is set. UIs read flips off `session/event`: the [stdio app](../ui/stdio-agent) exposes `/mode`, the [ACP bridge](../ui/acp) maps the vocabulary to the session-mode picker. RFC: [plan mode](../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md).
