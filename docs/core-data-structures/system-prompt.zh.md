# 系统提示词组装

[English](system-prompt.md) | 中文

[system-prompt 包](../../packages/core/system-prompt)负责管理 prompt 贡献者与一次组装调用之间交换的数据。该包的 [README](../../packages/core/system-prompt/README.md) 记录了注册、排序、作用域与渲染行为；本页固定各插件实现或传递的跨包字面形状。

源码：[`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)。

## 组装上下文

`AssembleContext` 标识一次组装所解析的作用域层。它可通过合并扩展：`dsh-agent` 添加可选的活跃 `agent` 字段，`assembleContextFor(agent)` 同时设置该字段与 `scope`。

```ts type-equiv
interface AssembleContext {
  scope?: ScopeKey
}
```

## 工具提供方结果

`ToolProviderResult.schemas` 是当前组装中对模型可见的工具集合。`knownNames` 是提供方在限制前的名称全集，用于区分「配置名拼写错误」与「已知工具在此作用域中被有意隐藏」。

```ts type-equiv
interface ToolProviderResult {
  readonly schemas: readonly ToolSchema[]
  readonly knownNames?: readonly string[]
}
```

## Prompt 段落

`PromptSection` 是一份只读的同进程注册契约。其文本可以是静态的，也可以从当前组装上下文动态解析。

```ts type-equiv
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
}
```
