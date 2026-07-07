# RFC: Explicit model-facing tool order

Status: implemented

## Problem

The order of the tool list a model call carries — `request/header.tools` on the session log and `GenerateOptions.tools` on the wire — was an emergent artifact: the tool registry returns schemas in registration order, the system-prompt assembly concatenates providers in registration order, and the loop logged and dispatched the result verbatim. Registration order is plugin load order, and plugin load order is a race: the cordis loader imports every `cordis.yml` entry concurrently, so which tool plugin registers first depends on module-import completion timing. The plugin dependency relation cannot rescue this — it is a partial order under which independent tool plugins (e.g. `tool-subagent` vs `tool-todo`) are incomparable, so both interleavings are legal linearizations. This stopped being theoretical when a CI runner resolved the race differently from every recording machine: snapshot goldens pinned one permutation of `request/header.tools`, the `node 22.18` CI leg produced the other, and 5/5 snapshot tests failed on a diff that was pure array reordering. Tool order is part of the request bytes (prompt-cache stability, potentially model behavior) and, since the reconstructability contract, part of the durable session log — it must be a decision, not a residue.

## Decision

The system-prompt assembly owns the canonical model-facing tool order, exactly where it already owns section order:

- **One config key on `dsh-system-prompt`.** `toolOrder?: string[]` names tools in the exact order to send. A listed tool takes its listed position; a listed name with no registered tool is ignored (a deployment may list optional tools it does not always load); tools absent from the list are inserted at the `'...'` rest entry (`TOOL_ORDER_REST`), in lexicographic name order among themselves. The list must contain `'...'` exactly once and no duplicate names — violations throw from the service constructor, failing the fiber at load, never mid-conversation. When `toolOrder` is unset, the canonical order is plain lexicographic name order (code-unit comparison, locale-independent) — determinism requires no configuration.
- **Applied where the list is born: `assemble()`, before the `system-prompt/assemble` waterfall.** The assembly canonicalizes the tools it collects from providers the same way it sorts sections by their `order` field — on the initial assembly, killing the registration-order entropy at its source. Everything downstream inherits the order untouched: the waterfall, the loop's `EpochHeader`, the `request/header` event, the deep-frozen request, and the dev invariant's cross-check all see one deterministic list, with no new service surface and no loop change.

Scope is deliberately narrow: this fixes the REGISTRATION-ORDER race, not plugin behavior. A `system-prompt/assemble` listener may still add, remove, or rearrange tools — same as it may edit sections after their sort — and owns the determinism of what it emits; the waterfall contract already demands deterministic listeners (the reconstructability invariant would catch a listener that diverges between build and replay).

Config plumbing follows the `persona` precedent, and `toolOrder` sits beside it: the app configs (`dsh-stdio-agent`, `dsh-acp-agent`) accept the key and forward it through `dsh-agent-core` (whose schema is the intersection of the owners' schemas) to the `SystemPrompt` child. One schemastery footnote is load-bearing: a schemastery array defaults to `[]`, but an omitted `toolOrder` must stay ABSENT (= lexicographic) rather than become an explicitly-configured empty list (invalid — it lacks `'...'`), so every schema on the chain forces the default to `undefined`.

## Alternatives considered

- **Registration order (the status quo)** — a concurrent-import race, host-dependent (the CI flake above), invisible in review.
- **A linearization of the plugin dependency graph** — the relation is partial and independent tool plugins are incomparable; the flake happened with the partial order fully satisfied.
- **Per-plugin `weight` on each tool contribution** — scatters the order across plugins yet still needs a global numbering convention nobody owns (the section `order` bands show that coordination cost being paid by hand).
- **Sorting in `ToolRegistry.schemas()` (the registry layer)** — equally deterministic, but the registry is a membership store consumed by more than the assembly; ordering is a prompt-composition concern, and the assembly already owns the composition policy for sections.
- **A `LlmService` config + `orderTools()` method the loop calls before logging the header** — works, but adds a public service method and a loop edit solely to apply a policy at a distance; every future request composer must remember the call. Canonicalizing where the list is born makes an unordered list unrepresentable, with zero new surface.
- **Normalizing inside `llm.stream()`** — runs after the header event is logged (the flake survives) and rebuilds the deep-frozen envelope, silently disarming the reconstruction invariant.
- **An exhaustive list (no `'...'` rest entry)** — every newly loaded tool plugin would break boot; the mandatory rest entry keeps unlisted tools deterministic and their position explicit.

## Consequences

- Every assembly — and therefore every `request/header` event and model request — has a deterministic tool order on every host; the CI-vs-local golden flip is structurally gone. The default order is lexicographic, no longer registration order.
- `PromptAssembly.tools` itself is canonical, so every assembly consumer (the loop, waterfall listeners, any future prompt inspector) sees the model-facing order; provider registration order is observable nowhere downstream of the registry.
- The snapshot suite's single pinned request-header fixture (`text-turn`) carries the new canonical tool order; every other ACP snapshot keeps the header bulk scrubbed as `{{system}}`/`{{tools}}`, per the pinned-header design.
- A pure tool reordering between steps is representable only as a `request/header` `'fallback'` snapshot (the name-keyed `ToolsDelta` cannot express it); with a stable canonical order such reorders no longer occur in practice, so the fallback path stays a safety valve.
- The `toolOrder` key rides the app → `agent-core` → `SystemPrompt` forwarding chain, so deployments set it next to `persona` in the app config; `dsh-llm` and the agent loop are untouched.

## Testing

Unit tests on `dsh-system-prompt` pin the ordering semantics (lexicographic default, listed/ignored/rest placement, stable handling of shared names, provider-order independence), the pre-waterfall contract (listeners observe the canonical list; a listener-appended tool is not re-sorted), and each invalid-list rejection at load. Loop-level tests assert the `request/header` fold carries the canonical order for scrambled registration orders (identical across permutations), that a configured `toolOrder` reaches both the logged header and the dispatched deep-frozen request, and that the frozen loop-built envelope survives to the adapter. Forwarding is asserted at every level that exposes the key (`dsh-agent-core`, `dsh-stdio-agent`, `dsh-acp-agent`). The snapshot tier replays all scenarios while only the pinned `text-turn` header carries the full canonical tool list; non-pinning fixtures continue to compare through `{{tools}}`.
