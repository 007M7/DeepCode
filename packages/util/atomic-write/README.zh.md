# dsh-atomic-write

[English](README.md) | 中文

零依赖的原子文件替换，供绝不允许在磁盘上留下不完整、被符号链接劫持或权限过宽内容的文件型存储共用：用户设置文档（`dsh-settings-local`）与凭据存储（`dsh-credentials-local`）。

## 接口面

```ts
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const text: string

await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })
```

仅一个导出。契约按故障利用它的先后顺序列出：

- **独占创建临时文件**（`wx` + 随机后缀）：open 拒绝跟随预先埋在可猜测临时路径上的符号链接。
- **全新 inode 携带 `mode` 走完 rename**：替换权限过宽的旧文件时直接收窄，不存在 chmod 竞态。`mode` 为必填，让权限决策始终可见于每个调用点（与所有新建 inode 一样受进程 umask 影响）。
- **`rename` 替换的是符号链接目标本身**，绝不写穿到其指向的文件。
- **同目录兄弟文件**保证 rename 落在同一文件系统上，交换保持原子。
- 自动创建父目录；任何失败都会移除临时文件并重新抛出该失败；读取方只会观察到旧内容或完整的新内容。

## Model Experience

无：本包是纯文件系统原语，此处没有任何内容会到达模型请求。

#### KV Cache effect

无；此处没有任何内容会进入请求前缀。

## Known Limitations and Deferred Work

- **原子但不保证持久**——不对文件或其所在目录做 `fsync`，因此崩溃后可能观察到 rename 被回退。此处的文件型存储在启动时重新读取并重新发布，把持久性留作调用方的策略。
- **仅支持字符串内容**——在有消费方需要之前，不提供 `Buffer` 或流式形态。
