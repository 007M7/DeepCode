# Context glossary

Domain vocabulary for the DeepSeek Harness SDK — one canonical term per concept. Terms link with `[[name]]`; implementation detail stays in the package READMEs and RFCs.

## agent-scope

- **scope** — the unit of per-agent registration: a contribution (tool, prompt section, variable, restriction, listener) is either *global* (visible to every agent) or *scoped* (owned by exactly one [[scope-key]]). Two levels, flat: nothing inherits down to subagents; subtree behavior is expressed with [[lineage]] data, never structure.
- **scope key** — the opaque identity a scope is keyed by, compared by object identity. The harness convention: a live agent is the key of its own scope. <a id="scope-key"></a>
- **agent context (`agent.ctx`)** — the agent's scoped context; registrations through it are scope-visible AND scope-lifetime (one fact drives both), and listeners on it hear only that agent's dispatches.
- **scope carrier** — the `thisArg` a scope-filtered dispatch carries (built by `scopeTarget`); its filter admits untagged listeners plus the subject's own. A *subject-less* carrier (no key) admits untagged listeners only.
- **scoped dispatch** — the rule: an event about one agent's activity dispatches with that agent's carrier. Events about a registry itself (a tool was added) are *registry-subject* and stay unfiltered.
- **shadowing** — most-specific-wins name resolution: a scoped tool/section/variable replaces its same-named global twin for that scope alone. The per-agent persona and per-agent tool-variant mechanism.
- **restriction / grant** — a restriction (`tools.restrict`) masks the GLOBAL tool surface for one scope (compose by intersection); a scoped registration is an explicit grant that bypasses restrictions. A restricted-away tool is absent from the prompt AND refuses execution, indistinguishably from a nonexistent one.
- **setup window** — the creation slot where a creator composes an agent's scoped world (`CreateAgentOptions.setup`): after the scope exists and the agent is registered, before `agent/session-start` and the first prompt assembly. Setup registers; it never drives the agent.
- **lineage** — parent/child facts carried as data (`parentSession`, `subagentDepth`); never affects visibility. <a id="lineage"></a>
