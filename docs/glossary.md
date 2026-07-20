# Glossary

Domain vocabulary for the DeepSeek Harness SDK uses one canonical term per concept. Terms link to their entries with standard Markdown anchors; implementation detail stays in package READMEs and Agent Notes.

FIXME(glossary-completeness): Expand this glossary before the first release so it covers the SDK's other core and capability subsystems, not only agent scope.

## agent-scope

- **scope** — the unit of per-agent registration: a contribution (tool, prompt section, variable, restriction, listener) is either *global* (visible to every agent) or *scoped* (owned by exactly one [scope key](#scope-key)). Two levels, flat: scoped registrations do not inherit down to subagents; subtree behavior is expressed with [lineage](#lineage) data, never scope structure.
- **scope key** — the opaque identity a scope is keyed by, compared by object identity. The harness convention: a live agent is the key of its own scope. <a id="scope-key"></a>
- **agent context (`agent.ctx`)** — the agent's scoped context; registrations through it are scope-visible AND scope-lifetime (one fact drives both), and listeners on it participate in that agent's scope-filtered dispatches. Registry-subject events may remain deliberately unfiltered under their own event contracts.
- **scope carrier** — the `thisArg` a scope-filtered dispatch carries (built by `scopeTarget`); its filter admits untagged listeners plus the subject's own. A *subject-less* carrier (no key) admits untagged listeners only.
- **scoped dispatch** — the rule: an event about one agent's activity dispatches with that agent's carrier. Events about a registry itself (a tool was added) are *registry-subject* and stay unfiltered.
- **shadowing** — most-specific-wins name resolution: a scoped tool/section/variable replaces its same-named global twin for that scope alone. The per-agent persona and per-agent tool-variant mechanism.
- **restriction / scope-local registration** — a restriction (`tools.restrict`) filters the GLOBAL tool surface for one scope (compose by intersection); scope-local registrations are merged after that filter. A filtered-away global tool is absent from the prompt AND refuses execution, indistinguishably from a nonexistent one.
- **setup window** — the creation slot where a creator composes an agent's scoped world (`CreateAgentOptions.setup`): after the scope and agent object exist but before the agent or session is published, `agent/session-start` fires, or the first prompt is assembled. Setup registers; it never drives the agent.
- **lineage** — parent/child facts carried as data (`parentSession`, durable `delegationDepth`, runtime `subagentDepth`); never affects visibility. <a id="lineage"></a>
