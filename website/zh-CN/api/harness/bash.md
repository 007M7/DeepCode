# Bash (dsh-bash)

Bash 命令执行接口。

**接口包:** `@deepseek-ai/dsh-bash`
**实现:** `@deepseek-ai/dsh-bash-local`
**消费者:** `@deepseek-ai/dsh-tool-bash`（内置于 agent-core）

## Bash Service

### ctx.bash.execute(request)

- **request:** `BashRequest`
- **返回值:** `Promise<BashResult>`

执行一个 bash 命令。

## BashRequest

```typescript
interface BashRequest {
  /** 要执行的命令 */
  command: string
  /** 工作目录 */
  workdir?: string
  /** 超时时间 (ms) */
  timeoutMs?: number
}
```

## BashResult

```typescript
interface BashResult {
  /** 退出码 */
  exitCode: number
  /** stdout 输出 */
  stdout: string
  /** stderr 输出 */
  stderr: string
  /** 是否超时 */
  timedOut: boolean
}
```

## 配置 (dsh-bash-local)

```typescript
interface Config {
  /** 命令超时时间，默认 120000 (2 分钟) */
  timeoutMs: number
}
```

在 `cordis.yml` 中：

```yaml
- name: '@deepseek-ai/dsh-bash-local'
  config:
    timeoutMs: 60000
```

## 模型可用的 Tools

`dsh-tool-bash` 向模型暴露以下 tools（由 `agent-core` 捆绑）：

| Tool | 说明 |
|------|------|
| `bash` | 执行命令（同步，等待完成） |
| `bash_output` | 获取后台命令的输出 |
| `bash_kill` | 终止后台命令 |

## 设计模式

Bash 是 Harness 的"能力三件套"典型案例：

- `dsh-bash`（接口）：定义 `ctx.bash` 和 `BashRequest`/`BashResult` 类型
- `dsh-bash-local`（实现）：通过 `child_process.spawn` 在本地执行
- `dsh-tool-bash`（消费者）：将能力包装为模型可调用的 tool

换一个沙箱执行器只需替换 `dsh-bash-local`，接口和 tool 不变。
