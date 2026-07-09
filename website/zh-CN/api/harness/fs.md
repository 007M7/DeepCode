# Filesystem (dsh-fs)

文件系统操作接口。

**接口包:** `@deepseek-ai/dsh-fs`
**实现:** `@deepseek-ai/dsh-fs-local` + `@deepseek-ai/dsh-fs-policy`
**消费者:** `@deepseek-ai/dsh-tool-fs`

## FS Service

### ctx.fs.read(path, options?)

- **path:** `string`
- **options:** `{ offset?: number; limit?: number }`
- **返回值:** `Promise<string>`

读取文件内容。

### ctx.fs.write(path, content)

- **path:** `string`
- **content:** `string`
- **返回值:** `Promise<void>`

写入文件（覆盖）。

### ctx.fs.edit(path, edits)

- **path:** `string`
- **edits:** `Edit[]`
- **返回值:** `Promise<void>`

对文件执行精确的字符串替换编辑。

### ctx.fs.stat(path)

- **path:** `string`
- **返回值:** `Promise<FileStat>`

获取文件/目录信息。

## 配置 (dsh-fs-local)

```typescript
interface Config {
  /** 工作目录（相对路径的基准） */
  cwd: string
}
```

## 策略门 (dsh-fs-policy)

`dsh-fs-policy` 是一个可选的中间层插件，实现 read-before-write/edit 策略——模型必须先读取文件才能写入或编辑。这防止模型盲目覆盖文件。

在 `cordis.yml` 中，它位于 `fs-local` 和 `tool-fs` 之间：

```yaml
- name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.cwd()
- name: '@deepseek-ai/dsh-fs-policy'
- name: '@deepseek-ai/dsh-tool-fs'
```

## 模型可用的 Tools

| Tool | 说明 |
|------|------|
| `read` | 读取文件内容（支持 offset/limit） |
| `write` | 写入文件（需要先 read） |
| `edit` | 精确字符串替换（需要先 read） |

## 三件套结构

- `dsh-fs`：接口定义
- `dsh-fs-local`：本地文件系统实现
- `dsh-fs-policy`：策略门（read-before-write 检查）
- `dsh-tool-fs`：模型 tool 层
