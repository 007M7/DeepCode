# Agent Note: Validate API key format before it reaches an HTTP header

Status: proposed

English | [中文](2026-08-06-api-key-format-validation.zh.md)

## Problem

An API key holding characters no HTTP header value can carry is accepted by every configuration surface and fails only when a request is built, far from the field that caused it.

Paste a key containing an emoji, CJK text, or a full-width punctuation mark into the web Models page and the save reports success. The first turn then fails with `Cannot convert argument to a ByteString because the character at index 7 has a value of 55357 which is greater than 255` — the index and code point are UTF-16 internals with no action attached, and they disclose the code point of one character of the key. `llm-deepseek` produces this because `fetch` builds the `Bearer` header inside the `try` at [adapter.ts](../../../../packages/llm/llm-deepseek/src/adapter.ts), whose `catch` labels every failure `TRANSPORT`; that label is in `DEFAULT_RETRYABLE_CODES`, so a permanent, deterministic fault is also retried three times.

`llm-pi-ai` is worse on the same input. Its discovery probe builds the same header with a bare `fetch` in [discovery.ts](../../../../packages/llm/llm-pi-ai/src/discovery.ts) and wraps every failure as `could not reach <url>`, so a local key fault is reported as an unreachable network. The probe is reachable from the unsaved draft: `ProviderEditor` puts the typed `keyDraft` into its probe request, so the model-listing button sends an illegal key before anything is stored.

Whitespace passes every check. `ProviderEditor` tests `keyDraft.length` and `resolveAdapterOptions` tests `config.apiKey.length`, so a key of three spaces stores and then authenticates as `Bearer` plus blanks. `llm-pi-ai` rejects an empty literal `apiKey` in `resolveProfiles`, but applies no check whatsoever to a credential- or environment-sourced key — which is the path the Models page writes, and therefore the path users actually take.

Sources: deepseek-harness#1594 and #1595; dsh-external#247, #249, #266, and #210.

## Proposal

One rule defines a legal key: **after trimming, non-empty, and every character within `[\x21-\x7E]`** — printable ASCII, space excluded.

This single predicate covers every input the sources list: empty, leading and trailing whitespace, interior whitespace, C0 control characters, emoji, CJK text, and full-width punctuation. It is also exactly the constraint that produced the ByteString failure, so the two issues close on one definition rather than on two coincidentally related fixes.

A second, narrower rule catches a pasted environment line: reject input matching `^[A-Z][A-Z0-9_]*=` or wrapped in matching quotes. Restricting the prefix to upper-case keeps real keys clear of it — `sk-` forms break the identifier match at the hyphen.

### Invariants belong at every layer; heuristics belong where the human is

The charset rule is an invariant. A non-ASCII character *cannot* travel in a header value for any provider, so enforcing it in the browser, in each resolver, and on every credential read is consistent by construction rather than by agreement.

The shape rule is a guess about how people paste, so it runs **only in the browser**. `llm-pi-ai` fronts OpenAI, Anthropic, and arbitrary hand-declared gateways whose key formats this repository does not own; a gateway issuing a key shaped like `TENANT1=abc` would, if the rule ran in the resolver, be locked out with no escape — the settings page would refuse it and a hand-written `.env` would be rejected on read. Confining the heuristic to the surface where the paste happens keeps the environment as the way through.

### Absence is a configuration state, not a missing key

"No API key" means three different things here, and only one of them is an error. The rule applies to a value that was *provided*; deciding whether one was provided at all stays with each caller.

**Omitted.** A profile naming neither `apiKey` nor `apiKeyEnv` is authenticated by something other than a harness-held key. `routeAuth` in [provider.ts](../../../../packages/llm/llm-pi-ai/src/provider.ts) keeps the installed catalog provider's own auth precisely so provider-native ambient discovery survives, and `openai-codex` — shipped in that catalog — authenticates through OAuth and refuses an explicit key outright. `namesCredential` exists to carry this distinction. In `llm-deepseek`, an absent `apiKey` likewise falls through to `apiKeyEnv`. Omission is never validated.

**A blank field in the web UI.** The key input opens empty even for a provider whose key is already stored — the `keyStored` copy reads "Configured — enter a new value to replace" — so blank means *keep what is stored*. `ProviderEditor` already skips `credentials.set` entirely when the draft is empty, and that stays a no-op: a blank field must never block submit, or editing a base URL would demand re-entering the key.

**Provided, but empty or whitespace-only.** This is the one error, because the user expressed an intent to set a key and supplied nothing. `llm-pi-ai` already words it correctly in `resolveProfiles` — *has an empty apiKey; omit it to use ambient authentication* — and that shape, naming the legitimate alternative rather than just refusing, is what the other surfaces adopt.

`normalizeApiKey` therefore takes `string`, never `string | undefined`.

### Where the rule lives

`normalizeApiKey` is a new module of the `dsh-llm` seam, beside [attribution.ts](../../../../packages/llm/llm/src/attribution.ts), which already owns shared header concerns. Both adapters depend on the seam and both need the rule, so it has two current consumers rather than a speculative one. It returns the trimmed value or a reason (`empty`, `illegalCharacters`).

The client cannot import it: client packages reference only client packages, so `packages/client/ui-models` mirrors the predicate and owns the localized messages, exactly as `validateDeepSeekModels` mirrors the host's `catalogModel` schema today. Each side names the other in a comment.

### What each surface does

