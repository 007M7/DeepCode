# Agent Note: Current sandbox policy context

Status: implemented

English | [中文](2026-07-30-current-sandbox-policy-context.zh.md)

## Problem

The sandbox policy already enforced and logged each session's file-effect mode, but a fresh model request did not contain that state. In a Web session under `read-only`, write and edit schemas remained visible, so the model claimed it could write and learned otherwise only after a denied call. After `/permission danger-full-access`, the next request carried the approval-policy change but still omitted the sandbox mode. Denial results were therefore the first model-visible policy source even when the user asked about capability before any operation.

## Decision

`dsh-sandbox-policy`, the owner of mode and workspace-root resolution, registers one `sandbox:policy` system-prompt section. Every agent request resolves the active session directly through `ctx.sandboxPolicy.resolve({ session })`; there is no denial-history scan, delta narrator, or in-memory “last told” state.

The section states the current file-effect mode and only its owned consequences. `read-only` says ordinary writes, edits, and file-mutating shell effects are denied while required sinks may remain writable. `workspace-write` lists the canonical writable roots returned by the shared `writableRoots()` policy: the immutable session workspace root, `/tmp`, and the platform temporary directory, deduplicated after canonicalization. `danger-full-access` says the DSH file sandbox adds no file restriction. Every form says host permissions or backend availability may restrict more and that network and process access are outside this policy.

The provider runs during normal request assembly, after a `/permission` switch has committed its existing `sandbox/mode` event and before `request/header` is logged. The rendered system text is therefore the durable reconstruction of the exact model-visible fact. Repeated assemblies over unchanged session state produce identical bytes; resume and replay fold the same durable mode event and immutable `SessionHeader.cwd` without catch-up state.

Ownership stays narrow. Approval policy remains the separate `approval:policy` section, plan mode remains `plan:policy`, and tool plugins continue to own schemas and operation guidance. The prompt states policy; bash and filesystem backends remain the enforcement boundaries.

## Alternatives considered

**Narrate only mode changes.** Rejected because it leaves a fresh session uninformed and makes the first denied operation the policy-discovery mechanism. It also requires a baseline definition that is unnecessary when current state can be rendered directly.

**Scan denial history or remember the last narrated mode.** Rejected because denial events describe attempted operations, not authoritative current state, while process-local bookkeeping does not survive resume. The owner can fold the durable policy directly on every request.

**A generic runtime-facts registry.** Rejected because the existing system-prompt registry already evaluates owner-provided sections with the live agent at request time. One policy owner has no cross-domain invariant that justifies another package or registry.

**Repeat tool schemas or approval and plan guidance in the section.** Rejected because those surfaces already have owners and independent lifecycles. Duplicating them would create contradictory request prefixes and broaden invalidation.

**Keep sandbox mode absent because a standing mode label once caused preemptive refusal.** Rejected by the later Web evidence and the completed cross-family policy. The earlier sentence named only a bash sandbox and did not explain the actual write/edit boundary, so it could conflict with visible tools and escalation guidance. The owner-derived section states the complete current file-effect consequence, canonical workspace scope, and explicit non-guarantees without duplicating tool instructions. This supersedes only the absence decision in the [sandbox Agent Note](2026-07-06-sandbox.md); its enforcement and escalation boundaries remain current.

## Consequences

A model can answer what file effects are currently possible before probing a tool, and the next request after `/permission` reflects the committed mode. This adds a small dynamic system section and intentionally invalidates the request prefix when policy changes; unchanged state remains cache-stable. The statement is guidance, not an enforcement guard: runtime safety still comes from `dsh-bash-sandbox` and `dsh-fs-sandbox` consuming the same resolved policy.

Focused sandbox-policy tests pin all three texts, canonical roots, switch timing, byte stability, and replay. A keyless assembled ACP snapshot pins the request header through the real Loader composition, while the Web browser scenario drives `/permission` across all modes, inspects each exact `request/header`, and checks the model completes without a probing tool call; record mode exercises the real provider.
