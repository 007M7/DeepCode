# @deepseek-ai/dsh-tool-str-replace-editor

English | [中文](README.zh.md)

Standalone model-facing `str_replace_editor` over `ctx.fs`. It can be composed with persistent Bash, one-shot Bash, sandboxed Bash, or another terminal surface.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `maxOutputChars` | `16000` | Prefix characters retained for file and directory views. |
| `description` | Editor command guide | Model-facing tool description. |
| `requireAbsolutePath` | `true` | Reject relative paths; disable only for deployments with a deliberate session-cwd contract. |

## Tool

The schema provides `view`, `create`, `str_replace`, and `insert`. File views use one-based line numbers; directory views omit hidden, dependency, and Python-cache entries and descend two levels. Replacement requires one unique literal match and reports errors only in the public `old_str` vocabulary. Insert follows the selected zero-based insertion boundary without adding an implicit trailing newline.

## Model Experience

### Tool schema

#### What the model sees

The generated [`str_replace_editor` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-str-replace-editor), including the configured `description`. The plugin contributes no standalone system-prompt section.

#### Token effect

Fixed schema cost while `str_replace_editor` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Views return numbered text or a shallow directory listing. Mutations return concise confirmations. Long views keep their prefix and append a clipping notice.

#### Token effect

Data-dependent and bounded by `maxOutputChars` plus the fixed clipping notice.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

- Operations target UTF-8 text; binary files are unsupported.
- `str_replace` intentionally rejects zero or multiple matches and has no `replace_all` argument.
- Canonical mode expands tabs before replacement or insertion, matching the reference string-replacement editor.
- The package delegates security and read-before-edit policy to the mounted filesystem and policy plugins.
