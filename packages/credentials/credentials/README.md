# dsh-credentials

English | [中文](README.zh.md)

Abstract read-only credential seam (`ctx.credentials`). Configuration carries a branded reference such as `DEEPSEEK_API_KEY`; the provider owns the value, and the consumer resolves it only when starting an operation.

## Surface

```ts
import type { Context } from 'cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const ref = credentialRef('DEEPSEEK_API_KEY')
const value = await ctx.credentials.resolve(ref) // string | undefined
```

`credentialRef()` accepts POSIX-style environment-variable names and brands them so references do not mix with unrelated cross-package strings. `resolve(ref)` returns the current non-empty value or `undefined`. Consumers resolve once per operation and do not cache across operations; mutation, source metadata, enumeration, and change events stay out of the seam until a current consumer requires them.

## Providers

[`dsh-credentials-local`](../credentials-local/README.md) layers the live process environment over a `$DSH_HOME/.env` file. Other providers may resolve the same reference vocabulary from a keyring, helper command, or KMS without changing consumers.

## Model Experience

Indirectly, through the consuming LLM adapters: a resolved value authorizes their provider requests, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **No mutation, description, or enumeration** — the seam only resolves references already named by consumer configuration; a credential-management UI requires its own justified contract.
- **References are environment-variable-shaped** — one flat POSIX-identifier namespace remains sufficient for current consumers.
