# @deepseek-ai/dsh-tool-str-replace-editor

[English](README.md) | 中文

基于 `ctx.fs` 的独立模型可见 `str_replace_editor`。它可与持久 Bash、一次性 Bash、沙箱 Bash 或其他终端表面组合。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxOutputChars` | `16000` | 文件和目录查看结果保留的前缀字符数。 |
| `description` | 编辑器命令指南 | 面向模型的工具描述。 |
| `requireAbsolutePath` | `true` | 拒绝相对路径；仅当部署明确约定 session cwd 时才应关闭。 |

## 工具

Schema 提供 `view`、`create`、`str_replace` 与 `insert`。文件查看使用从一开始的行号；目录查看忽略隐藏、依赖与 Python 缓存条目并下探两层。替换要求字面量唯一匹配，错误只使用公开的 `old_str` 词汇。插入遵循所选的零基插入边界，不会隐式补尾换行。

## 模型体验

### 工具 schema

#### 模型所见

生成的 [`str_replace_editor` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-str-replace-editor)，其中包含配置的 `description`。本插件不贡献独立系统提示词段。

#### Token 影响

`str_replace_editor` 可见时产生固定的 schema 成本。

#### KV Cache 影响

配置的描述与 schema 不变时前缀稳定。

### 工具结果

#### 模型所见

查看操作返回带行号文本或浅层目录列表。修改操作返回简洁确认。长查看结果保留前缀并追加截断提示。

#### Token 影响

随数据变化，并受 `maxOutputChars` 与固定截断提示约束。

#### KV Cache 影响

工具结果以追加方式位于可复用请求前缀之后。

## 已知限制与延后工作

- 操作面向 UTF-8 文本，不支持二进制文件。
- `str_replace` 刻意拒绝零匹配或多匹配，且没有 `replace_all` 参数。
- 规范模式会在替换或插入前展开制表符，与参考字符串替换编辑器保持一致。
- 安全与先读后改策略委托给挂载的文件系统和策略插件。
