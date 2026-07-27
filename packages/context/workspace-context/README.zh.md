# @deepseek-ai/dsh-workspace-context

[English](README.md) | 中文

为每个会话加载与 `AGENTS.md` 兼容的工作区指令文件。该插件会将初始 user 全局指令与项目指令链冻结到请求前缀中，随后发现嵌套文件，并在成功的文件系统工具调用后通过持久上下文消息报告后续变更或移除。

## 生命周期

基线会在每个 agent-loop 实例的 `agent/session-prefix` 上组合一次。它先读取 `$DSH_HOME/AGENTS.md`，随后针对项目根目录到 `agent.session.header.cwd` 的每个目录，先读取每个现有基础候选文件，再读取每个现有本地 overlay 候选文件。同一目录中，如果候选文件在去除首尾空白后字节完全一致，就会按已配置顺序折叠到最早候选文件，因此 `CLAUDE.md` 若只是复制同级 `AGENTS.md`，只会渲染一次。前缀放在所有派生历史之前，记录在 `EpochHeader.messagePrefix` 中，并为该 loop 实例逐字复用。因为插件在委托之前前置自身贡献，后注册的 skill catalog 会出现在工作区指令之后。

该插件还会监听 `tools/post-execute` 中成功的第一方 `read`、`write` 和 `edit` 调用。每次 touch 都会检查新达到的后代 scope 以及之前加载的每个 scope。每个已配置候选名称都是所在目录中的独立 scope：新出现的文件通过结果的 `additionalContexts` 附加；已改变文件追加替换；文件消失或成为同一目录中较早候选文件的重复项时，追加移除通知。原生调用与 Code Mode 子分派共享该路径：`run_code` 将每个嵌套上下文延迟到外层结果，因此 loop 仍会在工具调用／结果相邻关系完成后追加更新。这种发现跟随结构化文件系统活动，而不是 shell `cd`，因为每次本地 bash 调用都启动新 shell，解析任意 shell 语法也不可靠。

指令读取使用可选 `ctx.fs` 提供方。该插件不会静态注入 `fs`，因此没有提供方的产品树仍可启动，指令加载在提供方出现前不执行任何操作。它会解析每个候选文件并获取结果状态，因此会跟随最终组件 symlink 到其目标：指向常规文件的链接会加载目标内容，缺失路径或非文件目标（包括指向目录的链接）则已确认不存在。resolve 或 stat 异常会改为将该候选文件的 scope 标记为暂时不可用。前缀取消与动态工具取消会传播到解析、元数据探测与流式读取。文件加载后的提供方失败会视为暂时不可用，而非文件已删除的证据。

## 提示词形状

基线指令是仅请求的 user 角色前缀消息，使用熟悉的 system-reminder 模式框定：

```md
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: ~/.dsh/AGENTS.md

...

Instructions from: AGENTS.md

...
</system-reminder>
```

新达到的 scope 使用持久注入 `user/message`（插件源）：

```md
<system-reminder>
Additional instructions from: packages/app/AGENTS.md

These instructions apply to work under `packages/app`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.

...
</system-reminder>
```

同一文件的编辑以 `Updated instructions from: <path>` 开头，并说明使用新内容替代之前加载的内容。候选文件消失或成为同一目录中较早候选文件的重复项时，消息是 `Instructions removed: <path>`，后跟 `The previously loaded instructions from this file no longer apply.`。指令文件中的字面 `</system-reminder>` 文本会转义，因此文件内容无法关闭插件拥有的 frame。

该插件拥有完整 `<system-reminder>` framing，每个注入的 `user/message`（无论来自此插件还是其他插件）都会不加包装地逐字达到模型，成为 user 角色消息。

## 状态与刷新

