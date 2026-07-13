# RFC: Prompt variables and tool-guidance ownership

Status: implemented

## Problem

The assembled system prompt had four defects, all of one family: facts the harness already knows were restated by hand somewhere else, and drifted.

**The model could not know its own name.** `AgentOptions.model` drives every request, but no prompt text carried it — and nothing COULD carry it: sections in `dsh-system-prompt` were context-global while the model name is per-agent, and `assemble()` took no per-agent input at all.

**Tool guidance was hand-written prose in leaf YAML.** The bash/subagent/todo_write usage guidance lived in the `systemPrompt` strings of `examples/coding-agent/cordis.yml` and `examples/acp-agent/cordis.yml` — two drifting copies (the ACP one was already abridged) — while `dsh-tool-fs` and `dsh-tool-web` owned their guidance as `ctx.systemPrompt.section()` contributions. Loading or dropping a tool plugin meant editing every deployment's persona by hand; both YAMLs carried a `FIXME(config-comments)` apologizing for a symptom of the split, and the stdio welcome banner hand-enumerated the tool set too.

**The persona rendered after tool guidance.** The loop string-joined `agent.options.systemPrompt` AFTER the assembled sections, so the model read "Use the read tool…" before "You are coding-agent" — backwards relative to the identity-first convention (Claude Code, Codex) and a second composition path besides the section pipeline.

**The fork tool's description was false.** `dsh-tool-subagent` hardcoded one description written for spawn semantics — "a separate agent that works in its own context … it does not see this conversation" — and the `subagent_fork` instance (whose child inherits the parent's completed turns) got the same words; the YAML prose corrected the lie out-of-band. Minor kin: `PromptSection.name` was documented "(diagnostics / dedup)" but duplicates were silently accepted.

## Decision

**One principle: every fact in the prompt has exactly one owner.** The model name and workspace are config/session facts → the harness exposes them as variables and the persona references them. Per-tool semantics and when-to-use → the tool's `description`. Cross-call habits a description cannot carry → the tool package's prompt section. Harness provenance → the static `harness:identity` section. Deployment role and behavior → the deployment's persona.

### Assemble context

`SystemPrompt.assemble(context)` takes a merge-extensible `AssembleContext`. `dsh-system-prompt` declares the optional `scope` selector used for scoped routing, while `dsh-agent` declaration-merges the optional typed `agent` field onto it (a type-level edge `agent → system-prompt`, with no runtime dependency cycle). The loop calls `assembleContextFor(agent)` each step so both fields identify the same agent; section text providers may read that context, and the `system-prompt/assemble` waterfall receives it so a listener can filter or extend per agent.

### Prompt variables

Plugins contribute named values via `ctx.systemPrompt.variable(name, provider)`; prompt text references them as `{{name}}`. Providers are functions of the `AssembleContext` and may return `undefined` — "no value for THIS assembly". `assemble()` resolves every registered variable into `PromptAssembly.variables` (waterfall listeners can see, add, or override); `renderPrompt` interpolates. Rendering is STRICT — fail loud beats shipping a malformed prompt: a reference to an unregistered name throws (listing what exists; lookup is `Object.hasOwn`, so a prototype property like `{{constructor}}` is unknown, not a function spliced into the prompt), a registered-but-valueless reference throws, a complete `{{…}}` group that is not a well-formed name (`[a-z][a-z0-9_]*`, e.g. `{{ model }}`) throws, and a `{{` that opens no complete group while a `}}` still follows (`{{{model}}}`, `{{a{b}}`) throws. A lone `{{` with no `}}` anywhere after it is ordinary prose and passes through verbatim; substituted values are never re-scanned. Registration rejects duplicate and unreferenceable names, mirroring the tool registry — and `section()` now rejects duplicate section names, making the documented dedup real.

`dsh-agent-loop` registers the two built-ins, both pure projections of the context agent: `model` (= `options.model`) and `cwd` (= `session.header.cwd`). The example personas write `powered by the {{model}} model` — the model name is stated once, in the `model:` config key. `{{cwd}}` is demonstrated in the ACP example only: every ACP session carries the client's cwd, while config-pre-created stdio agents have none (a persona claiming `{{cwd}}` there fails the turn — by design). The variables stay on the loop plugin (unlike the sections below): they are runtime facts of the agents THIS loop drives, and a replacement loop supplies its own.

### Persona as the order-0 section