| Surface | Change |
|---|---|
| `dsh-llm` | Add `normalizeApiKey`; add `INVALID_CREDENTIAL`, deliberately outside `DEFAULT_RETRYABLE_CODES`. |
| `llm-deepseek` `resolveAdapterOptions` | Normalize a present `apiKey`, throwing beside the existing beyond-schema bounds; use the trimmed value. An absent one still falls through to `apiKeyEnv`. Closes dsh-external#210. |
| `llm-deepseek` `resolveApiKey` | Normalize what the credentials seam or environment returns; reject with `INVALID_CREDENTIAL` naming the Models page, never echoing the key. |
| `llm-pi-ai` `resolveProfiles` | Widen the existing emptiness check to the shared rule, keeping its "omit it to use ambient authentication" wording. |
| `llm-pi-ai` `resolveApiKey` | Normalize the credential and environment paths, which are unchecked today. A profile naming no credential still returns `undefined` untouched, so ambient and OAuth routes are unaffected. |
| `llm-pi-ai` `discoverModels` | Normalize before building the header, so an illegal key stops reporting as an unreachable endpoint. A probe carrying no key stays unauthenticated as it is today. |
| `ui-models` | Mirror the charset rule, add the shape heuristic, trim `keyDraft` before probe and `credentials.set`, and fix the `stringAt` emptiness test. A blank field remains a no-op that submits; a field holding only whitespace is a field-level failure, so typed input is never silently discarded. Gate submit and show the failure on the field, matching the existing `modelFailure` pattern. |

`ProviderEditor` serves both the DeepSeek and pi-ai layouts, so one client change covers both providers.

`credentials-local` is deliberately untouched. It stores credentials generally, and printable-ASCII is a constraint of HTTP headers rather than of credential storage; its existing refusal of values no dotenv style can represent stays as it is.

## Alternatives considered

**A `.pattern()` on the `apiKey` schema field.** Vendored schemastery supports it, and the pattern would serialize to the browser with the rest of the namespace schema — one rule, delivered rather than mirrored. It loses because a pattern cannot trim first: `cordis.yml` would then reject a padded key while `.env` tolerated one, and the resolver would disagree with the schema about the same string. Validating in `resolveAdapterOptions` keeps every surface trim-then-validate, and that function is already where this package re-judges bounds the schema cannot express.

**A validation module shared by client and host.** Rejected by the source-plane layout: client packages reference only client packages plus `vendor/cordis` and `support/invariants`, and widening that to reach a host package would collide the two `Context` merges the split exists to keep apart. Mirroring a one-line predicate with a test on each side is the established shape here.

**Sniffing the `TypeError` in the adapter's `catch`.** This would classify the ByteString failure after the fact, leaving the header construction itself unguarded. It depends on the wording of a Node error message, so it degrades silently across runtime versions, and it cannot help `llm-pi-ai`, whose header is built inside the pi-ai SDK. Refusing the key before handing it over works for both adapters and for the discovery probe.

**Enforcing in `credentials-local.set`.** It would catch every writer at once, including a hand-edited file. It loses because that provider stores credentials of every kind, and a rule derived from HTTP header encoding does not belong to it.

**Running the shape heuristic in the resolvers too.** Symmetric, and it would stop a pasted environment line written directly into `.env`. Rejected for the lockout described above: a false positive in a resolver leaves the user no working path, while a false positive in the browser leaves the environment open.

**Probing the provider at save time to prove the key works.** It would close the complaint the sources actually open with — a save that reports success and fails at the first turn. Rejected as out of scope and, on today's code, unbuildable: `discoverModels` short-circuits to the installed catalog before any network call for exactly the providers pi-ai ships catalogs for, so it verifies nothing about the key, and the DeepSeek card has no probe at all. A verifier's value is distinguishing "key rejected" from "cannot reach", which is the distinction this note makes reliable; building it first would produce a verifier unable to tell its own outcomes apart. Comparable products also do not verify on save, so a blocking network call at save time would be an unexpected behavior rather than a missing one.

## Acceptance criteria

- The browser, both resolvers, and both credential reads accept and reject the same *provided* strings: whitespace-only, padded, interior-space, C0 control, emoji, CJK, and full-width inputs are refused; a printable-ASCII key is accepted, trimmed.
- A profile naming no credential still resolves to no key, and a route authenticating through the installed provider's own ambient discovery or OAuth keeps working untouched.
- A blank key field saves the rest of the card without writing a credential; a field holding only whitespace fails on the field instead of being silently dropped.
- A rejected key names the API key field in the web UI and blocks submit; nothing is written to settings or credentials.
- A key that reaches a resolver illegally fails as `INVALID_CREDENTIAL` with a message naming where to fix it, containing no part of the key, and is not retried.
- `llm-pi-ai` discovery reports an illegal key as a key fault, not as an unreachable endpoint.
- A legal key still travels the existing `credentials.set` path unchanged.

## Risks

The shape heuristic can refuse a real key. Upper-case-identifier-then-`=` and matched surrounding quotes are shapes no known provider issues, and the rule runs only in the browser, so a user who hits it can still set the credential through the environment. The residual cost is a confusing refusal for a key nobody has yet reported.

Restricting to printable ASCII is stricter than the transport requires: a header value may carry `\x80`–`\xFF`. Admitting latin-1 would let `é` through to return an opaque 401 instead of a local, explained refusal, so the stricter rule is deliberate. A provider that issues latin-1 keys would need this rule widened.

The charset predicate exists twice, once per source plane. The layout forbids sharing it, and the duplication gate may flag the pair; each side carries its own test and names its twin.

The costliest way to get this wrong is to treat absence as invalidity. A rule applied to `undefined` would break every route authenticating through ambient discovery or OAuth — `openai-codex` cannot take a key at all — and a blank field that blocked submit would make editing any other setting demand re-entering the key. Both belong in the tests, not only in this note.

Keys already stored by an earlier build are read through `resolveApiKey`, so an illegal stored value begins failing at resolution rather than at request time. That is the intent — the diagnosis improves — but it moves the failure earlier for anyone currently holding one.