模型可见文本不含隐藏状态标记。每个动态上下文事件改为携带 JSON 元数据，其中包含经版本化的 `{ action, scope, path, digest? }` 变更列表。每次相关工具 touch 时，插件会从可见会话事件重建已加载状态，并叠加一个短暂内存 pending 窗口，用于不可变顶层 `tools/result` 上存在但 loop 尚未追加的上下文。匹配的持久 `user/message` 会确认 pending 转换。如果所属 `step/end` 在匹配上下文进入日志之前到达，插件会清除 pending 转换及其版本快速路径，使下一次成功 touch 可以重新加载。嵌套 Code Mode 结果会在外层执行 token 下暂存 pending 变更，用于抑制同次运行中的重复项；外层结果会回滚该状态，再只重新提交经过外层策略的上下文。

路径与 SHA-1 内容 digest 都未变时，不会重复注入。每会话、每 scope 元数据 cache 只存储 `{ path, version, digest, trimmedDigest }`：当提供方的不透明 `FsVersion` 与有效可见状态都匹配时，对账会跳过内容读取；版本改变会在任何模型可见更新之前触发有界读取与 SHA-1 确认。`trimmedDigest` 是针对去除空白后内容的 SHA-1，也是每目录重复 key，因此较早候选文件与某个未更改文件的内容收敛后，后者仍可被移除。恢复可行，因为 SHA-1 状态持久化在会话日志中，而空的内存版本 cache 只会导致一次确认读取。压缩会在 scope 的上下文事件离开可见表层后重新启用它，即使缓存版本未变。移除是 tombstone，因此候选文件之后重新出现时会重新加载。只有在字节预算内实际渲染的模型可见变更才会进入元数据、pending 状态和版本 cache；已省略变更仍可在后续 touch 处理，而相同 digest 的版本刷新只更新元数据。

冻结基线自身不会在实例中途改写。其初始路径／digest map 保留为比较状态；下一次成功文件系统 touch 会追加任何基线替换或移除。恢复的 loop 会重新组合当前基线，并在前缀组合期间对账仍可见的动态 scope。没有文件 watcher，因此磁盘变更会在下一次成功 `read`、`write` 或 `edit` touch 时可见，也会在恢复 loop 组合前缀时可见。

## 配置

```ts
export interface Config {
  dshHome?: string
  projectRootMarkers?: string[]
  maxBytes: number
  maxSourceBytes?: number
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
}
```

`maxBytes` 必填，因此每个部署都必须显式选择提示词预算。`maxSourceBytes` 在渲染前限制每个源指令文件，默认为 1 MiB。`projectRootMarkers` 默认为 `['.git']`，`instructionFileCandidates` 默认为 `['AGENTS.md', 'CLAUDE.md']`。每个项目目录中的所有现有候选文件都会加载，在去除周围空白后与较早候选文件内容匹配的文件会被丢弃。因此，使用默认设置时，内容相同的 `AGENTS.md` 与 `CLAUDE.md` 只渲染一次（作为 `AGENTS.md`），真正不同的同级文件则同时应用。`localInstructionFileCandidates` 默认为 `['AGENTS.local.md', 'CLAUDE.local.md']`，会与同一目录的基础文件一起加载其现有 overlay（渲染在它们之后），并应用同一个每目录去重；空列表会禁用 overlay。两个列表的候选配置项都必须是同目录文件名，因此会忽略空配置项、`.`／`..` 以及包含 `/` 或 `\` 的配置项。

user 全局文件始终是 `$DSH_HOME/AGENTS.md`，没有本地 overlay；两个候选列表只控制项目 scope。`$DSH_HOME` 默认为 `~/.dsh`，已配置的 `~`、`~/...` 与 Windows 风格 `~\...` 前缀会基于操作系统 home 目录展开。非正数或非有限渲染预算会同时禁用基线与动态加载；已配置 `maxSourceBytes` 必须是正整数。

## 预算与有界读取

渲染会优先保留最具体的指令文件。它会先丢弃完整的较宽泛文件，再截断最具体文件，并发出可见 `Workspace instruction budget ...` 通知，其中指名已省略与已截断路径。渲染后字节数绝不超过 `maxBytes`。

即使提供方元数据省略大小，或文件在元数据探测后增长，指令内容仍会通过 `streamText()` 在 `maxSourceBytes` 下读取。超大文件会被忽略；在动态对账期间，它会暂时不可用，而不是被移除。该插件不保留进程级 cache，绝不缓存指令文本。其会话本地 scope cache 只将提供方版本用作快速失效信号；失效后，对有界读取计算的 SHA-1 仍是存储在结构化会话元数据中的跨提供方内容身份。

## 模型体验

### 基线会话前缀

#### 模型看到的内容

在每个 loop 实例的第一个请求中，模型会收到一条 user 角色前缀消息，其中按从宽泛到具体的顺序包含有界 user 全局指令与项目指令链。

##### 基线指令模板

```markdown
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: ~/.dsh/AGENTS.md

