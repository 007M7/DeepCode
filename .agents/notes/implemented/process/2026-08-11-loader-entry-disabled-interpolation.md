# Agent Note: Loader interpolates the entry `disabled` field

Status: implemented

English | [中文](2026-08-11-loader-entry-disabled-interpolation.zh.md)

## Problem

The Windows platform layer (`packages/bundle/base/windows.cordis.patch.yml`) disables `tool-bash` on win32, but the shipped presets each mount a `tool-bash` row. Preset rows compose last, so the same-id row re-enabled the tool on Windows — the session had both `tool-bash` (PowerShell-backed) and `tool-pwsh`, silently, because no spec pinned the composed preset layer. Entry metadata had no conditional mechanism: `!!js` interpolates only under plugin `config`, and [postmortem 0002](../../../../docs/postmortem/0002-js-expression-disabled-filesystem-tools.md) documents that `disabled: !!js ...` stays a truthy expression object, disabling the row everywhere.

## Decision

The Loader interpolates the entry `disabled` field (`vendor/loader/src/config/entry.ts`): a `!!js` expression evaluates against the loader context at every mount decision. `disabled` is the only interpolated metadata field; `id`, `name`, `group`, and `inject` stay static. The raw node stays in the options, so write-back keeps the `!!js` form. The shipped presets (standard, code, cordis) gate `tool-bash` with `disabled: !!js process.platform === 'win32'`, and `verify-cordis-config` now allows expressions in `disabled` only.

## Alternatives considered

**A declarative `platform` field on the row.** Static and gate-checkable, but a second composition mechanism beside `!!js`, and platform is only today's condition.

**Preset-level platform overlays.** Rejected: the condition belongs on the row it governs.

## Consequences

A row can gate itself on platform or environment; a bad expression fails loud at boot. Every other metadata field remains literal and the gate keeps rejecting expressions there — the postmortem-0002 hazard is closed for `disabled` by evaluation, not prohibition. The `minimal` preset's missing win32 PTY stack is a preset-metadata follow-up.
