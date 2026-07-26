# @deepseek-ai/dsh-client-locale

English | [中文](README.zh.md)

Locale plugin: LocaleService — the browser locale preference (`zh`/`en`, persisted under `dsh.locale`, getter/setter with `locale/change` snapshots) plus the ns×locale dictionary registry (`bind(ns)`→t with a stable function identity; lookup chain active → zh → key).

## Model Experience

None, as the locale registry serves browser UI copy; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Only the Settings surface is translated** — other pages keep inline copy; repo-wide extraction into dictionaries is deferred.
- **Locale switching re-renders subscribed consumers only** — sections not wired to `locale/change` keep their rendered text until remount.
