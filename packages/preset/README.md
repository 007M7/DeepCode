# preset/ — per-session agent composition

English | [中文](README.zh.md)

An **agent preset** is a directory holding one `agent.cordis.yml`. Mounting it under an agent's scope context gives that session its own tools and prompt sections while every other live session keeps its own, so one process can run several differently composed agents at once.

| Package | Role | ctx key |
|---|---|---|
| `agent-presets/` | Preset vocabulary, filesystem discovery over trusted and user-authored roots, and the guarded per-agent mount | `ctx.agentPresets` |
| `persona/` | The agent persona as a composable row, so a preset can change identity and not only tools | — |

The deployment ships `standard` (the full coding agent), `core-web` (a two-tool benchmark surface), and `cordis` (the standard agent plus the self-referential toolset and a composition-authoring skill, so a person can ask an agent to author another agent).

The composition split this group assumes: registries and cross-session facilities are process singletons and stay in the host composition, while a preset carries what one agent contributes to them. A preset that names a row publishing a process-global service is rejected at mount rather than allowed to collide with the next session.

Design: [the per-session agent-preset note](../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md).
