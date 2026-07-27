# @deepseek-ai/dsh-client-ui-models

English | [中文](README.zh.md)

Models settings section plugin: registers the `models` nav entry into `settings.section` with an intentionally empty content column — model management lands in a later phase.

## Model Experience

None, as the section renders an empty browser UI column; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Content column is empty by design** — provider list, editing form, and activation flow are deferred until the model-management service exists.
