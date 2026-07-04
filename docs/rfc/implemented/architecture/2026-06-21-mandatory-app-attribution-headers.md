# RFC: Mandatory app-attribution headers for provider requests

Status: implemented

## Problem

LLM provider requests should identify the product making them. That is useful for provider-side support, abuse investigation, compatibility debugging, traffic analytics, and public app attribution where a provider exposes it. Before this RFC the harness only partially did this: the hand-rolled DeepSeek adapter sent a hand-copied `User-Agent` constant (`packages/llm/llm-deepseek/src/adapter.ts`), while the pi-ai-backed twin sent no harness-owned headers at all (`packages/llm/llm-pi-ai/src/adapter.ts`). New adapters could therefore omit attribution silently, and a library-backed adapter could drift from the hand-rolled adapter even though [the twin-adapter RFC](2026-06-13-twin-llm-adapters.md) exists to keep the provider seam honest across both implementations.

The immediate prompt came from OpenRouter's [App Attribution](https://openrouter.ai/docs/app-attribution) docs. OpenRouter creates app pages and rankings from `HTTP-Referer` plus display/category headers. That is valuable, but it is not the HTTP standard for application identity. The risk is adopting OpenRouter's exact header set as if it were universal, then leaking provider-specific headers to direct DeepSeek requests, future OpenAI/Anthropic/Vertex adapters, test servers, or proxies that log unknown fields indefinitely.

## Investigation

- **OpenRouter's mechanism is provider-specific.** Their current docs say app attribution is tracked through `HTTP-Referer` (required), `X-OpenRouter-Title`, and `X-OpenRouter-Categories`; `X-Title` is only accepted for backward compatibility. Their API reference calls the headers optional and says they make the app discoverable on OpenRouter. This is a concrete OpenRouter contract, not an IETF or OpenAI-compatible API standard.
- **In agent tooling, `HTTP-Referer` is an OpenRouter-aware convention, not a general agent convention.** It is common enough that OpenRouter SDKs and OpenRouter examples expose it directly, and frameworks that target OpenRouter usually need a way to pass it through. But agent protocols such as ACP negotiate names, versions, and capabilities in their own initialize messages, while model-provider requests still need HTTP-level identity. "Accepted in the agent world" therefore means "recognized by OpenRouter integrations," not "portable across agent runtimes or providers."
- **Observed coding agents use product/version `User-Agent` strings, sometimes with environment context.** A non-exhaustive public-code survey found OpenAI Codex building `{originator}/{version} ({os} {os_version}; {arch}) ...` and carrying an `originator` header; Google Gemini CLI sending `GeminiCLI[-clientName]/{version}/{model} ({platform}; {arch}; {surface})` or a Cloud Code VS Code variant; Cline's Codex backend client sending `cline/{version} ({platform} {release}; {arch}) node/{nodeVersion}` plus `originator: cline`; SWE-agent setting `swe-agent/{version}` unless the user already supplied a header; Continue setting `Continue/{version}` for its ClawRouter provider plus `X-Continue-Provider`. Aider also appends `Aider/{version} +{website}` to browser-like user agents for web scraping, but that is not a model-provider request path. The pattern is not one exact format; it is product identity in `User-Agent`, with provider-specific side headers only where a provider/backend asks for them.
- **The standards-track general client identity header is `User-Agent`.** RFC 9110 section 10.1.5 defines `User-Agent` as the user-agent software identity, says it is used for interoperability reports and analytics, and says a user agent SHOULD send it on each request unless configured not to. This is the only standard header that directly matches "what product is making this HTTP request."
- **`Referer` is standard, but OpenRouter's `HTTP-Referer` is not the standard field.** RFC 9110 section 10.1.3 defines `Referer` as the URI from which the target URI was obtained and spends significant text on privacy restrictions. OpenRouter instead asks for `HTTP-Referer`, using it as an app URL identifier. That name and meaning are OpenRouter-specific even though it resembles the CGI environment variable form of the standard `Referer` header.
- **`From` is standard but not suitable as a mandatory default.** RFC 9110 section 10.1.2 defines `From` as an email address for the human responsible for a user agent. Robotic agents SHOULD send it so servers can contact an operator, but non-robotic agents should not send it without explicit user configuration because of privacy and security policy concerns. The harness can support an operator contact later, but must not invent one or require it globally.
- **Request-body `user` or `metadata` fields are not app attribution.** Some model APIs expose a stable end-user identifier, request metadata, labels, or project/account headers. Those are useful for abuse monitoring, internal billing, dashboards, or trace correlation, but they either identify the end user rather than the product, are provider-specific body schema, or are not guaranteed to be forwarded through OpenAI-compatible gateways. They are not a substitute for a static application identity header.
- **SDK telemetry headers identify the SDK, not the app.** Official and third-party SDKs often send library/version headers. Those help the SDK maintainer debug their client, but they do not identify the harness as the application unless the application explicitly supplies a product attribution layer.
- **pi-ai has a first-class header hook.** `@earendil-works/pi-ai`'s `StreamOptions.headers` merges caller headers last over provider defaults, so a library-backed adapter can satisfy the same wire contract as the hand-rolled one without wrapping or upstream work — the mock-server suites assert arrival on the wire for both adapters.

