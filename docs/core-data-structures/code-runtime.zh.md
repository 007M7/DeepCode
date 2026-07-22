# 代码运行时

[English](code-runtime.md) | 中文

代码执行 seam 是一个[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)：其接口（[dsh-code-runtime](../../packages/code-runtime/code-runtime)，`ctx.codeRuntime`）针对宿主提供的异步 binding 运行一段模型编写的程序，并报告其打印内容与返回值。代码执行是**一项可选能力**，不属于 agent loop 主干，因此其词汇定义在此而非 [core.md](core.md) 中。各后端的执行基底与源语言不同，这两项均为服务上的只读描述符；worker-thread 后端和工具注册表消费方（Code Mode）由 [Code Mode Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md) 规定。

源码：[`packages/code-runtime/code-runtime/src/types.ts`](../../packages/code-runtime/code-runtime/src/types.ts)

## 运行：请求进，结果出

`CodeRunRequest` 携带**运行时所需的一切**。按照「包（package）边界处显式优于隐式」的规则，默认值（时间预算、输出上限）来自实现的已校验配置，绝不是 `run()` 内部隐藏的 `??`：

```ts type-equiv
/**
 * One run: the program source plus everything the runtime acts on. Per the
 * explicit-over-implicit convention, defaulting (time budgets, output caps)
 * is the implementation's validated config — a request carries no optional
 * tuning knobs for a hidden `??` to fill in.
 */
interface CodeRunRequest {
  /**
   * The program source, in the runtime's {@link ../index.ts | language}. It
   * runs as the body of an async function: top-level `await` and `return`
   * are available, and the completion value becomes
   * {@link CodeRunResult.value}.
   */
  program: string
  /** Host functions exposed to the program, one global object per namespace. */
  bindings: CodeBindingNamespace[]
  /**
   * Abort the run: the runtime stops the program (hard, even mid-loop) and
   * resolves with a {@link CodeRunFailure} of kind `'abort'`. In-flight
   * binding calls are the CALLER's to settle — the runtime only stops asking.
   */
  signal?: AbortSignal
}
```

结果将错误报告为一个**字段**，而非 `run()` 的 rejection。报告失败的程序是调用方的职责，不走异常路径（与 `BashExecutor.run` 的 resolve-on-failure 契约一致）：

```ts type-equiv
/**
 * The outcome of one run. An error is a FIELD on a resolved result, never a
 * rejection of `run()` — reporting a failed program is the caller's job, not
 * an exception path.
 */
interface CodeRunResult {
  /**
   * The program's completion value (its top-level `return`), when it ran to
   * completion and the value survived the runtime's serialization boundary;
   * a non-transferable value is replaced by a string rendering, and a failed
   * or value-less run leaves this absent.
   */
  value?: unknown
  /** Text the program emitted, in order (capped by the implementation). */
  logs: string[]
  /** Present iff the run failed; see {@link CodeRunFailure} for the taxonomy. */
  error?: CodeRunFailure
}
```

## 绑定：宿主函数作为程序全局变量

每个 `CodeBindingNamespace` 在程序内成为一个由异步可调用函数组成的全局对象（Code Mode 消费方传入一个：`tools`）。参数与返回值必须可 structured-clone（运行时可能跨序列化边界桥接调用），且运行时将绑定名视为不可信输入（`__proto__` 是普通自有属性，绝不会发生原型碰撞）：

```ts type-equiv
/**
 * A named group of {@link CodeBindingFunction}s the runtime exposes to the
 * program as one global object (e.g. `tools`). Function names are arbitrary
 * strings — a runtime must treat names like `__proto__` or `constructor` as
 * ordinary own properties (null-prototype construction), never as prototype
 * collisions.
 */
interface CodeBindingNamespace {
  /** The global identifier the program sees (must be a valid JS identifier). */
  global: string
  /** The callable members, keyed by the exact name the program calls. */
  functions: Record<string, CodeBindingFunction>
}
```

```ts type-equiv
/**
 * One host-side function exposed to the program as an async callable. The
 * runtime bridges calls to it (possibly across a serialization boundary), so
 * `args` and the resolution value MUST be structured-cloneable; a runtime
 * rejects a non-cloneable value with a descriptive error rather than
 * corrupting the run. A rejection of this function surfaces inside the
 * program as a rejection of the corresponding call.
 */
type CodeBindingFunction = (args: unknown) => Promise<unknown>
```

## 捕获的输出与失败分类体系

日志是按发出顺序排列的纯字符串。运行时捕获程序的 console 与流输出，但通道和 console 方法的元数据不属于 seam 的一部分，因为消费方只渲染文本。实现对聚合输出设上限，并在输出内标记截断。

失败类型是**正交的结果，独立报告**（见 [defensive-patterns](../defensive-patterns.md)）：预算耗尽不是异常，中止不是超时，基底崩溃（如 OOM）也不是二者中的任何一个：

```ts type-equiv
/**
 * Why a run failed. The kinds are orthogonal outcomes reported independently
 * (per docs/defensive-patterns.md): a budget expiry is not an exception, an
 * abort is not a timeout, and a substrate death is neither.
 *
 * - `'exception'` — the program threw or failed to parse/transform.
 * - `'timeout'` — an implementation-owned budget expired; the message says which.
 * - `'abort'` — {@link CodeRunRequest.signal} fired.
 * - `'worker-exit'` — the execution substrate died without settling (e.g. OOM).
 */
interface CodeRunFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}
```

## 服务

`CodeRuntime`（`ctx.codeRuntime`，抽象服务，定义于 [`packages/code-runtime/code-runtime/src/index.ts`](../../packages/code-runtime/code-runtime/src/index.ts)）由 `run(request)` 加两个只读描述符组成：`language`（程序必须使用的语言，`'typescript'` 是已知值；生成语言相关展示的消费方据此切换，遇到无法展示的语言时应显式报错）和 `isolation`（执行基底，`'worker-thread'`、`'process'`、`'container'`；仅为诊断标签，**不构成安全承诺**）。实现必须保证各次运行彼此隔离（无跨运行状态），并在 dispose（资源释放）时等待系统完全停稳：teardown 完成前，进行中的运行都已终止并等待结束。
