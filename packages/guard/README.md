# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

Behavioral guard plugins that watch the agent loop and correct it — some by nudging the model back on course, some by refusing an operation outright. All are **product** packages: there is no interface/implementation seam here, because a guard is a self-contained consumer of existing core seams (`tools/pre-execute`, `tools/post-execute`, `agent/prompt-submit`, `agent/status`), not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| `repeat-tool-guard/` | Advisory reminders when an agent loops on identical tool calls | (listens on `ctx.tools`' waterfalls) |

An advisory guard's reminders travel as `additionalContexts` on the `tools/post-execute` decision; the agent loop appends them as logged plugin-sourced `user/message` events after the step's tool results (see [the tools package](../core/tools)), so everything such a guard says to the model is reconstructable from the session log. An enforcing guard instead decides on `tools/pre-execute`, where a `deny` becomes the call's error result and the operation never dispatches.