## Decision

Provider request attribution is mandatory at the LLM adapter boundary, with a provider-neutral app identity and provider-specific wire mappings. The rule: every product LLM adapter sends a static, non-secret application identity on every provider HTTP request, and every adapter has tests proving the identity reaches the wire (a mock server asserting received headers; for a library-backed adapter, the library's header hook feeding the same mock-server assertion).

For OpenRouter specifically, attribution means sending **both** the provider-neutral `User-Agent` and OpenRouter's app identifier, `HTTP-Referer`. `User-Agent` identifies the client software in the standard HTTP way; `HTTP-Referer` is the OpenRouter-specific app URL key that creates the app page and ranking entry. `X-OpenRouter-Title` and `X-OpenRouter-Categories` refine that same OpenRouter app identity.

The provider-neutral identity is owned by `dsh-llm` (`packages/llm/llm/src/attribution.ts`), not by individual adapters. `AppIdentity` contains only public product facts, and the default `APP_IDENTITY` settles the values the proposal left open:

- product token for `User-Agent`: `deepseek-harness` (continuity with the pre-RFC wire value and the repo/org identity)
- version: read from the owning package's manifest via `createRequire`, never a hand-copied constant
- app title: `DeepSeek Harness`
- app URL: `https://github.com/deepseek-ai/deepseek-harness-sdk` — the planned public home; a `FIXME` in `attribution.ts` blocks release until that repository actually exists
- category list for providers with public app marketplaces: `cli-agent`

The default is mandatory and non-empty. White-label deployments pass their own `AppIdentity` to `attributionHeaders(target, identity)` — the override seam is the function parameter, with no deployment config plumbing until a consumer needs it — and omission falls back to the harness default rather than suppressing attribution. There is no per-request API for the model, user prompt, session id, cwd, user email, API key owner, or local machine identity to influence these fields.

Wire mapping (`attributionHeaders`; header names lowercase in code — HTTP field names are case-insensitive on the wire):

| Target | Mapping |
|---|---|
| `generic` (every HTTP-based adapter's default) | `User-Agent: {product}/{version} (+{url})` — the parenthesized `+url` comment stays within RFC 9110's conservative product/comment syntax. |
| `openrouter` | `HTTP-Referer`, `X-OpenRouter-Title`, and `X-OpenRouter-Categories` (comma-joined) in addition to `User-Agent`. `X-OpenRouter-Title`, not legacy `X-Title`. |
| Direct DeepSeek endpoint | `generic`; no OpenRouter-only headers unless DeepSeek documents an equivalent contract. |
| Future providers | Add an `AttributionTarget` variant only when that provider documents an app attribution mechanism. Do not reuse `HTTP-Referer` by analogy. |

Target selection is **explicit adapter config only**: both adapters expose `attributionTarget: 'generic' | 'openrouter'` (`DeepSeekAdapterOptions` / `PiAiAdapterOptions` and the matching plugin `Config` key), defaulting to `generic` in `dsh-llm` where the vocabulary lives. The proposal's alternative arm — recognizing `https://openrouter.ai/api/v1` by exact match — was not taken: it trades a magic constant for covering only one spelling of the endpoint (proxied/regional URLs still need the option), and a user pointing `baseURL` at OpenRouter without the flag still sends the standard `User-Agent` baseline.

`AttributionTarget` is a closed union (`switch` + `assertNever`), deliberately **not** merge-extensible: an attribution mapping is a documented cross-provider contract owned by `dsh-llm`, not a plugin extension point, so a future provider mapping is a compile-visible change to the owning module.

## Acceptance criteria (all landed)

- `dsh-llm` documents the mandatory app-attribution contract for `LlmAdapter` authors (`LlmAdapter` JSDoc, package README, and the adapter-contract section of `docs/core-data-structures/llm-streaming.md`).
- A shared helper (`attributionHeaders` / `userAgent`) constructs the app identity and the standard `User-Agent` value from package metadata, so adapters do not hand-copy version constants.
- `dsh-llm-deepseek` sends the shared headers on every request; its mock-server suite asserts the exact `User-Agent`, asserts the OpenRouter set is absent by default, and asserts the exact OpenRouter headers when `attributionTarget: 'openrouter'` is configured.
- `dsh-llm-pi-ai` sends the same headers through pi-ai's `StreamOptions.headers` hook, with the same three wire-level assertions — the twin contract includes attribution.
- No app-attribution field carries secrets, local paths, session ids, prompt text, model output, user email, or per-user stable identifiers.
- The adapter READMEs state the attribution policy and the OpenRouter-specific mapping.

## Alternatives considered

**OpenRouter headers everywhere.** Rejected. It would satisfy OpenRouter rankings, but it treats a custom OpenRouter contract as a universal standard and sends fields with misleading semantics to providers that did not ask for them. It also risks using `HTTP-Referer` as a generic app URL field even though standard HTTP already has `User-Agent` for product identity and `Referer` for a different browsing-context concept.

**Only `User-Agent`.** Rejected as incomplete. It is the correct baseline and the only standard mechanism, but it cannot create OpenRouter app pages or marketplace rankings because OpenRouter requires `HTTP-Referer` for that product feature. Deferring the OpenRouter mapping until an in-repo OpenRouter deployment existed was also considered and rejected: the DeepSeek adapters already accept any OpenAI-compatible `baseURL`, so OpenRouter is reachable today via config alone, and the mapping is small enough that shipping it with wire tests costs less than re-opening the contract later.

**Only provider account/project identity.** Rejected. Organization/project headers, API keys, cloud accounts, and billing projects identify who pays or owns the request, not which application is sending traffic. They also expose no public app title/category and do not help gateways like OpenRouter build app rankings.

**End-user `user`/`metadata` fields.** Rejected for this RFC. Those are valuable for abuse monitoring and customer support but describe the human or tenant behind a request. App attribution must be static product identity and safe to send on every request.

**Config-only opt-in attribution.** Rejected. A default-off setting is exactly how adapters keep drifting. The policy is mandatory default attribution with overrideable public values, not optional attribution.

**Product-named token (`deepseek-code`).** Considered for the `User-Agent` token, since the product's name is DeepSeek Code. `deepseek-harness` won on continuity: it is the identity providers already see from this codebase, it matches the org/repo and planned SDK-repo naming, and a public rename can change the display `title` without breaking the machine-readable token history.

## Risks / what we give up

**Providers see that traffic comes from the harness.** That is the point, but it means deployments that previously blended into generic SDK traffic become identifiable. Mitigation: send only static public product data and let forks/white-label deployments pass their own `AppIdentity`.

**The app URL points at a repository that does not exist yet.** `deepseek-ai/deepseek-harness-sdk` is the planned public home; until it is created the URL is a dangling promise. The `FIXME` marker on the constant blocks a release from shipping with it unresolved (see `docs/development.md` marker semantics).

**Header support differs by client library.** The hand-rolled adapter sets headers directly; the pi-ai-backed adapter depends on pi-ai continuing to honor `StreamOptions.headers` (merged last over provider defaults). The wire-level mock-server tests are the guard: if a pi-ai upgrade stops delivering the headers, the suite goes red. This is useful pressure on the abstraction: a provider adapter that cannot set mandatory headers cannot fully implement the harness LLM contract.

**OpenRouter categorization might go stale.** `cli-agent` is correct for the coding-agent demos and terminal use, but future editor-only or cloud-hosted products might deserve `ide-extension` or `cloud-agent`. Categories are overrideable via `AppIdentity` and are provider-specific presentation, not the core identity.
