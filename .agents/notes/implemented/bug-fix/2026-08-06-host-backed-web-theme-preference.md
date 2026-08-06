# Agent Note: Persist the Web theme through Host settings

Status: implemented

English | [中文](2026-08-06-host-backed-web-theme-preference.zh.md)

## Problem

The Web theme preference lived in browser `localStorage`. Browser storage is scoped to an origin, so reopening `dsh web` on another port selected a different storage partition and returned to the default system theme even though both processes used the same DSH home.

The theme is a user-level product preference rather than page-local state. DSH already has a user-settings service with a file-backed provider, a loopback-only configuration wire, and invalidation frames for external edits and other tabs.

## Decision

The `@deepseek-ai/dsh-client-ui-theme` Host half registers `ui-theme.preference` with the built-in `light`, `dark`, and `system` values and a `system` default. The local settings provider stores an override in `$DSH_HOME/settings.yaml`, which resolves to `~/.dsh/settings.yaml` under the default home.

The loopback client loads that namespace before it provides `ThemeService`, so the initial presenter snapshot reflects the durable preference without relying on an origin cache. `ThemeService.setTheme` still changes the live snapshot synchronously; its persistence callback sends a `settings.mutate` path operation. The controller serializes rapid selections in gesture order, ignores stale settlements, reloads after a rejected latest write, and refetches on `settings/changed` or `connection/reset`.

The API proxy explicitly exposes `ui-theme` beside `permission` and `ui-onboarding`. Registration alone remains insufficient to cross the configuration boundary. Remote browsers cannot call the privileged settings API and retain only a process-local selection.

Only the built-in product preferences cross the Host schema. Third-party registered theme ids remain an in-process extension because the Host cannot validate a browser plugin's dynamic registry during startup.

## Alternatives considered

**Keep `localStorage` and copy values between ports.** One origin cannot enumerate another origin's storage, and a Host-side relay would recreate a settings service around a browser-specific format.

**Use a cookie without an explicit port.** Cookies would couple preference durability to the served hostname, still split localhost aliases, and introduce HTTP state outside the user-settings ownership model.

**Mirror Host settings into `localStorage`.** A second authority creates boot and invalidation conflict rules while retaining the origin partition that caused the defect. The Host document is the sole durable source.

**Expose every registered settings namespace.** Automatic exposure would let an unrelated plugin become remotely configurable by registering with the general settings seam. The API proxy keeps an explicit allowlist.

## Consequences

Theme selections follow the DSH user home across reloads, ports, and loopback origins, and direct edits to `settings.yaml` converge through the existing invalidation stream. The settings document contains a readable section such as `ui-theme: { preference: dark }`; no theme value is written to `localStorage`.

Startup performs one loopback settings read before publishing the theme service. A transient read failure keeps the system default or last good in-process value and reconnect can retry. A write rejection can visibly restore the durable preference after the immediate theme change.

Unit coverage pins schema registration, ordered writes, stale-response containment, failure recovery, invalidation refresh, and remote memory mode. The real Web settings scenario writes dark through the UI, verifies the YAML document, reloads, and boots a second Host on another port against the same DSH home with an empty theme `localStorage` partition.