`dsh-system-prompt` itself registers the two harness-owned sections (they must survive a swapped loop plugin, so they do NOT live on `dsh-agent-loop`): the static `harness:identity` at order `-100` — every prompt opens by stating the agent is powered by the DeepSeek Harness SDK — and the global default `deployment:persona` at order 0, whose text is the plugin's own `persona` config. `AgentOptions.systemPrompt` and the loop's special-case join are gone: `fullSystemPrompt ≡ renderPrompt(assembly)`, one ordered pipeline for everything the model sees, and `agent/pre-step` (compaction's token-pressure input) measures exactly the real prompt. An agent-scoped section with the same `deployment:persona` name shadows the default for that agent; programmatic setup may register one directly, and the subagent persona feature installs one before publishing an in-process child when the selected provider supports it. Order bands are convention: harness identity `-100`, persona `0`, tool guidance `100–199`; other negative orders also render before the persona.

### Tool guidance ownership

Per-tool semantics and when-to-use live in tool DESCRIPTIONS, which already ship in every request — the YAML prose was ~fully redundant with them. Sections carry only the cross-call habits a single call's description cannot: `dsh-tool-bash` contributes `tool:bash` (order 105) — check the `[exit code: N]` marker on every result; `dsh-tool-fs`'s read section gains the "not shell commands like cat" contrast. `todo_write` and the subagent tools need NO section — their descriptions already carry the whole contract. The leaf personas shrink to identity + behavior (verify your work; keep answers brief), and the welcome banner stops enumerating tools.

### The subagent conversation-history descriptor

`SubagentProvider` gains `readonly inheritsParentContext: boolean` — a DESCRIPTIVE conversation-history fact beside `capabilities`, not in it (capabilities are start-time validation; nothing validates against this flag). Spawn and ACP declare `false`, fork declares `true`. The name refers only to conversation seeding, not Cordis scope, services, tools, or authority. `dsh-tool-subagent` derives both the tool description and the `prompt` parameter description from the flag (`providerWording`): the fork instance now tells the model the child is seeded with the conversation's completed turns (not the in-flight turn) and that its prompt should state only what is new. Deriving the description from a provider that arrives on its own fiber is what forced the provider-lifecycle events and the tool's reactive registration — that mechanism, its Loader-concurrency rationale, and its rejected alternatives are recorded in [the provider-lifecycle-events RFC](2026-07-05-subagent-provider-lifecycle-events.md).

## Alternatives considered

- **The loop composes an identity line itself** — hardcodes model-facing prose in the one package that must stay thin ("plugins, not loop changes"), and outside the section pipeline it would be a second composition path. (The identity DOES ship as a code literal — but as an ordinary section registered by `dsh-system-prompt`, whose `system-prompt/assemble` waterfall remains the escape valve for a deployment that must drop it.)
- **Inject the model name via the `agent/request` waterfall** — prompt text composed in two places, and `agent/pre-step`'s `fullSystemPrompt` would omit it, so compaction would measure a prompt that is not what the model sees.
- **Hand-write the model name in each persona** — duplicates the `model:` key one line above and silently lies after a config edit; the exact disease this RFC cures.
- **Lenient interpolation (leave unknown refs verbatim, or substitute empty)** — a typo ships `{{modle}}` (or a hole) to the model and nobody notices until transcript review.
- **Per-instance subagent wording in config** — returns model-facing prose to every deployment × instance, the P2 disease again. **Keying wording off the provider NAME** — `providerName` is itself config, so a renamed provider silently gets the wrong words.
- **Resolving the provider at `apply` time (a load-order requirement)** and **section-only subagent wording (lazily resolved at assemble)** — the alternatives to the provider-lifecycle events; both rejected in [the provider-lifecycle-events RFC](2026-07-05-subagent-provider-lifecycle-events.md).

## Out of scope

- Further variables (`date`, platform, git state) — the registry makes each a one-line contribution by whichever plugin owns the fact; none is claimed here.
- A config `cwd` for pre-created stdio agents (would let the stdio persona use `{{cwd}}` and partition persistence by real path) — deferred until the session-cwd story is revisited.

## Shipped invariants

- `renderPrompt(await assemble(assembleContextFor(agent)))` for the coding-agent example renders the harness identity, then the persona (with the agent's model name interpolated), then the fs/bash/web guidance sections; the loop has no other prompt-composition path.
- The `subagent_fork` schema description says the child inherits the conversation; the `subagent` one says it does not. The tool follows its provider: absent before the backend activates, present after, gone when the backend unloads, re-worded from the fresh provider on reload.
- Unknown/valueless/malformed/unbalanced `{{…}}` references throw with the section name in the message; duplicate section, variable, and tool-name registrations all throw.
- Snapshot goldens are prompt-independent by construction: llm-replay keys replay on (turn, step) chunk streams and never re-verifies the outgoing request.

## Consequences

- Every fact in the assembled prompt now has exactly one owner, and the hand-maintained tool prose in leaf YAML is gone: loading or dropping a tool plugin no longer means editing any deployment's persona.
- `{{model}}` reflects `AgentOptions.model` at assembly time. A plugin that switches models in the `agent/request` waterfall makes the prompt's claim stale for that step, and one that SUPPLIES the model there (options.model unset — the loop's documented fallback) leaves the variable valueless at render, failing a `{{model}}` persona before the waterfall runs. Both have the same remedy, and it is the ownership rule itself: the plugin that owns the late-bound model fact states it early on the `system-prompt/assemble` waterfall (`assembly.variables['model'] = …`) — one owner, both statements; a loop test pins the supply path end-to-end. Accepted.
- While a bound provider is absent (not yet activated, unloaded, mid-HMR-reload), the subagent tool does not exist and a model request in that window simply lacks it. That is the honest state — the alternative was a registered tool whose description or execution could not be trusted.
- Strictness means a persona can fail a turn at render (e.g. `{{cwd}}` on a cwd-less session). The failure is contained — the turn ends `error`, the loop survives — and it is an authoring error we WANT loud.
- No escape syntax for a literal `{{name}}` in prompt prose yet; add one if a real prompt ever needs it.
