# @deepseek-ai/dsh-client-ui-models

English | [中文](README.zh.md)

Models settings section plugin: the provider configuration page. It joins three wire domains into one surface — `llm.providers` (the configurable-provider directory with each route's live/dormant state), `settings.describe` (serialized schemas, layered redacted values, secret slots), and `credentials.describe` (value-free configured/source/writable badges) — and renders provider rows with one editor card at a time.

Rows are the *configured* providers (their profile resolves in the owning namespace); a whole-section provider whose key is not configured anywhere (the first-run DeepSeek posture) renders as its open setup card instead of a row, and the add flow is a card carrying the dormant-directory provider select — a bare-mounted `llm-pi-ai` offers its whole installed catalog before any route exists. The editor is a hand-written card per adapter family: the primary field is a single **API key** input — the page never asks for an environment-variable name; a typed key stores **write-only** through `credentials.set` under the profile's reference, deriving `<ROUTE>_API_KEY` when the profile has none, and the pi-ai profile records that derivation as `apiKeyEnv`, so `settings.yaml` never carries a key value. The collapsed 自定义设置 fold carries the curated extras — `baseURL` for both families (the deepseek placeholder shows the public endpoint), plus `reasoningEffort` (deepseek) or `reasoning` (pi-ai); every other profile field stays owned by `settings.yaml`. A row is deletable only when the user layer alone carries it (removal restores the composition base).

Every edit lands as `settings.mutate` path ops against the stored section — a set per changed field, an unset per cleared one, and a single unset for a deleted row. The page only ever holds the REDACTED descriptor, so it names the fields it can see rather than rebuilding a section: a stored literal secret it never received is mentioned by no op and survives. Each write carries the `revision` the card opened at, so a concurrent write from another tab or an external `settings.yaml` edit is refused as `settings-conflict` and the card asks the user to reopen instead of replaying its stale snapshot. The page refetches on the pushed invalidations (`settings/changed`, `credentials/changed`, `models/changed`, and `connection/reset`) once it has loaded, so an external `settings.yaml` edit, a second tab, or a settings-born route converges without polling.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Only the API key and the curated fold fields are editable on the card** — the hand-written editor traded schema-generic field coverage for the mockup layout ([Agent Note](../../../.agents/notes/implemented/architecture/2026-07-30-web-config-plane.md)); advanced fields (`models`, retry policy, timeouts…) are edited in `settings.yaml`, which the fold points at. A profile schema without the conventional fields renders the hint alone, and the two curated layouts key on the `llm-deepseek`/`llm-pi-ai` namespaces by name.
- **Deleting a row leaves its stored key in `.env`** — removal unsets the settings profile but deliberately does not unset the derived credential; re-adding the provider finds the key already configured. An explicit key-removal control is deferred.
- **No per-provider model listing on the page** — the picker surfaces models; this page shows route state only. A models preview per row is deferred until a consumer needs it.
- **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rows.
