# @deepseek-ai/dsh-client-i18n

i18n plugin: I18nService (ns×locale dictionaries, bind(ns)→t with a stable function identity, locale store). Contract: api-contracts v3 §8.

## Model Experience

None, as the i18n registry serves browser UI copy; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **zh/en ship as empty structures** — the existing UI copy is inline Chinese; extraction into dictionaries is deferred repo-wide work, so `bind(ns)` consumers today mostly receive key-echo fallbacks.
- **Locale switching re-renders the whole tree** — accepted as a low-frequency operation; no per-namespace subscription granularity.
