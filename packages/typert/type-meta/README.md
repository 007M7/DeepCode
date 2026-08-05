# @deepseek-ai/dsh-type-meta

English | [中文](README.zh.md)

Compiler-independent declarations shared by business packages, generated TypeRT artifacts, the Host Gateway, and Client API. This package owns Remote decorators, the explicit Service binding, merge-extensible protocol maps, invocation descriptors, codecs, and provider contracts; it does not run TypeScript analysis or provide a Cordis service.

## Remote declarations

- `@Remote` marks a public instance method for direct invocation on its registered Cordis Service.
- `@RemoteContext(key)` marks a method whose receiver is selected from a merge-declared scoped Context kind.
- `bindTypeRTGateway(this, serviceKey, options?)` creates the visible, frozen binding between a Service instance, its exact Cordis key, and its wire namespace.
- `remoteMethods(service)` returns a detached declaration-order snapshot used by the Gateway's SRC fallback.

Decorator initializers retain markers in a module-private `WeakMap` keyed by the Service prototype. They do not add constructor symbols, prototype properties, parameter metadata, or runtime reflection fields. The Service opts in explicitly through its `typertGateway` binding field.

## TypeRT protocol

Business packages extend `TypeRTLookupMap` and `TypeRTContextMap` to associate Host objects or scoped Contexts with their wire identities. Generated artifacts extend `TypeRTRemoteMap`, `TypeRTRemoteContextMap`, and `TypeRTRemoteNamespaceMap` so Client imports expose only selected Remote methods. `InvocationDescriptor` is the shared runtime form consumed by the registry, Gateway, and Client API.

Lookup and Context packages own both sides of their contract: declaration merging supplies the static association, while runtime providers register identity resolution with `ctx.typert`. Strict codecs carry generated schemas; `src-json` codecs identify the weaker source-launch path.

## Model Experience

None, as this protocol package declares application reflection and registers no model surface.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

- Decorator markers contain only the method name and direct or Context invocation mode. Parameter, result, lookup, and schema reflection require the TypeRT build pipeline.
- Remote decorators accept only public, non-static instance methods with string names. SRC execution cannot represent overloaded, destructured, defaulted, or rest-parameter signatures.
