# RFC: Dynamic workflows — a script-driven multi-agent orchestration seam

- **Status**: implemented
- **Class**: feature
- **First proposed**: 2026-07-05

## Problem

The harness can delegate ONE task to ONE child (`dsh-tool-subagent`), but work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — forces the model to orchestrate turn by turn: every intermediate result lands in the parent context, the plan lives nowhere durable, and coordination costs a model round-trip per step. Claude Code ships this capability as [dynamic workflows](https://code.claude.com/docs/en/workflows): the model writes a JavaScript orchestration script, a runtime executes it, and the script — not the conversation — holds the loop, the branching, and the intermediate results.

## Proposal

A workflow capability family at `packages/workflow/` in the bash seam shape (interface / implementation / consumer), plus the structured-output foundation it needs on the subagent seam.

### The script contract (Claude Code-compatible)

A script is `export const meta = {...}` (a PURE object literal: `name`, `description`, optional `whenToUse`/`phases`) followed by a plain-JS body with top-level `await`, ending in `return <json-value>`. The body sees exactly: `agent(prompt, {label, phase, schema, model})`, `parallel(thunks)`, `pipeline(items, ...stages)` (NO cross-stage barrier; `(prev, item, index)` callbacks), `phase(title)`, `log(message)`, and `args`. CC semantics are preserved where they matter to script authors: a failed child resolves `null` (scripts `.filter(Boolean)`); an ordinary stage throw nulls the ITEM and skips its remaining stages; `Date.now()`/`Math.random()`/argless `new Date()` throw (kept banned so future resume support cannot break script compatibility).

One deliberate strictness DIVERGENCE from CC: hook misuse — unknown or deferred options (`effort`/`isolation`/`agentType`), malformed arguments, schemas outside the supported subset, tripped caps, seam start failures — throws a `WorkflowError` with `fatal: true`, and the combinators RE-THROW fatal errors instead of nulling the item. Without this, a typo'd option dissolves into a `null` indistinguishable from a child failure — the accepted-then-ignored failure mode this repo bans. One addition: the tool's `args` parameter is a JSON OBJECT (a bare list is wrapped as a field) so the wire schema stays honest.

### The seam (dsh-workflow)

`ctx.workflows` is an abstract `WorkflowService` in the bash shape — one engine per context, no named-provider registry (engines are deployment swaps, not co-residents). `start(request)` throws synchronously for a script that cannot begin; a returned `WorkflowRun`'s `result` NEVER rejects (failures resolve as `stopReason: 'error' | 'cancelled'`). The `workflow/*` events are observe-only emits carrying DATA SNAPSHOTS (id + meta; `workflow/end` omits the result value), per-listener contained, mirroring `subagent/start`/`subagent/end` — control stays with the run's holder. Vocabulary details: [core-data-structures/workflow.md](../../../core-data-structures/workflow.md).

### The engine (dsh-workflow-vm): in-process node:vm

**Trust premise (governs every engine decision below)**: workflow scripts are MODEL-WRITTEN — the same trust level as the model's existing bash access — so the engine defends against BUGGY scripts, never hostile ones. In scope: `result` never rejects, no unhandled rejections from dropped hook promises, loud rejection of values JSON cannot carry, fatal-vs-null hook discipline, cancellation that always frees the caller. Out of scope, deliberately: adversarial values (throwing/spinning accessors, proxies with hostile traps, prototype forgery, `prepareStackTrace` hijack) — host code MAY run script code while reading script values, and that is accepted, because a hostile script can already occupy the event loop forever with a synchronous spin past its first await; containing its error VALUES while conceding it the event loop would be cost without a threat model. Genuine hardening is an engine swap behind the seam (worker/isolated-vm gets value isolation by serialization for free), not incremental host-side defenses.

**Why node:vm and not isolated-vm/worker threads**: isolated-vm is in maintenance mode, needs `--no-node-snapshot` on EVERY consumer process (including the published bins) on Node ≥ 20, and falls back to node-gyp source builds; a worker-thread engine turns every hook into RPC and complicates the per-file coverage gate. Under the trust premise, in-process is enough. Accepted, documented limitations: `start()` blocks the caller for the script's initial synchronous slice (bounded by the vm timeout); that timeout covers ONLY the initial slice, so a synchronous spin past it (an await continuation, a thenable's `then` invoked by promise resolution — a returned thenable resolves per JavaScript semantics, which is what makes an un-awaited `return agent('x')` work — or script code the host runs while rendering a thrown value) cannot be killed in-process; `dispose()` cancels, waits a bounded grace for the script to settle and its children to finish disposing, then abandons.

**Meta extraction**: a string/comment-aware brace scanner (template interpolation rejected) finds the literal; it is evaluated ALONE in an empty, timed vm context; the result must materialize to plain JSON data and pass shape validation (unknown fields rejected loud); the statement is blanked line-preservingly so stacks keep script line numbers.

