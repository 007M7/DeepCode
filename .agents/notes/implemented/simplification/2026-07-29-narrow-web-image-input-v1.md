# Agent Note: Narrow Web image input version one

Status: implemented

English | [中文](2026-07-29-narrow-web-image-input-v1.zh.md)

## Problem

The first durable Web image-input slice also introduced speculative surfaces for multiple-image transactions, arbitrary CLI provider mounting, output-modality discovery, alternative text, and provider-neutral visual token pricing. None was required to paste or drop one image, persist it before its message event, replay it through a visual adapter, or render it from authorized history. Keeping those surfaces would turn unchosen future behavior into public contracts and make the initial capability harder to review and maintain.

## Decision

Version one accepts at most one image in a submitted prompt. The client gives immediate feedback, the host enforces the invariant, and the attachment seam validates and commits that one object. Deployment configuration retains per-image byte and pixel limits; request buffering derives from the per-image byte limit. There is no batch prevalidation, aggregate byte limit, image-count setting, transaction layer, or rollback protocol.

The CLI only patches the selected provider and model. The boot composition must already register the route, as it does for the shipped DeepSeek, OpenAI, and Anthropic routes; the CLI does not inspect the yml provider roster or dynamically mount an adapter.

Exact-model metadata carries only the input modalities that current admission decisions consume. `ImageBlock` carries the durable attachment reference; its optional display name supplies accessible UI text, so the core block has no separate alternative-text field. Provider-neutral token estimation does not apply one provider's visual pricing formula to other routes.

The attachment seam exposes its limits plus `saveImage` and `readImage`. The host depends on that seam rather than implementation re-exports. Browser draft and historical-image operations remain concrete conversation-plugin internals; the public `IConversation` face contains only the input registry and the scoped send, cancel, and history verbs used across package boundaries.

## Alternatives considered

**Keep multiple images and add transaction or rollback machinery.** Without garbage collection, a partially persisted batch needs an ownership or reclamation design. One image satisfies the initial user path without creating that lifecycle.

**Keep future-facing fields and methods as placeholders.** Output modalities, block alternative text, batch validation, and active-model handshake data had no current decision consumer. Adding them later with their first consumer preserves freedom to choose the correct contract.

**Estimate every image with one tile formula.** Visual pricing varies by provider, model, detail mode, and preprocessing. A hard-coded provider-neutral estimate would look authoritative while being wrong; provider usage is the authoritative accounting source.

**Mount any CLI-selected provider dynamically.** Configuration already owns plugin composition and credentials. Making selection also mutate composition duplicates that responsibility and requires parsing the config tree outside the loader.

## Consequences

The initial feature has fewer public fields, lifecycle operations, configuration knobs, and route-assembly branches. A prompt needing multiple images is rejected and must wait for an explicit multi-image persistence design. A provider absent from the composition cannot be selected solely with CLI flags. Pre-request token pressure may undercount visual input until a provider-aware estimator is designed, while reported usage remains exact.

Reintroducing any removed surface requires a concrete consumer and its failure, lifecycle, replay, and testing contract rather than compatibility with this pre-release shape.
