# RFC: Mandatory app-attribution headers for provider requests

Status: proposed

## Problem

LLM provider requests should identify the product making them. That is useful for provider-side support, abuse investigation, compatibility debugging, traffic analytics, and public app attribution where a provider exposes it. The harness only partially does this today: the hand-rolled DeepSeek adapter sends `User-Agent: deepseek-harness/0.0.1` (`packages/llm/llm-deepseek/src/adapter.ts`), while the pi-ai-backed twin has no harness-owned header path visible in this repo (`packages/llm/llm-pi-ai/src/adapter.ts`). New adapters can therefore omit attribution silently, and a library-backed adapter can drift from the hand-rolled adapter even though [the twin-adapter RFC](../../implemented/architecture/2026-06-13-twin-llm-adapters.md) exists to keep the provider seam honest across both implementations.

The immediate prompt came from OpenRouter's [App Attribution](https://openrouter.ai/docs/app-attribution) docs. OpenRouter creates app pages and rankings from `HTTP-Referer` plus display/category headers. That is valuable, but it is not the HTTP standard for application identity. The risk is adopting OpenRouter's exact header set as if it were universal, then leaking provider-specific headers to direct DeepSeek requests, future OpenAI/Anthropic/Vertex adapters, test servers, or proxies that log unknown fields indefinitely.

## Investigation

- **OpenRouter's mechanism is provider-specific.** Their current docs say app attribution is tracked through `HTTP-Referer` (required), `X-OpenRouter-Title`, and `X-OpenRouter-Categories`; `X-Title` is only accepted for backward compatibility. Their API reference calls the headers optional and says they make the app discoverable on OpenRouter. This is a concrete OpenRouter contract, not an IETF or OpenAI-compatible API standard.
- **In agent tooling, `HTTP-Referer` is an OpenRouter-aware convention, not a general agent convention.** It is common enough that OpenRouter SDKs and OpenRouter examples expose it directly, and frameworks that target OpenRouter usually need a way to pass it through. But agent protocols such as ACP negotiate names, versions, and capabilities in their own initialize messages, while model-provider requests still need HTTP-level identity. "Accepted in the agent world" therefore means "recognized by OpenRouter integrations," not "portable across agent runtimes or providers."
- **Observed coding agents use product/version `User-Agent` strings, sometimes with environment context.** A non-exhaustive public-code survey found OpenAI Codex building `{originator}/{version} ({os} {os_version}; {arch}) ...` and carrying an `originator` header; Google Gemini CLI sending `GeminiCLI[-clientName]/{version}/{model} ({platform}; {arch}; {surface})` or a Cloud Code VS Code variant; Cline's Codex backend client sending `cline/{version} ({platform} {release}; {arch}) node/{nodeVersion}` plus `originator: cline`; SWE-agent setting `swe-agent/{version}` unless the user already supplied a header; Continue setting `Continue/{version}` for its ClawRouter provider plus `X-Continue-Provider`. Aider also appends `Aider/{version} +{website}` to browser-like user agents for web scraping, but that is not a model-provider request path. The pattern is not one exact format; it is product identity in `User-Agent`, with provider-specific side headers only where a provider/backend asks for them.
- **The standards-track general client identity header is `User-Agent`.** RFC 9110 section 10.1.5 defines `User-Agent` as the user-agent software identity, says it is used for interoperability reports and analytics, and says a user agent SHOULD send it on each request unless configured not to. This is the only standard header that directly matches "what product is making this HTTP request."
- **`Referer` is standard, but OpenRouter's `HTTP-Referer` is not the standard field.** RFC 9110 section 10.1.3 defines `Referer` as the URI from which the target URI was obtained and spends significant text on privacy restrictions. OpenRouter instead asks for `HTTP-Referer`, using it as an app URL identifier. That name and meaning are OpenRouter-specific even though it resembles the CGI environment variable form of the standard `Referer` header.
- **`From` is standard but not suitable as a mandatory default.** RFC 9110 section 10.1.2 defines `From` as an email address for the human responsible for a user agent. Robotic agents SHOULD send it so servers can contact an operator, but non-robotic agents should not send it without explicit user configuration because of privacy and security policy concerns. The harness can support an operator contact later, but must not invent one or require it globally.
- **Request-body `user` or `metadata` fields are not app attribution.** Some model APIs expose a stable end-user identifier, request metadata, labels, or project/account headers. Those are useful for abuse monitoring, internal billing, dashboards, or trace correlation, but they either identify the end user rather than the product, are provider-specific body schema, or are not guaranteed to be forwarded through OpenAI-compatible gateways. They are not a substitute for a static application identity header.
- **SDK telemetry headers identify the SDK, not the app.** Official and third-party SDKs often send library/version headers. Those help the SDK maintainer debug their client, but they do not identify "DeepSeek Code" as the application unless the application explicitly supplies a product attribution layer.

## Proposal

Make provider request attribution mandatory at the LLM adapter boundary, with a provider-neutral app identity and provider-specific wire mappings. The rule is: every product LLM adapter must send a static, non-secret application identity on every provider HTTP request, and every adapter must have tests proving the identity reaches the wire or, for a library-backed adapter, proving the configured library hook emits equivalent headers.

For OpenRouter specifically, mandatory attribution means sending **both** the provider-neutral `User-Agent` and OpenRouter's required app identifier, `HTTP-Referer`. `User-Agent` identifies the client software in the standard HTTP way; `HTTP-Referer` is the OpenRouter-specific app URL key that creates the app page and ranking entry. `X-OpenRouter-Title` and `X-OpenRouter-Categories` refine that same OpenRouter app identity.

