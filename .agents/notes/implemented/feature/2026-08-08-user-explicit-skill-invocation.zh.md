# Agent Note: 经 skill.invoke 的用户显式 skill 调用

Status: implemented

[English](2026-08-08-user-explicit-skill-invocation.md) | 中文

## 问题

`disable-model-invocation: true` 的 skill（技能）在设计上就是仅限用户的：它绝不进入面向模型的目录，`skill` 工具也拒绝加载它。它唯一正当的入口是一次显式的用户手势——而 web 客户端此前没有这个入口。`skill.list` 过滤到模型与用户的交集（把仅限用户的 skill 挡在菜单之外），回车提交的 `/name` 一行以纯文本落入默认提示词 sink，而这行文本到达的模型又被禁止加载该 skill——于是退化为模型去 `read` 那份 SKILL.md 文件，或者干脆无视这次手势（issue #1470）。即使对普通 skill，决策 21 的纯文本引用也让用户调用只是模型可以忽略的协作线索，而不是保证。

## 决策

用户显式调用是一次确定性的宿主侧注入，对每一个用户可调用的 skill 一致：

- `skill.invoke { sessionId, name, text? }`（宿主 apiproxy）在操作边界强制执行用户调用策略（`skill-not-found`/`skill-not-invocable`），用共享的 `renderSkillContent` 渲染该 skill，在一个空行之后追加可选的尾随文本，并把整体作为一条携带新增 `skill-invocation` `MessageSource` kind（`{ name, args? }`）的 user 角色消息注入，随后经由与 `session.prompt` 相同的「路由是否有适配器在服务」闸门开启一个轮次。
- `renderSkillContent` 从 `dsh-tool-skill` 移入 `dsh-skill` seam：`skill` 工具结果与注入共享同一份逐字一致的 `<skill_content>` 形态，目录文本则新增了这条 seam 规则——已内联注入的 skill 必须被遵循，而不是再经工具重新加载。
- `skill.list` 提供每一个用户可调用的 skill 并携带 `modelInvocable`，因此浏览器菜单会带标记地列出仅限用户的 skill（描述前缀——`hint` 字段是认领态的 ghost text，菜单从不渲染它）。
- ui-skill 把菜单 pick 或回车提交的 `/name [args]` 认领进 invoke 事务（`matchEnter` 强等目录；未知名称保持为普通提示词）。已不可达的旧 `<skill>name</skill>` 引用 codec 被移除。
- transcript（文本记录）依据来源元数据把这次注入物化为专用的 `skill-invocation` 节点（绝不从正文重新解析），并渲染为一个右对齐气泡：`/name` chip、尾随文本，以及收在 disclosure 之后的注入块。

同类产品调研（Pi、OpenCode、Claude Code、Kimi Code、Codex、DeepSeek-Reasonix——本地检出）结论一致：在每个产品上，用户显式触发都是以 user 角色消息做程序化注入、模型零参与；提示词引导的工具加载只存在于模型自主轨道上；disable-model-invocation 的对应物只把关模型侧表层。Kimi 的来源元数据渲染与 Claude Code/Kimi 的禁止重载提示词规则，可直接平移到 `MessageSource` 与目录那句话上。

## 考虑过的替代方案

- **`agent.inject()` 上下文注入**——没有同类产品先例；这次手势是一个用户轮次，不是环境通知，而且上下文行呈现、压缩（compaction）与归属全都不匹配。否决。
- **宿主 `/skill <name>` 命令**（命令注册表，plan 模式先例）——两 token 的 UX、没有名称补全、仅限用户的 skill 在菜单里仍不可发现；按 cwd 的 skill 目录也与静态命令注册表格格不入。否决。
- **客户端展开**（拉取正文、拼进提示词）——授权沦为可被绕过的客户端善意，日志失去调用语义，而且 Codex 已删除其等价机制（custom prompts）转向核心注入。否决。
- **宿主提示词流水线扫描 `/name`**（Codex 的 `$name` core mentions）——重复了裁决层，还有吞掉普通行文中字面斜杠的风险；认领路径已经覆盖了这一需求。否决。
- **每次注入一条前导语**（Kimi 的 `User activated the skill …`）——弃用，改为一次性的目录句子：同样的上下文、只支付一次，且注入块与工具结果保持逐字节一致。

## 后果

- 决策 21 的纯文本引用路径在提交处被取代：草稿仍承载纯文本与 lexicon 派生的 chip 视觉，但提交会认领进一次确定性注入，而不是把字面文本发出去再碰运气。模型自主轨道（目录 + `skill` 工具）不变。
- 每一次用户可调用 skill 的调用现在都无条件付出其完整渲染正文的成本——这是确定性的代价，同类调研表明所有产品都在支付。
- `skill-invocation` 来源搭乘 `user/message`，因此「模型可见 ⟺ 已记录」在不新增事件类型的情况下继续成立，回放与 UI 读取的是元数据而非文本标记。
- TUI 与 ACP 之后可以为同样的语义采用 `skill.invoke`；在那之前，TUI 的客户端展开仍是它自己的路径。
