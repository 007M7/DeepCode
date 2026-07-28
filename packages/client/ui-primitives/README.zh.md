# @deepseek-ai/dsh-client-ui-primitives

[English](README.md) | 中文

纯 React 原子组件（零 cordis）：StateDot、ic_ds_* 图标、Button/Pill/Menu/Modal/Input、markdown 家族（MessageText/MarkdownText/JsonBlock），以及 TerminalBlock。契约：api-contracts v3 §8。

## Markdown 渲染

`MarkdownText` 通过 React 元素渲染来自不受信任 assistant 输出的 GFM。它会省略原始 HTML，使相对链接及非 HTTP(S)/mailto 链接失效，以安全的外部链接属性打开 HTTP(S) 链接，并只渲染图片 alt 文本而不加载远程资源；`MessageText` 仍是用户创作内容使用的字面文本原语。元素间距、表格、链接与行内代码使用与 deepsuite `@deepseek/md` 相同的 `--dsw-alias-markdown-*` / `--dsw-font-markdown-*` token。围栏代码块通过 `CodeBlock` 渲染（语言横幅、复制控件，以及对已注册语法使用 shiki）。

## 终端输出

`TerminalBlock` 将一条 shell 命令渲染为终端表层：提示行（缩短后的 `cwd` 标签加命令）、命令输出、非零退出码或终止信号对应的状态胶囊，以及写入原始 `output` prop 的复制控件。ANSI 转义序列通过运行时依赖 `anser` 解析为 React span；基础 16 色前景色映射到 `--dsw-*` token，而 256 色板与真彩色值按字面 rgb 透传。输出保持 `white-space: pre` 并支持横向滚动，因此按列对齐的输出保留其对齐而不会软换行；超过 `maxLines`（默认 16，与 TUI 转录相同的切分算法）时折叠为头部切片加尾部切片，由展开按钮控制。原理：[Web 终端卡片笔记](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md)。

## 模型体验

无。该包在浏览器中渲染纯 React 原子组件；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **字形级图标是重新绘制的近似版本**：鱼形标志（以及 ui-conversation 持有的闪光图标）来自字体字形，而本地设计数据无法导出其矢量几何；在获得精确导出路径前，使用手工重建版本代替。
- **Pill 与 Input 没有设计来源**：两个原子组件均自行定义；与其相似的侧边栏搜索字段和视图标签条由消费方组合，不是这些原子组件。
- **StateDot 的 `Active` 变体是设计中的隐藏占位符**：尚未实现；已交付的四种状态（done/warning/ongoing/error）构成完整的 P-I 表层。
- **`TerminalBlock` 不是终端模拟器**：它渲染已结束或仍在运行的命令输出，而不是交互式会话：SGR 颜色与属性会被遵循，而光标移动、清屏和备用屏幕序列会被剥离。基础 16 色中的洋红与青色没有对应 token，保持字面 rgb。
