# Agent Note: Persist Web user preferences through Host settings

Status: implemented

English | [中文](2026-08-06-host-backed-web-preferences.zh.md)

## Problem

The Web Appearance, Language, and busy-Enter preferences lived in browser `localStorage`. Browser storage is scoped to an origin, so reopening `dsh web` on another port selected a different partition and lost choices even though both processes used the same DSH home. These are user-level product preferences; session selection, drafts, disclosure state, and other transient browser state remain page-local.

The first theme implementation moved only Appearance to Host settings but awaited its initial RPC before providing `ThemeService`. A slow or unavailable settings request therefore suspended the assembled page. It also subscribed after the read, could miss an invalidation in that window, did not carry namespace revisions on writes, and allowed queued writes from a disposed plugin to reach the Host.

## Decision

The owning Host halves register three schemas: optional `locale.preference` (`zh` or `en`, where absence delegates to the browser), `ui-theme.preference` (`light`, `dark`, or `system`, default `system`), and `ui-conversation.busyEnter` (`queue` or `steer`, default `queue`). The local settings provider stores explicit choices in `$DSH_HOME/settings.yaml`, which resolves to `~/.dsh/settings.yaml` under the default home. The API proxy explicitly exposes all three namespaces beside the other Web settings; registration alone never crosses that configuration boundary.

The client runtime provides one `bindSettingsPreference` lifecycle for scalar preferences. It installs `settings/changed` and `connection/reset` listeners before starting a background initial read, so no settings transport can block plugin activation and an invalidation cannot fall into a read-before-subscribe gap. Domain services publish their provisional defaults immediately—browser-derived locale, system theme, and Queue—then accept a validated Host value without writing it back.

User changes update the live service synchronously and queue a `settings.mutate` path operation. The controller serializes gestures, sends the latest known namespace revision as `expectedRevision`, records every successful revision, and lets only the latest write settlement republish live state. A rejected or failed latest write reloads Host state. Disposal rejects new work, skips queued operations, suppresses publication by the in-flight operation, and waits for that operation to settle before the plugin reaches quiescence.

Remote browsers cannot call the loopback-only configuration API, so their preferences remain process-local. Dynamic third-party theme ids remain in-process extensions outside the built-in Host schema; removing one resets the live registry without replacing the last durable built-in preference.

## Alternatives considered

**Keep `localStorage` and copy values between ports.** One origin cannot enumerate another origin's storage, and a Host relay would recreate the settings service around a browser-specific format.

**Mirror Host settings into `localStorage`.** A second authority requires boot and invalidation conflict rules while retaining the partition that caused the defect. The Host document is the sole durable source.

**Await the initial read to avoid a provisional render.** Configuration availability is not a prerequisite for drawing the page. A background read may cause one live convergence, but it keeps failure isolated and preserves the existing browser/system/default fallbacks.

**Give every domain its own settings controller.** The concurrency, revision, failure, invalidation, and disposal rules are identical; copying them already produced lifecycle drift in the theme implementation. Domain-owned schemas and decoders keep product policy out of the shared runtime.

**Move every `localStorage` entry into settings.** Current session, drafts, panel disclosure, trajectory display state, and similar entries are browser-instance state rather than user configuration. Promoting them would synchronize transient navigation state across tabs and ports without a product contract.

## Consequences

Appearance, Language, and busy-Enter choices follow the DSH user home across reloads, ports, and loopback origins. Direct edits to `settings.yaml` converge through the existing invalidation stream, while legacy `dsh.theme`, `dsh.locale`, and `dsh.conversation.busyEnter` entries are neither read nor written.

Boot may briefly show the domain default before the background read settles. A transient read failure keeps that default or the last good in-process value; reconnect retries. A write rejection can visibly restore the durable preference after the immediate local change.

Focused unit coverage pins schema registration, listener-before-read ordering, nonblocking activation, revisioned ordered writes, stale-response containment, failure recovery, disposal quiescence, and remote memory mode. The keyless Web settings scenario writes all three preferences through the UI, verifies the YAML document and empty legacy storage, reloads, and boots another Host on a distinct port against the same DSH home.
