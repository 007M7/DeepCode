# @deepseek-ai/dsh-client-ui-models

English | [中文](README.zh.md)

Models settings plugin: the provider configuration page and official-DeepSeek first-run credential overlay. It joins three wire domains into one shared snapshot — `llm.providers` (the configurable-provider directory with each route's live/dormant state), `settings.describe` (serialized schemas, layered redacted values, secret slots), and `credentials.describe` (value-free configured/source/writable badges) — and renders provider rows with one editor card at a time.

Rows are the *configured* providers (their profile resolves in the owning namespace); a whole-section provider whose key is not configured anywhere (the first-run DeepSeek posture) renders as its open setup card instead of a row, and the add flow is a card carrying the dormant-directory provider select — a bare-mounted `llm-pi-ai` offers its whole installed catalog before any route exists. The editor is a hand-written card per adapter family: the primary field is a single **API key** input — the page never asks for an environment-variable name; a typed key stores **write-only** through `credentials.set` under the profile's reference, deriving `<ROUTE>_API_KEY` when the profile has none, and the pi-ai profile records that derivation as `apiKeyEnv`, so `settings.yaml` never carries a key value. The collapsed 自定义设置 fold carries the curated extras — `baseURL` for both families (the deepseek placeholder shows the public endpoint), plus `reasoningEffort` (deepseek) or `reasoning` (pi-ai); every other profile field stays owned by `settings.yaml`. A row is deletable only when the user layer alone carries it (removal restores the composition base).

The first-run overlay projects `deepseek-official` readiness from that same joined snapshot. A configured literal `apiKey` secret sidecar or configured credential reference suppresses the prompt, including a read-only launch-environment credential. A mounted adapter with a writable missing reference opens the password form and writes only through `credentials.set`; success is accepted only after a fresh describe reports configured. An absent adapter is skipped because a browser form cannot mount Cordis plugins, while a present but unusable settings or credential capability produces a deployment diagnostic and an advanced link opens the Models section.

Apply semantics mirror the settings seam: an edit without removals lands as a minimal `settings.update` merge patch, while clearing a fold field back to inherited or deleting a row lands through `settings.replace` of the whole user section so removals actually take effect — safe wholesale, because the section stores key references, never key values. The page refetches on the pushed invalidations (`settings/changed`, `credentials/changed`, `models/changed`, and `connection/reset`) once it has loaded, so an external `settings.yaml` edit, a second tab, or a settings-born route converges without polling.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A reset can drop a stored literal secret in the same subtree** — a replace-carried removal cannot re-supply secrets the wire never returned; store keys behind `credentials.*` references (the product default) and the case cannot arise.
- **Only the API key and the curated fold fields are editable on the card** — the hand-written editor traded schema-generic field coverage for the mockup layout ([Agent Note](../../../.agents/notes/implemented/architecture/2026-07-30-web-config-plane.md)); advanced fields (`models`, retry policy, timeouts…) are edited in `settings.yaml`, which the fold points at. A profile schema without the conventional fields renders the hint alone, and the two curated layouts key on the `llm-deepseek`/`llm-pi-ai` namespaces by name.
- **Deleting a row leaves its stored key in `.env`** — removal replaces the settings profile but deliberately does not unset the derived credential; re-adding the provider finds the key already configured. An explicit key-removal control is deferred.
- **No per-provider model listing on the page** — the picker surfaces models; this page shows route state only. A models preview per row is deferred until a consumer needs it.
- **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rows.
