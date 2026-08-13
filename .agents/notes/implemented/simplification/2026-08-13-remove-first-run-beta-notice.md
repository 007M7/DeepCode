# Agent Note: Remove the first-run beta notice

Status: implemented

English | [中文](2026-08-13-remove-first-run-beta-notice.zh.md)

## Problem

Every GUI first launch opened with a full-viewport internal-test statement (内测声明): internal-beta framing plus instructions for enabling Session Log upload through `DSH_TELEMETRY_MODE`. Session telemetry already resolves to `DISABLED` when its mode is unset ([telemetry default-off](../feature/2026-08-10-telemetry-default-off.md)), so the only onboarding content about telemetry was a prompt explaining how to turn it on, and the internal-test framing itself must not ship in a release build.

## Decision

The first-run notice is removed from the assembled product rather than reworded. `ui-settings-general` seats no `settings.onboarding` step; the notice component, its durable acknowledgement store, its copy owner, and its locale keys are deleted. The `settings.onboarding` coordinator and its takeover stage stay ([ordered onboarding](../feature/2026-07-30-versioned-gui-welcome-onboarding.md)), and the conditional DeepSeek credential step is the only shipped occupant. The Host half still registers the `ui-onboarding` settings namespace: its `welcomeNoticeVersion` field keeps acknowledgements already stored in `$DSH_HOME/settings.yaml` valid, and nothing reads or writes it. Telemetry opt-in remains an explicit deployment environment choice documented in the repository README; the product presents no prompt about enabling it.

## Alternatives considered

**Keep the notice and only drop its telemetry paragraph.** Rejected: the internal-test framing is what a release must not present, and a mandatory first-run interstitial with no material statement left is pure friction.

**Ask for upload consent instead (a versioned consent step).** Rejected for this release: a first-run question about enabling upload is still a telemetry prompt. A future consent flow can register through the unchanged `settings.onboarding` seam and use a fresh versioned field for re-acknowledgement.

**Deregister the `ui-onboarding` namespace as well.** Rejected: existing settings documents already carry the section, and the settings seam validates stored documents against registered namespaces; keeping the registration keeps those documents valid at no cost.

## Consequences

A fresh profile boots into the credential step when the DeepSeek credential is missing and directly into the product otherwise; no full-viewport notice precedes either. The assembled onboarding scenario starts at the credential step, the remote-notice scenario is deleted with the feature, and the goal-bar fixture keeps the settings shell disabled because the fixture API client rejects settings traffic. Restoring a first-run notice requires a new onboarding registration and a new versioned field; the retained namespace does not resurrect the old acknowledgement semantics.
