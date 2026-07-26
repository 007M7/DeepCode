# @deepseek-ai/dsh-client-ui-question

English | [中文](README.zh.md)

Web `ask_user_question` feature plugin. Its host half mounts `dsh-tool-ask-user` only when the Web feature is selected; its browser half registers the `question` entry in the conversation-owned `conversation.composer` keyed slot.

The component renders one question at a time with progress navigation, single- and multi-select choices, recommendation badges derived from label suffixes, and custom answers. Single-select choices advance immediately, and Enter submits once every question is answered or skipped; Enter during IME composition confirms the input candidate without advancing. It submits one structured answer batch for the whole request: “Skip this question” retains other drafts and emits the existing blank `{ selected: [] }` shape for that item, while close rejects the whole wait as `ASK_CANCELLED`.

Selection state is local to a component keyed by the request rpcId. A replay with the same id preserves a still-mounted draft, while `question/resolved` from the host removes the composer. The host remains authoritative: successful HTTP delivery does not remove pending state locally.

## Model Experience

Indirectly, through `dsh-tool-ask-user`; that package owns the model-visible tool schema and structured result.

#### KV Cache effect

No direct invalidation; `dsh-tool-ask-user` owns the model-visible tool call and result.

## Known Limitations and Deferred Work

- **Unsubmitted drafts are not durable** — reconnect resync or a full page reload restores the host-owned pending request with the same rpcId, but a composer unmount resets local option and custom-text drafts.
- **One request owns the composer at a time** — later pending requests remain in the session snapshot and become visible after the earlier request resolves.
