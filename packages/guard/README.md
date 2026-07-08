# guard/ — loop-hygiene guard family

Behavioral guard plugins that watch the agent loop for unproductive patterns and nudge the model back on course. A single **product** package — there is no interface/implementation seam here, because a guard is a self-contained consumer of existing core seams (`tools/post-execute`, `agent/prompt-submit`, `agent/status`), not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| `repeat-tool-guard/` | Advisory reminders when an agent loops on identical tool calls | (listens on `ctx.tools`' waterfalls) |

Reminders travel as `additionalContext` on the `tools/post-execute` decision; the agent loop appends them as logged `context/message` events after the step's tool results (see [the tools package](../core/tools)), so everything a guard says to the model is reconstructable from the session log.
