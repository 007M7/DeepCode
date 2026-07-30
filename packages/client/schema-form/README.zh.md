# @deepseek-ai/dsh-client-schema-form

[English](README.md) | 中文

面向 settings 分节的 schema 驱动 React 表单渲染器。wire 侧的 `settings.describe` 携带每个 namespace 的序列化 schemastery schema（`schema.toJSON()` 的 ref 信封）；`SchemaForm` 用 `new Schema(json)` 将其还原（rehydrate），并把每个已声明的字段渲染为可编辑控件——在宿主上校验分节的那份 schema 对象，就是在浏览器里校验并驱动表单的那份对象，因此不存在第二份会漂移的表单定义。

## 契约

`SchemaForm` 是围绕**用户分节草稿**的受控组件：`draft` 是正在编辑的对象（绝不被原地修改；每次编辑都以新的根对象调用 `onChange`），`fallback` 则是用于展示继承值的解析值（schema 默认值 → 组合 base → 用户层）。字段只要出现在草稿中就被标记为**已覆盖**，并显示一个删除该键、回退到继承层的逐字段 Reset——判定采用存在性语义而非值比较，与 settings seam 的分层方式严格对应。

控件按 schema 节点分派：`object` → 带标签的字段组（渲染 JSDoc `description`，`required` 字段加星标）；`string`/`number`/`boolean` → 以继承值为占位符的输入框；字面量 `union` → 下拉框，空选项表示「继承」；`array` → 按位置排列、可增删的行（数组在写入时整体替换）；`dict` → 按键排列的行，其中联合类型的 `sKey` 成为「新增」下拉框的词汇。`role('secret')` 渲染为**只写**的密码输入框：已存储的值永远不会送达（wire 会剥除它），占位状态由 `secrets` 槽位列表（`{path, set}`）提供。渲染器无法忠实编辑的节点（非字面量联合、转换（transform）节点）渲染为带提示的只读 JSON 视图，而不是直接消失——schema 字段绝不会被静默丢弃。

`renderField(context)` 是感知角色的覆盖钩子：返回一个节点，即可替换单个叶子字段的默认控件。Models 设置页用它挂载与 `credentials.*` 通信的凭据引用控件（`role('credential-ref')`）——该包（package）自身始终不接触 wire，也没有副作用。

`validateDraft(schema, draft)` 运行还原出的校验器并返回其失败消息，页面因此可以先校验再写入；路径辅助函数（`getPath`/`hasPath`/`setPath`/`deletePath`）对外暴露的不可变草稿编辑，与控件内部使用的是同一套。

## Model Experience

无。该包渲染的是浏览器配置表单；这里没有任何内容进入模型请求。

#### KV Cache effect

无；该包既不组装也不发送提供方请求。

## Known Limitations and Deferred Work

- **校验是表单级的，而非逐字段**——`validateDraft` 报告 schemastery 的第一条失败消息（其中会点名 `$.path`）；逐字段的内联报错展示延后到出现需要它的第二个消费方再做。
- **字符串内置为英文**——`labels` prop 可以覆盖每一条用户可见字符串，但包内没有接入语言环境词典的接线；本地化归嵌入它的页面所有。
- **非字面量联合与转换节点只读渲染**——忠实编辑这些形状需要逐形状的控件；目前它们回退为带提示的 JSON 视图。
- **数组编辑整体替换**——settings seam 同样不存在元素级合并；表单如实呈现该契约，而不是把它藏起来。
