# Agent Note: Plugin configuration in the web settings page

Status: implemented

[English](2026-08-10-web-plugin-configuration.md) | 中文

## 问题

插件的一切可配置项都只存在于 `cordis.yml`。想要更长的 shell 超时、不同的搜索端点或更少的并行工具调用，用户必须找到组装文件、了解它的形状，然后重启——而 Models 页几个月来一直在证明：settings 命名空间可以在浏览器里编辑并立即生效。

支撑 Models 页的那条 seam 本就是通用的：任何插件都可以注册命名空间，`settings.describe` 会提供它的 schema、分层与 revision。缺的是两端。除 LLM 适配器与权限服务外，没有插件注册过命名空间；而对于非模型提供方的命名空间，也没有任何表层。

## 决策

三个宿主平面插件各自注册 settings 命名空间，一个浏览器侧分区渲染该部署所暴露的一切。

**分层不变。** 一个分节按 schema 默认值 → 插件的组装条目 → 用户层解析。每个插件把自己的 `cordis.yml` 条目作为 `base` 传入，并通过 source thunk 读取配置，因此存储的变更会作用于下一次使用，而脱离的 settings 提供方会让组装条目继续运行。schema 无法表达的约束——正有限、`graceMs` 的定时器上界、并行上限必须是正整数——成为分节的校验器，因此错误的值在写入时被拒绝，而不是到下一条命令时才失败。

**shell 命名空间命名的是能力，而非某个实现。** `BASH_SETTINGS_NAMESPACE` 由 `@deepseek-ai/dsh-bash` 导出，因为一个宿主只组装一个 `ctx.bash` 提供方：win32 层会把 POSIX 行换成 pwsh 行，而同时挂载两者会因服务重复注册在加载期失败。因此两个家族都能用自己的 schema 与条目注册同一个命名空间而永不相撞；在平台间携带的 `settings.yaml` 也能在两边继续解析——schemastery 对象会保留当前 schema 未声明的键。

**当插件配置大于用户所拥有的部分时，分节就是一个子集。** `agent-loop` 只暴露 `maxParallelToolCalls`；它的 `agents` 数组在服务启动时被消费一次，所以存储在那里的变更只会看起来生效。

**提供方按次投影，而不是固化。** `web-search-deepseek` 交给提供方的是一个 thunk 而非 options 值，因此端点或模型的变更无需重新注册提供方即可作用于下一次搜索——重新注册会让 web seam 的提供方选择以闪断的形式被用户看到。

**暴露仍是 Host 的白名单。** 这三个命名空间加入 `WEB_SETTINGS_NAMESPACES`；仅有注册依然不会跨越传输边界，而不在该名单中的命名空间会与未注册的命名空间得到完全相同的 `settings-not-exposed`。

**该分区不认识任何命名空间。** `dsh-client-ui-plugin-config` 声明 `settings.plugin.item` slot 并渲染注册进来的卡片，因此带浏览器半侧的插件拥有自己的卡片与控件。每张卡片通过客户端 settings scope 绑定其命名空间，而该 scope 补上了表单所需的两样东西：原始 `user` 层——键的**存在**才标记字段被覆盖——以及把单个字段清回组装层的 `unset`。命名空间不可用时卡片什么都不渲染，因此未组装该插件的部署不会显示它的任何痕迹。

## 备选方案

- **用注册期的暴露声明取代白名单。** 这才是诚实的形状——命名空间的拥有方声明自己的暴露，在本仓库之外分发的插件也无需改动 `packages/host/apiproxy` 就能呈现自己的配置。之所以暂缓，是因为它会同时改变 seam 契约、全部现有注册点与防枚举语义；而且插件要暴露任意 schema，还得先有 fail-closed 的脱敏路径：目前只能经由 union 或 transform 抵达的 secret 会被原样返回。
- **通用 schema 驱动的表单渲染器。** 再次否决，理由与 web-config-plane 笔记所记一致：没有呈现词汇的字段真值产出的是无法使用的卡片。三个插件的手写控件成本相当而可读性更好，且该 slot 让第四个插件无需与本包协商。
- **在本页编辑 preset 挂载的插件。** 超出范围，而且不只是「尚未实现」：preset 的行把配置内联在 `agent.cordis.yml` 中，且根本无法注册 settings 命名空间——同一 preset 挂载第二个会话时会因重复注册而失败。跨 preset 共享的用户层还会覆盖 preset 用来定义其 agent 身份的字段——人设文本、委派接线——而这些字段按设计就是各 preset 各自的。
- **按执行器包各取一个命名空间，而非按能力命名的 `bash`。** 否决，因为被组装的执行器随平台不同，而设置文档不随平台不同：在 macOS 上设过超时的用户，到 Windows 上会悄无声息地失去它。
- **把搜索密钥写进 settings 分节。** 否决，因为那样字面值就必须搭乘 `describe` 响应才能被渲染。卡片只报告是否已配置密钥，并按分节所命名的引用经由 credentials 领域写入。

## 影响

用户可以在设置页编辑 shell 的命令超时与输出上限、agent 循环的并行工具调用上限，以及搜索提供方的密钥、端点与单次请求预算，每个字段都标注是否由自己设定，并提供重置。

有两项真实代价。加入第四个插件仍需要在 apiproxy 白名单里添一条，因此本页的覆盖面是 Host 的决定而非插件的决定。而 web 部署移入 agent 平面的那些插件——文件工具、技能、压缩、todo 工具——在这里一个都不出现，而它们恰恰是用户最可能期待找到的；它们的配置仍归 preset 编辑器。

bash 与 pwsh 执行器现在把 `config` 暴露为 source thunk 之上的 getter，而不再是 readonly 字段。所有读取点本就是按次读取，因此别无变化；但若某个子类在构造期捕获 `this.config`，就会悄然把组装条目钉死。
