# @deepseek-ai/dsh-client-ui-models

English | [中文](README.zh.md)

Models settings plugin: the provider configuration page and official-DeepSeek first-run credential overlay. It joins three wire domains into one shared snapshot — `llm.providers` (the configurable-provider directory with each route's live/dormant state), `settings.describe` (serialized schemas, layered redacted values, secret slots), and `credentials.describe` (value-free configured/source/writable badges) — and renders provider rows with one editor card at a time.

Rows are the *configured* providers (their profile resolves in the owning namespace); the add select's vocabulary is every dormant directory entry, so a bare-mounted `llm-pi-ai` offers its whole installed catalog before any route exists. The editor renders the provider's profile subtree through [`@deepseek-ai/dsh-client-schema-form`](../schema-form); the `credential-ref` role mounts the credential control, which shows the reference's live state and stores key values **write-only** through `credentials.set` — no value ever renders back. A row is deletable only when the user layer alone carries it (removal restores the composition base).

The first-run overlay projects `deepseek-official` readiness from that same joined snapshot. A configured literal `apiKey` secret sidecar or configured credential reference suppresses the prompt, including a read-only launch-environment credential. A mounted adapter with a writable missing reference opens the password form and writes only through `credentials.set`; success is accepted only after a fresh describe reports configured. An absent adapter is skipped because a browser form cannot mount Cordis plugins, while a present but unusable settings or credential capability produces a deployment diagnostic and an advanced link opens the Models section.

Apply semantics mirror the settings seam: an edit without removals lands as a minimal `settings.update` merge patch (stored secrets outside the patch survive), while a field reset or row deletion lands through `settings.replace` of the whole user section so removals actually take effect. The page refetches on the pushed invalidations (`settings/changed`, `credentials/changed`, `models/changed`, and `connection/reset`) once it has loaded, so an external `settings.yaml` edit, a second tab, or a settings-born route converges without polling.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A reset can drop a stored literal secret in the same subtree** — a replace-carried removal cannot re-supply secrets the wire never returned; store keys behind `credentials.*` references (the product default) and the case cannot arise.
- **No per-provider model listing on the page** — the picker surfaces models; this page shows route state only. A models preview per row is deferred until a consumer needs it.
- **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rows.