The provider-neutral identity should be owned outside individual adapters, ideally in `dsh-llm` or a tiny support package if importing package metadata from `dsh-llm` is too awkward. It should contain only public product facts:

- product token for `User-Agent`: `deepseek-code` or `deepseek-harness` (settle this when implementation chooses the public product name)
- version: the package/root version, not a manually duplicated constant
- app title: `DeepSeek Code`
- app URL: the public product or repository URL, not a local workspace path
- optional category list for providers that support public app marketplaces, initially `cli-agent`

The default is mandatory and non-empty. Deployments may override the title/URL/category values for white-label products or forks, but omission must fall back to the harness default rather than suppress attribution. There is no per-request API for the model, user prompt, session id, cwd, user email, API key owner, or local machine identity to influence these fields.

Wire mapping:

| Target | Required mapping |
|---|---|
| All HTTP-based adapters | Send `User-Agent` with the product token and version. Include the app URL as a comment only if the final value stays within the conservative syntax in RFC 9110. |
| OpenRouter endpoints | Send `HTTP-Referer`, `X-OpenRouter-Title`, and, when configured, `X-OpenRouter-Categories` in addition to `User-Agent`. Use `X-OpenRouter-Title`, not legacy `X-Title`, for new code. |
| Direct DeepSeek endpoint | Send `User-Agent`; do not send OpenRouter-only headers unless DeepSeek documents an equivalent contract. |
| Future providers | Add a small provider-specific mapper only when that provider documents an app attribution mechanism. Do not reuse `HTTP-Referer` by analogy. |

Endpoint detection should be explicit. If the adapter has an OpenRouter provider package later, that package always applies the OpenRouter mapper. If an existing OpenAI-compatible adapter can be pointed at arbitrary `baseURL` values, it may recognize `https://openrouter.ai/api/v1` exactly or expose an explicit `provider: 'openrouter'`/`attributionTarget: 'openrouter'` config. It should not infer OpenRouter from arbitrary path fragments or model names.

For the current twin adapters, this means the pi-ai-backed adapter cannot remain a silent exception. Either configure `@earendil-works/pi-ai` with request headers if the library supports that, wrap or contribute the missing hook upstream, or retire the library-backed adapter from product use until it can honor the same attribution contract. The value of the twin is comparing real implementations under one contract; attribution is now part of that contract.

## Acceptance criteria

- `dsh-llm` documents the mandatory app-attribution contract for `LlmAdapter` authors.
- A shared helper constructs the default app identity and the standard `User-Agent` value from package metadata, so adapters do not hand-copy `deepseek-harness/0.0.1` constants.
- `dsh-llm-deepseek` sends the shared `User-Agent` on direct DeepSeek requests and keeps the existing mock-server assertion, updated to the shared value.
- The OpenRouter mapping, wherever implemented, sends `HTTP-Referer`, `X-OpenRouter-Title`, and optional `X-OpenRouter-Categories`, with a test that uses an OpenRouter base URL or explicit OpenRouter target and asserts the exact headers.
- `dsh-llm-pi-ai` either sends the same attribution headers through a real library hook or is removed from adapter registration paths with a follow-up RFC explaining why the twin contract no longer justifies the maintenance cost.
- No app-attribution field carries secrets, local paths, session ids, prompt text, model output, user email, or per-user stable identifiers.
- The relevant adapter READMEs mention the attribution policy and the OpenRouter-specific mapping only where that mapping can actually be enabled.

## Alternatives considered

**OpenRouter headers everywhere.** Rejected. It would satisfy OpenRouter rankings, but it treats a custom OpenRouter contract as a universal standard and sends fields with misleading semantics to providers that did not ask for them. It also risks using `HTTP-Referer` as a generic app URL field even though standard HTTP already has `User-Agent` for product identity and `Referer` for a different browsing-context concept.

**Only `User-Agent`.** Rejected as incomplete. It is the correct baseline and the only standard mechanism, but it cannot create OpenRouter app pages or marketplace rankings because OpenRouter requires `HTTP-Referer` for that product feature.

**Only provider account/project identity.** Rejected. Organization/project headers, API keys, cloud accounts, and billing projects identify who pays or owns the request, not which application is sending traffic. They also expose no public app title/category and do not help gateways like OpenRouter build app rankings.

**End-user `user`/`metadata` fields.** Rejected for this RFC. Those are valuable for abuse monitoring and customer support but describe the human or tenant behind a request. App attribution must be static product identity and safe to send on every request.

**Config-only opt-in attribution.** Rejected. A default-off setting is exactly how adapters keep drifting. This RFC's policy is mandatory default attribution with overrideable public values, not optional attribution.

## Risks / what we give up

**Providers see that traffic comes from DeepSeek Code.** That is the point, but it means deployments that previously blended into generic SDK traffic become identifiable as the harness. Mitigation: send only static public product data and allow forks/white-label deployments to override the public app title and URL.

**Header support differs by client library.** The hand-rolled adapter can set headers directly; the pi-ai-backed adapter may require an upstream hook or wrapper. This is useful pressure on the abstraction: a provider adapter that cannot set mandatory headers cannot fully implement the harness LLM contract.

**Version sourcing needs a clean implementation.** The existing `USER_AGENT = 'deepseek-harness/0.0.1'` constant is intentionally manual. Replacing it with package metadata may need a small build-time or runtime helper. That helper is worth it because stale attribution is a low-grade lie that tests can otherwise miss.

**OpenRouter categorization might go stale.** `cli-agent` is correct for the coding-agent demos and terminal use, but future editor-only or cloud-hosted products might deserve `ide-extension` or `cloud-agent`. Keep categories overrideable and treat them as provider-specific presentation, not the core identity.