<user-global-instructions>

Instructions from: AGENTS.md

<project-instructions>
</system-reminder>
```

#### Token 影响

渲染后基线会被冻结，并在该 loop 实例的每个请求中重发。`maxBytes` 会限制完整消息，较宽泛文件在最具体文件截断之前被省略，空指令链不产生 token。

#### KV Cache 影响

由于基线已冻结，前缀在同一 loop 实例内保持稳定。新建或恢复的实例会重新组合它，因此指令、优先级、cwd、候选文件或字节预算变更可能使从第一个改变的基线 token 起的复用失效。

### 新发现的 scope 上下文

#### 模型看到的内容

成功的第一方文件系统调用达到更深目录后，下一个请求会包含一条保留的注入 `user/message`，其中包含新适用的指令文件。

##### 附加指令模板

```markdown
<system-reminder>
Additional instructions from: packages/app/AGENTS.md

These instructions apply to work under `packages/app`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.

<nested-instructions>
</system-reminder>
```

#### Token 影响

每个已发现 scope 都会添加有界历史 token，直到压缩。可见会话状态与版本／digest 比较会抑制未更改内容，Code Mode 将同一消息延迟到外层 `run_code` 结果之后。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 配置项失效。

### 已改变或移除的指令上下文

#### 模型看到的内容

已改变文件会产生 `Updated instructions from: <path>` 加替换内容。消失或成为同一目录中较早候选文件重复项的候选文件会产生下方移除通知。

##### 移除通知

```markdown
<system-reminder>
Instructions removed: packages/app/AGENTS.md

The previously loaded instructions from this file no longer apply.
</system-reminder>
```

#### Token 影响

每项已确认变更或移除都是一条受 `maxBytes` 限制的保留历史消息。提供方失败不添加消息，预算省略的更新仍可在后续文件系统 touch 中处理。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 配置项失效。

## 已知限制与暂缓事项

- **发现跟随结构化 fs 工具，而非 shell 导航**：更改目录的 `bash` 命令不会触发嵌套指令发现，因为 shell 语法与每次调用 shell 状态不是可靠的文件系统 seam。
- **刷新由 touch 驱动**：没有 watcher；外部编辑会在下一次成功的第一方 `read`、`write` 或 `edit` 时可见，也会在恢复 loop 重新组合前缀时可见。
- **候选语义有意保持简单**：不解释小写名称、`.claude/rules/` 与 `@path` import；项目 scope 默认加载 `AGENTS.local.md`／`CLAUDE.local.md` overlay，但 user 全局 `$DSH_HOME` scope 没有本地 overlay，其他自定义名称需要显式候选配置。
- **每目录去重基于内容**：只有在去除首尾空白后字节完全一致时，才折叠同级候选文件。`CLAUDE.md` 若 symlink 到同级 `AGENTS.md`，会解析为相同内容，并像任何重复项一样折叠；从 `AGENTS.md` 漂移的独立实体副本则会与它一起完整加载。
- **Symlink 指令文件会跨越信任边界跟随**：最终组件是 symlink 的候选文件会被解析并加载其目标，因此克隆仓库可以将树外文件内容呈现为较低权限的工作区指引（它绝不会覆盖 system、developer 或直接 user 指令）。加载不受信任仓库时，请用文件系统策略门禁或 OS 沙箱限制 `ctx.fs`。
- **指令内容受限但不会摘要**：超出预算的宽泛文件会被省略，最具体文件可能被截断；该插件绝不请求模型压缩指令文本。
