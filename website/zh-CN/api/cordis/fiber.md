# Fiber

Fiber（作用域）是插件实例的运行时容器，管理其生命周期和效果。

## 状态机

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

| 状态 | 数值 | 含义 |
|------|------|------|
| PENDING | 0 | 依赖未就绪，等待中 |
| LOADING | 1 | 正在执行 `apply` |
| ACTIVE | 2 | 运行中 |
| FAILED | 3 | `apply` 抛出异常 |
| UNLOADING | 4 | 正在撤销效果 |
| DISPOSED | 5 | 已完全卸载 |

## 实例属性

### fiber.uid

- **类型:** `number`

Fiber 的唯一标识符。

### fiber.status

- **类型:** `number`

当前状态（见状态机）。

### fiber.config

- **类型:** `object`

传递给插件的配置对象。

### fiber.error

- **类型:** `Error | undefined`

如果状态是 FAILED，包含导致失败的异常。

## 实例方法

### fiber.effect(callback) {#fiber-effect}

- **callback:** `() => (() => void) | void`
- **返回值:** `() => void`

注册一个效果。`callback` 在 Fiber 激活时执行；如果返回函数，该函数在 Fiber dispose 时执行。

```typescript
ctx.effect(() => {
  const timer = setInterval(tick, 1000)
  return () => clearInterval(timer)
})
```

等价地可以通过 `ctx.effect()` 调用（ctx 代理到当前 fiber）。

### fiber.dispose()

- **返回值:** `Promise<void>`

手动 dispose 该 Fiber。按注册逆序撤销所有效果，递归 dispose 所有子 Fiber。

```typescript
const child = ctx.plugin(somePlugin)
// 之后:
await child.dispose()
```

### fiber.update(config)

- **config:** `object` 新配置
- **返回值:** `void`

热更新配置。如果新旧配置不同，触发 dispose + 重新 apply。

### fiber.restart()

- **返回值:** `void`

强制重启：dispose 后重新加载。

### fiber.then(resolve, reject?)

- **返回值:** `Promise<void>`

使 Fiber 可以被 `await`：等到状态进入 ACTIVE 或 FAILED。

```typescript
const fiber = ctx.plugin(myPlugin)
await fiber  // 等待插件加载完成
```

## 访问当前 Fiber

```typescript
export function apply(ctx: Context) {
  const fiber = ctx.fiber  // 当前插件的 Fiber
  console.log(fiber.status)  // 1 (LOADING, 因为正在 apply 中)
}
```
