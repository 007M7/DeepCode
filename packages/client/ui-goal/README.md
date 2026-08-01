# @deepseek-ai/dsh-client-ui-goal

English | [中文](README.zh.md)

Goal surface plugin, browser half: the `GoalBar` strip is the first standalone card in the `conversation.input.dock` composer-context stack (order 0, before Todo and Queue). The live goal arrives through `useProjection('goal')` — the host-computed whole value seeded by the history tail page and updated by `session/projection` frames — so the plugin owns no domain store, refresh chain, or event listener. The slot inject face carries only the four mutation verbs (edit / pause / resume / clear over the `goal.*` wire domain — an active goal offers the pause action, a paused one resume); each reads the CAS ref from the session's current projected value at call time and surfaces the settled RPC error inline. The strip single-flights mutations synchronously because React's pending render cannot fence same-frame clicks; after a successful clear it immediately suppresses that exact goal id while the authoritative null projection catches up. Goal creation stays on the `/goal` host command; loading, absent, completed, and successfully cleared goals render nothing.

The `/client` export surface is the plugin body (`apply`/`inject`), the `GoalBar`/`GoalDock` components, and the injected verb face types.

## Model Experience

Indirectly, through the `goal.edit`/`goal.pause`/`goal.resume`/`goal.clear` RPCs the strip's verbs submit: each accepted mutation appends a model-visible `goal/change` context message to the session (the same durable event the projection folds), so the model sees the updated goal state on its next turn. The strip itself adds no prompt content.

#### KV Cache effect

None beyond the goal mutation's own context event, which appends to the log tail like any other message.

## Known Limitations and Deferred Work

- **Durable phase only** — the projection value deliberately omits process-local activation (armed/disarmed), so the strip cannot distinguish an active-but-disarmed goal from an armed one; resume re-arms through the RPC side. A host-live-value channel is deferred until a real consumer needs it.
