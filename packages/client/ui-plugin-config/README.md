# dsh-client-ui-plugin-config

English | [中文](README.zh.md)

The **Plugins** settings section: one expandable card per Host plugin whose configuration a user owns. A card shows the plugin's name and what it governs; expanding it in place reveals hand-written controls bound to that plugin's settings namespace, each field marking whether the user overrode it and offering a reset back to the value the deployment composed.

## What appears here

A card renders only when its namespace is both registered by a live Host plugin and served to the browser. A deployment that does not compose the owning plugin — or serves the namespace to no client — renders nothing for it rather than an empty or disabled card, so the section reflects what this deployment actually runs.

The first batch covers the shell executor (`bash`), the agent loop's tool-call parallelism (`agent-loop`), and the DeepSeek search provider (`web-search-deepseek`).

## Extension point

The section declares `settings.plugin.item`, a root list slot. A plugin that ships a browser half registers its own card into that slot and owns its controls; this package neither enumerates namespaces nor renders a form it was not given. Ordering follows the slot's `order`.

## Writes

Every control writes one field through the client settings scope, which fences each write with the namespace revision it read, so a form that has drifted from the document is refused rather than overwriting a concurrent change. A field's presence in the raw user layer — not its value — is what marks it overridden; a reset clears that field so it re-inherits the composition layer. Secret-role fields never ride a response, so a key control reports only whether one is configured and writes through the credentials domain rather than the settings section.

## Model Experience

None, as the section renders a browser configuration UI; the values it writes reach a model only through the plugins that own them, each documenting that effect itself.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Only host-plane plugins appear** — a plugin an agent preset mounts carries its configuration inline in that preset's `agent.cordis.yml` and cannot register a settings namespace at all (a second session mounting the same preset would fail on a duplicate registration), so this section lists nothing for it. Editing those values remains the preset editor's job.
- **Exposure is a Host allowlist, not a plugin declaration** — a namespace absent from the api-proxy's allowlist answers `settings-not-exposed` even when its owner registered it, so a plugin distributed outside this repository cannot surface its own configuration here without a change in `packages/host/apiproxy`.
- **The shell card follows the composed executor** — the POSIX and PowerShell executor families share the `bash` namespace because a host composes exactly one of them, so the card's fields differ by platform and a deployment composing neither shows no card.
