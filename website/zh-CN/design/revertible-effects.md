# 可逆作用

可逆作用 (Revertible Effects) 是 Cordis 实现**时间可组合性**的核心机制。

- 在单子作用的基础上增加可逆性约束
- 提供面向长时运行程序的作用系统
- 确保程序可以在插件粒度上回到任意状态

## 副作用的封装

现实中的程序需要与各种副作用打交道。假设一个不纯函数：

$$
f_\text{impure}: \text{X}\to\text{Y}
$$

我们将所有可能的副作用用类型 $\mathcal{C}$ 封装，函数变为：

$$
f: \mathcal{C}\times\text{X}\to\mathcal{C}\times\text{Y}
$$

对于长时运行程序，忽略函数本身的入参和出参，$f$ 属于函数空间 $\mathfrak{F}=\mathcal{C}\to\mathcal{C}$。

## 从幺半群到群

任何函数 $f: \mathcal{C}\to\mathcal{C}$ 都是状态空间到自身的变换。在组合 $\circ$ 下构成**幺半群**：

1. 封闭性：$f\circ g$ 也是 $\mathcal{C}\to\mathcal{C}$
2. 结合律：$(f\circ g)\circ h=f\circ (g\circ h)$
3. 单位元：$\text{id}$，使得 $f\circ\text{id}=\text{id}\circ f=f$

如果额外要求每个 $f$ 存在逆元 $f^{-1}$（即副作用可回收），$\mathfrak{F}$ 升级为**群**。

## 副作用都可逆吗？

观察计算机中的副作用模式：

| 操作 | 占用资源 | 逆操作 |
|------|----------|--------|
| 打开文件 | 文件描述符 | 关闭文件 |
| 创建子进程 | 进程号 | 杀死进程 |
| 监听端口 | 端口 | 取消监听 |
| 添加回调函数 | 事件槽位 | 删除回调 |
| 分配内存 | 内存区块 | 回收内存 |

**副作用就是对资源的占用。** 计算机的资源天然设计为可重复使用，因此这些副作用一定是可逆的。

## 追踪和回收副作用

Cordis 通过 $\text{effect}$ 和 $\text{restore}$ 函子追踪和回收逆函数。

### effect 函子

$$
\begin{array}{}
\text{effect}&:&
\left(\mathcal{C}\to\mathcal{C}\right)&\to&
\mathcal{C}\times\left(\mathcal{C}\to\mathcal{C}\right)&\to&
\mathcal{C}\times\left(\mathcal{C}\to\mathcal{C}\right)\\
\text{effect}&=&f&\mapsto&\left(c, h\right)&\mapsto&\left(f(c), h\circ f^{-1}\right)
\end{array}
$$

直觉：执行 $f$ 产生的副作用记入状态 $c$，同时将逆操作 $f^{-1}$ 追加到回收链 $h$ 中。

### 同态性证明

$\text{effect}$ 是从 $\mathcal{C}\to\mathcal{C}$ 到 $\mathcal{C}\times(\mathcal{C}\to\mathcal{C})\to\mathcal{C}\times(\mathcal{C}\to\mathcal{C})$ 的同态：

$$
\begin{aligned}
\text{effect}\ (f\circ g) \left(c, h\right)
&=\left((f\circ g)(c), h\circ (f\circ g)^{-1}\right)\\
&=\left(f(g(c)), h\circ g^{-1}\circ f^{-1}\right)\\
&=\left(\text{effect}\ f\right)\left(g(c), h\circ g^{-1}\right)\\
&=\left(\text{effect}\ f\right)\circ\left(\text{effect}\ g\right) \left(c, h\right)
\end{aligned}
$$

这意味着：组合两个操作后再追踪 = 分别追踪后再组合。副作用追踪与执行顺序无关。

### restore 函子

$$
\begin{array}{}
\text{restore}&:&
\mathcal{C}\times\left(\mathcal{C}\to\mathcal{C}\right)&\to&
\mathcal{C}\times\left(\mathcal{C}\to\mathcal{C}\right)\\
\text{restore}&=&\left(c, h\right)&\mapsto&\left(h(c),\text{id}\right)
\end{array}
$$

直觉：将回收链 $h$ 应用到当前状态，一次性回收所有已追踪的副作用。

## 在 Cordis 中的实现

理论映射到 API：

| 数学概念 | Cordis API | 说明 |
|----------|-----------|------|
| $\text{effect}(f)$ | `ctx.effect(() => { ...; return dispose })` | 注册副作用并返回清理函数 |
| $\text{restore}$ | `fiber.dispose()` | 执行 Fiber 的整个回收链 |
| $f^{-1}$ | dispose 返回值 / cleanup 函数 | 逆操作 |

```ts
import type { Context } from 'cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

declare module 'cordis' {
  interface Events {
    'my-plugin/event'(): void
  }
}

declare function startServer(port: number): { close(): void }
declare function handler(): void
declare const myTool: ToolDefinition

export function apply(ctx: Context) {
  // effect: 创建资源，返回其逆操作
  ctx.effect(() => {
    const server = startServer(8080)     // f: 占用端口
    return () => server.close()          // f⁻¹: 释放端口
  })

  // 框架 API 内部已封装 effect
  ctx.on('my-plugin/event', handler)     // 内部: effect(addListener, removeListener)
  ctx.tools.register(myTool)             // 内部: effect(addTool, removeTool)
}
// 当此插件被卸载时，restore 自动按逆序执行所有 f⁻¹
```

## 为什么 Agent 需要可逆作用

在 Harness 场景下，可逆作用直接支撑：

- **热替换 LLM 适配器**：卸载旧适配器（回收注册）、加载新适配器，无需重启
- **动态 tool 管理**：根据对话上下文动态添加/移除 tool，不泄漏
- **子 Agent 生命周期**：子 Agent 完成后，其注册的所有临时 tool 和监听器自动清理
- **优雅关闭**：进程退出时所有插件按依赖逆序 dispose，确保资源完全释放
