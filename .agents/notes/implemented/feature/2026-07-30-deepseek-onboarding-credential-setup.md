# Agent Note: official DeepSeek first-run credential setup

Status: implemented

English | [中文](2026-07-30-deepseek-onboarding-credential-setup.zh.md)

## Problem

The [web configuration plane](../architecture/2026-07-30-web-config-plane.md) makes provider settings and credentials live-editable, but a first-time user still lands on the empty conversation Hero without an actionable explanation when the shipped `deepseek-official` route has no credential. The Models page can repair that state, yet requiring the user to discover it weakens onboarding. A prompt must not confuse a missing credential with a missing adapter: the browser can store a value for an existing credential reference, but it cannot dynamically mount the `llm-deepseek` Cordis plugin.

## Decision

**One readiness projection owns both Models and onboarding facts.** `ui-models` keeps a single store that joins `llm.providers({})`, redacted `settings.describe({})`, and batched `credentials.describe({refs})`. The onboarding projection selects the `deepseek-official` configurable-provider entry, resolves its `settingsNs` and `settingsPath`, reads the effective `apiKeyEnv`, and evaluates the matching credential descriptor. A configured literal `apiKey` secret sidecar is also ready, so compatibility configuration does not trigger a false prompt; a configured process-environment credential is ready and remains read-only.

**The settings shell contributes navigation state, not provider policy.** `ui-settings` declares a root-scoped `settings.onboarding` list slot and tells registrants whether the current surface is the empty Hero. Its private `openSection(id)` callback opens the settings panel on one registered section. `ui-models` registers the DeepSeek overlay through the same declaration-aware deferred-registration path as its Models section, so plugin load order does not become a contract.

**The prompt is a credential-only write path.** A mounted, active adapter with a resolved, writable, unconfigured reference presents a password input. Submit calls only `credentials.set({ref, value})`, clears the React draft after success, refetches the shared join, and closes only when the new descriptor reports `configured: true`. Business failures and transport rejections keep the dialog open, restore its busy state in `finally`, and redact the submitted value from rendered error text. The prompt never writes `apiKey`, `baseURL`, or a redacted settings section; advanced configuration opens Models instead.

**Unavailable capability states stay honest.** An absent configurable-provider entry suppresses the form because it cannot repair the composition. A present provider whose settings or credential capability cannot be resolved renders an actionable deployment diagnostic. Cancel dismisses the overlay for the current mounted surface and writes no completion fact. Settings, credential, provider-topology, and connection invalidations all refresh the shared join, so an external credential update closes an open prompt without a reload.

## Alternatives considered

**A separate onboarding store and readiness RPC sequence** — rejected because it would create a second client-side interpretation of provider identity, settings paths, secret sidecars, credential references, and invalidation ordering beside the Models page.

**Writing the API key into provider settings** — rejected because a literal secret would enter the settings mutation path and whole-section replacement cannot safely reconstruct redacted values. Credential storage is already the product seam and supplies immediate invalidation.

**Showing the same key form when `llm-deepseek` is absent** — rejected because success would only store an unused environment reference; the browser has no supported operation that mounts the missing Cordis plugin.

## Consequences

The first-run flow now repairs the shipped adapter without restarting: a keyless browser test boots the real Web composition under an isolated harness home, observes the dialog, stores a generated key into that home's `.env`, verifies no key reaches DOM, ARIA, or browser console output, and confirms the running Models page reports configured. Pure readiness and React tests pin literal, file, process-environment, missing-provider, missing-capability, business-error, transport-error, cancellation, and external-invalidation behavior. The flow deliberately inherits the configuration plane's documented base limitations rather than adding local secret storage, redaction, or settings replacement workarounds.