**Value boundary**: values entering the host (meta, hook options, schemas, the return value) go through `materializeFromRealm` — a plain recursive walk that rejects loud everything JSON cannot carry (exotic prototypes, functions, symbols, cycles, sparse arrays, non-finite numbers, nested `undefined`), copying via `Object.defineProperty` so a `"__proto__"` key becomes a data property, never a prototype mutation; getters are read ordinarily and their RESULT crosses (a throwing read fails loud). Values entering the realm (`args`, `agent()` results, hook promises and failures, combinator arrays) are handed over directly as host values — the script is trusted, so host prototypes are not a leak; `args` is host-`structuredClone`d once so a script cannot mutate the caller's object. Hook failures are host `WorkflowError`s: the combinators recognize fatality by host `instanceof` (unforgeable from the realm), and the script-visible consequence — in-script `instanceof Error` is `false` for hook errors; branch on `e.name`/`e.code` — is documented in the engine README. Realm functions (stages, thunks) are called, never materialized. Thrown script values are rendered by a total host-side renderer (stack → message → `String()`, fixed label if rendering throws), so `result` cannot reject. Caps (`maxConcurrentAgents` auto = `min(16, max(1, availableParallelism() - 2))`, `maxTotalAgents` 1000, `maxItemsPerCall` 4096) and timeouts are validated Config, not literals.

### The consumer (dsh-tool-workflow)

A `workflow` tool mirroring `dsh-tool-subagent`'s synchronous shape: start, await, `try/finally` dispose, abort-bridge `exec.signal`, non-`completed` → `isError`. Render intent: a `generic` card titled by a textual `meta.name` sniff (presentation is a pure function of args). The tool description IS the model-facing authoring spec. Examples load it with guidance to use workflows only on explicit user request — the harness has no ultracode-style effort gate.

### The foundation: structured output on the subagent seam

`agent({schema})` needs `SubagentStartRequest.outputSchema` to actually work; it was vocabulary without an implementation (`outputSchema: false` everywhere). Implemented in `dsh-subagent-inprocess` for both in-process backends: a globally registered `structured_output` capture tool whose per-child schema is enforced by a `prepend: true` `agent/request` listener doing FINAL-REQUEST enforcement (post-processing `await next()` — cooperative mutation would not survive a downstream listener returning a replacement request), a `prepend: true` `agent/turn-continuation` veto after capture (no wasted extra model step, and an earlier-registered force-continue listener cannot short-circuit it), validation-retry in-turn via `ToolArgsError`, and a clean-finish nudge loop (`structuredNudgeRetries`). Lifetime is refcounted by backends (plugin lifetime) AND live runs (start → settle). The seam's `outputSchema` type became the raw JSON-Schema SUBSET (`StructuredOutputSchema` in dsh-tools: single-string `type`, `properties`/`required`/`additionalProperties`, `items`, scalar `enum`/`const`; anything unenforced is rejected loud) — the schema travels verbatim to the model as the forced tool's parameters, so the wire format, not the author DSL, is the right vocabulary.

## What was rejected

- **Hostile-value containment in the host** (trap-free proxy rejection, accessor-never-invoked descriptor walks, realm-side pre-rendering of thrown values, realm-built promises/arrays/error clones with structural fatal recognition): an earlier revision built all of it, and review showed the cost was real while the threat model was not — every one of those defenses guards against an author the premise already trusts, who retains an accepted unkillable event-loop spin regardless. Removed in favor of the plain boundary above; the hardened engine deletes such machinery anyway (serialization by construction).
- **Background execution as the default** (CC's shape): deferred; foreground-synchronous matches `dsh-tool-subagent`'s cut, and background semantics should be designed ONCE across bash/subagent/workflow rather than per-tool.
- **Workflow-layer JSON parsing for `agent({schema})`**: duplicating a seam concern at one consumer while the seam's capability flag stayed dishonestly `false`.
- **Meta as tool parameters instead of `export const meta`**: zero parsing, but scripts stop being self-contained artifacts and CC-authored scripts stop being drop-in.
- **`SchemaSpec` as the outputSchema type**: the author-facing DSL cannot express what arrives as data and cannot be validated against without conversion loss.

## Deferred (documented non-goals of this cut)

- **Background collection** (start tool → run id → completion notice → collect), designed alongside bash/subagent background unification.
- **Journaling + resume** (`resumeFromRunId`, cached agent() prefixes) — the determinism bans already keep scripts resume-compatible.
- **Saved/bundled workflows** (a `.deepseek/workflows/` registry, slash-command surface) and **script persistence to a run directory** (the tool-call event already records the script durably).
- **Nested `workflow()`**, **token `budget`**, and the `effort`/`isolation`/`agentType` agent options (each rejects loud with a message naming it deferred).
- **Engine hardening**: a worker-thread or isolated-vm engine behind the same seam (kills synchronous spins; adds memory limits).
- **ACP progress UI** over the `workflow/*` events (a `/workflows`-style view); the events exist for it.
- **ACP-backend structured output** and **`toolFilter`** (both still capability-gated `false`).
