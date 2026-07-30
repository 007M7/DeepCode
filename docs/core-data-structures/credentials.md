# User Credentials

English | [中文](credentials.zh.md)

The [dsh-credentials](../../packages/credentials/credentials) seam lets configuration name secrets by reference rather than carry their values. Providers such as [dsh-credentials-local](../../packages/credentials/credentials-local) resolve the current non-empty value, and consumers resolve once per operation so an external rotation reaches the next operation without a restart.

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## Identity

A reference names one credential as a POSIX-style environment-variable name. The brand keeps references from mixing with other cross-boundary strings; construction validates the shell-identifier shape.

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

## Resolution

`ctx.credentials.resolve(ref)` returns the provider's current non-empty secret string, or `undefined` while unconfigured. Consumers do not cache across operations. The seam deliberately exposes no mutation, source-description, enumeration, or change-event contract; the generated [service catalog](../cordis-catalog/services.md) owns the method signature.
