# Agent Note: Plugin configuration in the web settings page

Status: implemented

English | [中文](2026-08-10-web-plugin-configuration.zh.md)

## Problem

Everything a plugin can be configured with lived in `cordis.yml`. A user who wanted a longer shell timeout, a different search endpoint, or fewer parallel tool calls had to find the composition file, know its shape, and restart — while the Models page had shown for months that a settings namespace can be edited from the browser and take effect immediately.

The seam that made the Models page possible was already general: any plugin may register a namespace, and `settings.describe` serves its schema, its layers, and its revision. What was missing was on the two ends. No plugin outside the LLM adapters and the permission service had registered one, and there was no surface for a namespace that is not a model provider.

## Decision

Three host-plane plugins register their own settings namespace, and one browser-side section renders whatever the deployment exposes.

**Layering, unchanged.** A section resolves as schema defaults → the plugin's composition entry → the user layer. Each plugin passes its `cordis.yml` entry as the `base` and reads its config through a source thunk, so a stored change reaches the next use and a detaching settings provider leaves the composition entry running. Constraints the schema cannot express — positive and finite, the timer bound on `graceMs`, the parallel cap being a positive integer — become the section validator, so a bad value is refused at the write instead of at the next command.

**The shell namespace names the capability, not an implementation.** `BASH_SETTINGS_NAMESPACE` is exported by `@deepseek-ai/dsh-bash` because a host composes exactly one provider of `ctx.bash`: the win32 layer swaps the POSIX rows for the pwsh ones, and mounting both fails loud on a duplicate service registration. Both families therefore register the same namespace with their own schema and entry without ever colliding, and a `settings.yaml` carried between platforms keeps resolving on both — schemastery objects preserve keys the active schema does not declare.

**A section is a subset when the plugin config is bigger than what a user owns.** `agent-loop` exposes only `maxParallelToolCalls`; its `agents` array is consumed once when the service starts, so a stored change there could only look like it had an effect.

**The provider projects, rather than captures.** `web-search-deepseek` hands its provider a thunk instead of an options value, so an endpoint or model change reaches the next search without re-registering the provider — which would make the web seam's provider selection observable to the user as a flicker.

**Exposure stays a Host allowlist.** The three namespaces join `WEB_SETTINGS_NAMESPACES`; registration alone still never crosses the transport, and a namespace absent from that list answers `settings-not-exposed` exactly as an unregistered one does.

**The section knows no namespace.** `dsh-client-ui-plugin-config` declares a `settings.plugin.item` slot and renders the cards registered into it, so a plugin that ships a browser half owns its card and its controls. Each card binds its namespace through the client settings scope, which gained the two things a form needs: the raw `user` layer, whose key PRESENCE is what marks a field overridden, and `unset`, which clears one field back to the composition layer. A card renders nothing while its namespace is unavailable, so a deployment that does not compose the owning plugin shows no trace of it.

## Alternatives considered

- **A registration-time exposure declaration replacing the allowlist.** The honest shape — the namespace's owner declares its own exposure, and a plugin distributed outside this repository can surface its configuration without a change in `packages/host/apiproxy`. Deferred because it changes the seam contract, every existing registration site, and the anti-enumeration semantics at once, and because a plugin exposing an arbitrary schema needs a fail-closed redaction path first: a secret reachable only through a union or transform is currently returned verbatim.
- **A generic schema-driven form renderer.** Declined again for the reason recorded in the web-config-plane note: field truth without a presentation vocabulary produced an unusable card. Three plugins of hand-written controls cost about the same and read better, and the slot keeps the fourth plugin from having to negotiate with this package.
- **Editing preset-mounted plugins from this page.** Out of scope, and not merely unbuilt: a preset's rows carry their configuration inline in `agent.cordis.yml` and cannot register a settings namespace at all, because a second session mounting the same preset would fail on a duplicate registration. A user layer shared across presets would also overwrite the fields a preset uses to define its agent's identity — its persona text, its delegation wiring — which are per-preset by design.
- **One namespace per executor package instead of the capability-named `bash`.** Declined because the composed executor differs by platform while the settings document does not: a user who set a timeout on macOS would silently lose it on Windows.
- **Writing the search key into the settings section.** Declined because the literal would then have to ride a `describe` response to be rendered. The card reports only whether a key is configured and writes through the credentials domain, addressed by the reference the section names.

## Consequences

A user edits the shell's command timeout and output cap, the agent loop's parallel tool-call cap, and the search provider's key, endpoint, and per-request budget from the settings page, with each field marking whether they set it and offering a reset.

Two costs are real. Adding a fourth plugin still requires an entry in the apiproxy allowlist, so the page's reach is a Host decision rather than a plugin's. And the plugins the web deployment moved into the agent plane — the file tools, the skills, compaction, the todo tool — appear nowhere here, which is most of what a user might expect to find; their configuration remains the preset editor's.

The bash and pwsh executors now expose `config` as a getter over a source thunk rather than a readonly field. Every read site was already per-call, so nothing else changed, but a subclass that captured `this.config` at construction would silently pin the composition entry.
