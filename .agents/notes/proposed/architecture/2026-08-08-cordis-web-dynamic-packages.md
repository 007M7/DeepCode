# Agent Note: Cordis Host/Client Dynamic Plugin Runtime

Status: proposed

English | [中文](2026-08-08-cordis-web-dynamic-packages.zh.md)

## Problem

The model needs to extend the current DSH process temporarily without modifying repository source, rebuilding the application, or refreshing the browser. An extension may run in the Host Node.js process, in a Client browser page, or as one plugin whose Host half retrieves data and whose Client half presents it.

This capability cannot be limited to “execute some code.” Before writing code, the model needs to discover the Services, Events, Builtins, Slots, and theme tokens available on both platforms. The user needs to preview the code before deciding whether Client code may enter the page. A single plugin needs immutable versions, retries after failure, and rollback. Asynchronous runtime errors need to return to the model instead of remaining only in server logs or the browser console.

Combining definition, approval, execution, version switching, capability discovery, and UI state into one action creates states that cannot be explained consistently: whether a successful definition also means a successful run; which version remains successful after a failed update; how long a Tool should wait when no page responds; which historical card owns the business UI after the same Package runs multiple times; and whether page-local Client load state can represent process-wide Host state.

## Proposal

### Core principles

- The Host is the sole process-wide authority for Plugins, Packages, Runs, approvals, and version pointers.
- The Client stores only the current page's approval interaction, load results, Slot contributions, business views, and page-local errors.
- Define creates only immutable code versions; Run activates only a defined version.
- A version switch commits `currentPackageId` only after the target Package completes its required Host/Client activation.
- Before writing code, the model queries capabilities through Inspect Providers. Inspect results assist coding and are not plugin runtime business data.
- Dynamic Host and Client code both use restricted plain JavaScript contexts and attach reversible side effects to the Cordis lifecycle.
- Client code requires user authorization before entering a page. Authorization may cover one Package or future versions of the same Plugin.
- Tool calls do not wait for approval or browser operations that may occur only after the current turn ends. State stores and model steering report asynchronous outcomes.

### Package responsibilities and dependency direction

Four packages under `packages/self-modification/` implement the dynamic runtime:

| Package | npm package | Responsibility |
| --- | --- | --- |
| `tool-cordis` | `@deepseek-ai/dsh-tool-cordis` | Registers the System Prompt, seven model-facing Tools, Host Inspect Providers, `@pluginId` context injection, and Tool presentation metadata |
| `cordis-host-runner` | `@deepseek-ai/dsh-cordis-host-runner` | Stores the authoritative Registry, allocates IDs, executes Host code, and manages versions, approvals, Runs, private handlers, Inspect routing, and model feedback |
| `cordis-client-runner` | `@deepseek-ai/dsh-cordis-client-runner` | Synchronizes Inspect manifests in the browser, orchestrates approved Host→Client activation, evaluates Client code, and manages the Guard, Loader/Fiber, timer, styles, and teardown |
| `ui-cordis` | `@deepseek-ai/dsh-client-ui-cordis` | Renders Define/Run Tool cards, the global Cordis panel, approval controls, version selection, runtime status, and Package-specific business views |

`tool-cordis` depends only on the Host Runner's in-process service and does not import the Client implementation. `ui-cordis` consumes only the Client Runner face and Client-safe wire types and does not import the Host implementation. Existing generated Remote APIs and forwarded events connect Host and Client runtime control; the gateway owns no dynamic Plugin domain logic.

### Domain objects

#### Plugin

A Plugin is a dynamic plugin instance that can be modified over time. It is identified by the branded type `CordisDynamicPluginId`, for example `clock-1`. When creating a Plugin, the model submits only a semantic prefix of 3 to 6 lowercase English letters; the Host appends a process-unique numeric suffix. The model cannot specify the complete `pluginId`.

A Plugin belongs to the Session that defined it. Model-facing Tools can read and operate only Plugins from the current Session. The global Client panel can list Plugins from all Sessions, but each action still executes under the owner Session carried by that row.

#### Package

A Package is an immutable code version under a Plugin. It is identified by `CordisDynamicPackageId`, for example `pkg-2`. It contains a name, a purpose, optional Host code, and optional Client code, with at least one code half present. Every `cordis_define` creates a new Package; an existing Package cannot be modified in place.

One Plugin may own multiple Packages, but at most one physical Run may exist at a time. Whether a Package contains a Host or Client half affects only its activation steps, not its version identity.

#### Plugin Run

A Plugin Run is one concrete activation attempt. It is identified by `CordisDynamicPluginRunId`, for example `run-3`. Every new activation attempt receives a new ID, including an attempt that fails after approval, a retry of the same Package, and a version update. `pluginRunId` associates approval, Host activation, Client loading, private RPC, Tool cards, and errors with the same attempt.

The Host stores the current physical Run separately from `latestRun`. The physical Run is the activation that can currently receive calls and be torn down. `latestRun` records the approval, phase, status of both halves, and diagnostics for the most recent attempt. A failed attempt may leave no live physical Run while remaining available for inspection.

#### Version pointers

- `currentPackageId` is the most recent Package to complete its required activation flow. Stopping the plugin, beginning an update, or failing an update does not clear it.
- `nextPackageId` is the target Package that is awaiting approval, activating, awaiting a Client, or most recently failed. It is cleared after the target succeeds and is committed as current.

A Host-only Package commits current after the Host successfully establishes its Fiber. A Client-bearing Package commits current after Host activation succeeds and at least one Client successfully establishes the corresponding load. A Fiber that Cordis parks as waiting because a hard dependency is absent is still a successfully established lifecycle object; it is not equivalent to a parse or `apply` failure.

If an update target fails, the old physical Run is not restarted automatically. The previous `currentPackageId` continues to identify the last successful version, and the failed target remains `nextPackageId`. The user or model can retry next, or reactivate current with `mode: "run"` to roll back.
