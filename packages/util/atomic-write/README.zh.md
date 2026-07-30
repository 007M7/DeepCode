# dsh-atomic-write

[English](README.md) | 中文

零依赖的原子文件替换，供绝不允许在磁盘上留下不完整、被符号链接劫持或权限过宽内容的文件型存储共用：用户设置文档（`dsh-settings-local`）与凭据存储（`dsh-credentials-local`）。

## 接口面

```ts
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const text: string
declare const render: (previous: string) => string

await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })

// Read-modify-write against the same file from several processes.
await withFileLock('/home/u/.dsh/settings.yaml', async () => {
  await writeFileAtomic('/home/u/.dsh/settings.yaml', render(text), { mode: 0o600 })
})
```

`writeFileAtomic` 提交一份已经渲染好的字符串。契约按故障利用它的先后顺序列出：

- **独占创建临时文件**（`wx` + 随机后缀）：open 拒绝跟随预先埋在可猜测临时路径上的符号链接。
- **全新 inode 携带 `mode` 走完 rename**：替换权限过宽的旧文件时直接收窄，不存在 chmod 竞态。`mode` 为必填，让权限决策始终可见于每个调用点（与所有新建 inode 一样受进程 umask 影响）。
- **`rename` 替换的是符号链接目标本身**，绝不写穿到其指向的文件。
- **同目录兄弟文件**保证 rename 落在同一文件系统上，交换保持原子。
- 自动创建父目录；任何失败都会移除临时文件并重新抛出该失败；读取方只会观察到旧内容或完整的新内容。

`withFileLock` 跨进程串行化同一文件的写入方，服务于单靠原子提交无法保证安全的读-渲染-提交循环。锁是以 `wx` 创建的同目录 `<filename>.lock`，因此读取方从不参与竞争；等待方按指数退避，超时即失败而非无限阻塞。超过陈旧时限的锁被视为持有者已崩溃并被打破——其代价见[Known Limitations and Deferred Work](#known-limitations-and-deferred-work)。

## Model Experience

无：本包是纯文件系统原语，此处没有任何内容会到达模型请求。

#### KV Cache effect

无；此处没有任何内容会进入请求前缀。

## Known Limitations and Deferred Work

- **原子但不保证持久**——不对文件或其所在目录做 `fsync`，因此崩溃后可能观察到 rename 被回退。此处的文件型存储在启动时重新读取并重新发布，把持久性留作调用方的策略。
- **仅支持字符串内容**——在有消费方需要之前，不提供 `Buffer` 或流式形态。
- **锁按时长而非归属接管**（`TODO(settings-lock-ownership)`）——持有者若慢于陈旧时限，其锁会被等待方打破，而释放又无条件删除该路径，因此慢写入方可能删掉后继者的锁。两个写入方随之重叠，一轮循环的结果可能丢失。陈旧时限远高于本仓库的任何一次写入，因此暴露面是被暂停或被换出的进程；修法是按归属安全地获取与释放。
