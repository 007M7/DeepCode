# dsh-client-ui-agent-preset

[English](README.md) | 中文

agent preset 表层：General 设置中的一行，用于选择新建会话据以组装的 [preset](../../preset/agent-presets/README.md)。

## 为什么它是"新建会话"的偏好设置

会话的 preset 在创建时即固定——宿主拒绝以不同 preset 接管已存在的会话，因为该会话的历史是在最初那份 preset 的工具下产生的。因此本行不可能是实时切换，它也如实说明了这一点：更改只对此后开启的会话生效，而运行中的会话保持它们开始时的组装。

## composer 座位

第二个表层，位于 composer 工具行、模型选择器左侧：**本会话**所运行的 preset。它显示会话自身记录的 preset 而非部署默认值，因为被恢复的会话运行的是它创建时的那一份。

切换只在对话尚未开始时存在。第一个轮次之后，该座位变为纯文本标签——展示一个禁用的菜单会让人以为这个选择只是暂时不可用，而非已经消失。宿主执行同一条规则并返回 `agent-preset-locked`，因此过期的客户端无法绕过它。

## 它读什么、写什么

选项与当前默认值都来自同一次 `agentPreset.list` 调用。名单本身已经报告了"未显式选择的会话会得到哪个 id"，因此本行无需对 settings schema 做内省；写入目标是 `agent-presets` settings 命名空间的 `default` 字段，也正是宿主在创建时解析的那个字段。

本地创作的 preset 的权限恰好等于它所引用的插件，因此列表会标注 `user` 行，而不是把每个 preset 都呈现为随附且已审核的。

本行在自身命名空间的 `settings/changed` 以及 `connection/reset` 时重新读取：名单是一个活动目录，默认值是一项设置，外部编辑与重新连接都可能改变它。

## 何时不显示本行

未组装任何 preset 的部署返回空名单，本行不渲染任何内容——此时每个会话共用宿主组装，也就无从选择。

## Model Experience

Indirectly, through the preset a later session is composed from; [`dsh-agent-presets`](../../preset/agent-presets/README.md) owns what that composition puts in front of the model.

#### KV Cache effect

没有直接的失效影响。更改默认值绝不触及运行中会话的前缀；此后创建的会话依据它自己的组装建立自己的前缀。

## Known Limitations and Deferred Work

- **preset 按 id 列出** —— preset 不携带展示用元数据，因此菜单显示的是目录名。
- **不提供创作能力** —— 创建、编辑或删除 preset 是文件系统行为；本表层只在名单提供的范围内做选择。
