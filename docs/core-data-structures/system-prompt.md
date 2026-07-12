# System Prompt Assembly

The [system-prompt package](../../packages/core/system-prompt) owns the data exchanged between prompt contributors and one assembly call. The package [README](../../packages/core/system-prompt/README.md) documents registration, ordering, scoping, and rendering behavior; this page pins the literal cross-package shapes that plugins implement or pass.

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts).

## Assembly context

`AssembleContext` identifies the scope layer one assembly resolves. It is merge-extensible: `dsh-agent` adds the optional live `agent` field, and `assembleContextFor(agent)` sets that field and `scope` together.

```ts type-equiv
interface AssembleContext {
  scope?: ScopeKey
}
```

## Tool-provider result

`ToolProviderResult.schemas` is the model-visible set for the current assembly. `knownNames` is the provider's pre-restriction name universe used to distinguish a configured-name typo from a known tool that is deliberately hidden in this scope. `ownerFinalNames` identifies tool contributions whose canonical presence or absence survives the assembly waterfall.

```ts type-equiv
interface ToolProviderResult {
  readonly schemas: readonly ToolSchema[]
  readonly knownNames?: readonly string[]
  readonly ownerFinalNames?: readonly string[]
}
```

## Prompt sections and owner finality

`PromptSection` is a readonly same-process registration contract. `ownerFinal` is reserved for protocol-owned instructions whose canonical presence and definition must survive the complete assembly waterfall; ordinary sections remain transformable. Tool definitions declare the equivalent fact on their own contribution, and the tool provider reports the resolved names through `ownerFinalNames` above.

```ts type-equiv
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly ownerFinal?: boolean
}
```
