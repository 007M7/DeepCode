# Agent Note: Current sandbox policy context

Status: implemented

English | [中文](2026-07-30-current-sandbox-policy-context.zh.md)

## Problem

The sandbox policy already enforced and logged each session's file-effect mode, but a fresh model request did not contain that state. In a Web session under `read-only`, write and edit schemas remained visible, so the model claimed it could write and learned otherwise only after a denied call. After `/permission danger-full-access`, the next request carried the approval-policy change but still omitted the sandbox mode. Denial results were therefore the first model-visible policy source even when the user asked about capability before any operation.

## Decision

`dsh-sandbox-policy`, the owner of mode and workspace-root resolution, registers one `sandbox:policy` system-prompt section. Every agent request resolves the active session directly through `ctx.sandboxPolicy.resolve({ session })`; there is no denial-history scan, delta narrator, or in-memory “last told” state.

Enforcing backends register independently disposable `filesystem`, `bash`, or `terminal` family contributions with the policy owner. The section names only registered families in canonical order, and is empty without one. This is current need, not a future extension: the shipped headless inheritance composition combines sandboxed filesystem tools with unfenced one-shot bash, while the persistent-tools composition combines sandboxed filesystem tools and terminal commands without a sandboxed one-shot bash executor. A blanket statement would be false in both.

The section states only facts shared by every enforcement dialect for each registered family. `read-only` says those operations cannot modify files. `workspace-write` states the canonical session workspace with non-exclusive wording and summarizes, without enumerating, that some platform temporary areas may also be writable. `danger-full-access` says the DSH file sandbox does not restrict those operations. Backend-selected temporary paths, `/dev/null`, runner readiness, and other policy domains are absent because `resolve()` cannot establish them at request assembly.

The provider runs during normal request assembly, after a `/permission` switch has committed its existing `sandbox/mode` event and before `request/header` is logged. The rendered system text is therefore the durable reconstruction of the exact model-visible fact. Repeated assemblies over unchanged session state produce identical bytes; resume and replay fold the same durable mode event and immutable `SessionHeader.cwd` without catch-up state.

Ownership stays narrow. Approval policy remains the separate `approval:policy` section, plan mode remains `plan:policy`, and tool plugins continue to own schemas plus attempt, denial, and escalation guidance. The prompt states standing policy; filesystem, one-shot bash, and terminal backends remain the enforcement boundaries.

## Wording evidence

The wording experiment pre-registered preemptive refusal as its primary endpoint and required the old standing sentence to produce at least one refusal in twelve fresh sessions before any replacement could be judged. On 2026-07-30, commit `2bf41990401b194bd8637f07bbd90c67a9eeac75` ran `deepseek-v4-flash` through the shipped Web composition with the exact positive-control sentence `Bash commands run under the "read-only" file sandbox.` and the current tool-owned attempt guidance. The control produced zero preemptive refusals and zero speculative escalations; all twelve sessions made an ordinary bash call, observed a denial, escalated in the same turn, received approval, and landed the requested file. No sample was excluded.

The positive control therefore failed the pre-registered sensitivity gate. Candidate A and B were not run, and this experiment does not select or validate the current wording. It instead establishes that the earlier five-of-twelve result is not reproducible under this task and current tool guidance, and that a stronger positive control or different task distribution is required before making model-behavior rate claims. Deterministic tests below establish truthful request construction and replay only.

## Alternatives considered

**Narrate only mode changes.** Rejected because it leaves a fresh session uninformed and makes the first denied operation the policy-discovery mechanism. It also requires a baseline definition that is unnecessary when current state can be rendered directly.

**Scan denial history or remember the last narrated mode.** Rejected because denial events describe attempted operations, not authoritative current state, while process-local bookkeeping does not survive resume. The owner can fold the durable policy directly on every request.

**A generic runtime-facts registry.** Rejected because the existing system-prompt registry already evaluates owner-provided sections with the live agent at request time. One policy owner has no cross-domain invariant that justifies another package or registry.

**Repeat tool schemas or approval and plan guidance in the section.** Rejected because those surfaces already have owners and independent lifecycles. Duplicating them would create contradictory request prefixes and broaden invalidation.

**Keep sandbox mode absent because a standing mode label once caused preemptive refusal.** Rejected because a fresh Web request otherwise exposes mutation tools while withholding their standing policy, producing false capability claims before the first operation. The earlier live measurement remains a required counter-test: five of twelve turns ended without a tool call under `Bash commands run under the "read-only" file sandbox.` The committed tool-owned attempt guidance postdates that measurement, so the replacement is selected through a new positive-control experiment under the current tool contract rather than assuming the old and current conditions match.

**A separate model-context package.** Rejected because Cordis services can observe current runtime contributions directly, while approval and plan policy sections already live with their owners. A new package would add a shallow composition seam and documentation/gate surface for one internal adapter.

**Enumerate writable temporary roots.** Rejected because the backend is selected later at `confine()`: bwrap, Landlock, Seatbelt, and the in-process filesystem fence do not grant one common temporary-path set. Host-specific paths in a standing request would be both unstable and overclaimed.

## Consequences

A model can answer what registered file operations the standing mode governs before probing a tool, and the next request after `/permission` reflects the committed mode. This adds a small dynamic system section and intentionally invalidates the request prefix when policy or enforcing-family composition changes; unchanged state remains cache-stable. The statement is guidance, not an enforcement guard: runtime safety still comes from the registered filesystem, one-shot bash, and terminal backends consuming the same resolved policy.

Focused tests pin all modes, family combinations, contribution disposal, canonical roots, switch timing, and byte stability across different `TMPDIR` values. Keyless assembled snapshots pin the request header through real Loader compositions, including all three families. Keyless replay owns the neutral denial-to-escalation trajectory; it is a structural regression proof, not wording-selection evidence.
