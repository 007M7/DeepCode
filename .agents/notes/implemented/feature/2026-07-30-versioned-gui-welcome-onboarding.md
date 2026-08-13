# Agent Note: Versioned GUI welcome onboarding

Status: implemented

English | [中文](2026-07-30-versioned-gui-welcome-onboarding.zh.md)

## Problem

The GUI's credential onboarding begins with a DeepSeek-specific readiness check, but the internal-test notice applies to every user and must precede provider setup even when a credential is already configured. Treating both as independent overlays permits simultaneous dialogs, while a process-local dismissal cannot distinguish a completed notice from a window closed before acknowledgement or intentionally present revised copy once.

## Decision

**The Settings shell coordinates ordered steps.** `settings.onboarding` remains a root-scoped list, but `ui-settings` projects its entry ids and order into one coordinator and mounts only the first incomplete step. The active registrant receives `complete()` and `openSection(id)`; no later step mounts until ownership transfers. `ui-settings-models` registers the conditional DeepSeek readiness and credential-routing step at order `0`, the only shipped occupant since the [first-run beta notice removal](../simplification/2026-08-13-remove-first-run-beta-notice.md).

**The product welcome step is removed.** The versioned notice, its copy owner, and its acknowledgement store shipped from this decision until the [first-run beta notice removal](../simplification/2026-08-13-remove-first-run-beta-notice.md), which owns the removal rationale; `ui-settings-general` seats no onboarding step.

**The durable `ui-onboarding` section outlives the notice.** The Host half registers it in the user-settings seam under the active `$DSH_HOME/settings.yaml`; its `welcomeNoticeVersion` field keeps stored acknowledgements valid and has no reader. The connection plugin publishes whether the current page uses a loopback authority as `ctx.connection.isLoopback`; hostname classification remains internal to the connection package, and other client plugins consume the service state instead of importing its implementation. The API proxy exposes this one product namespace through a closed allowlist beside configurable-provider namespaces, without treating its changes as model-catalog invalidations.

**Onboarding temporarily owns the viewport as one continuous stage.** A solid product surface replaces the complete application view through a body-level portal and marks the underlying app root inert; the exact required mask remains mounted behind that surface with `position:absolute`, zero left/right/bottom offsets, `top:80px`, `rgba(0, 0, 0, 0.24)`, and `backdrop-filter: blur(2px)`. Onboarding steps render as successive pages in this stage instead of independent modals, reusing the Web UI's black `BrandWordmark`; the conditional credential setup is the only shipped page.

## Alternatives considered

**Browser local storage** — rejected because acknowledgement would follow one browser profile rather than `$DSH_HOME`; a fresh Harness profile could incorrectly inherit a prior acknowledgement, and external profile edits would have no authoritative update stream. Non-loopback fallback therefore remains process-local rather than browser-profile-local.

**A second independent modal in `ui-settings-general`** — rejected because list registrants would still stack whenever welcome and credential readiness were both true. Ordered ownership belongs to the shell that declares and renders the list.

**Persisting on render or window close** — rejected because observation is not acknowledgement and close delivery is unreliable. Only the explicit Continue commit may suppress the next launch.

**A generic public settings-exposure flag** — rejected because one product namespace does not justify widening every settings registrant's public configuration surface. The gateway keeps an explicit closed allowlist.

## Consequences

A fresh profile proceeds directly to provider-specific onboarding: the conditional DeepSeek step mounts when its credential is missing, and an already configured credential shows no onboarding page at all. Focused store and React tests pin coordinator ordering, conditional DeepSeek transfer, and HMR cleanup. The real Chromium scenario boots the shipped Web composition with an isolated harness home, verifies the exact mask geometry and computed styles while the credential step owns the viewport, continues into missing-credential setup, and checks the browser console.
