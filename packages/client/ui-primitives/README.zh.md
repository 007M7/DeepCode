# @deepseek-ai/dsh-client-ui-primitives

[English](README.md) | 中文

纯 React 原子组件（零 cordis）：StateDot、ic_ds_* 图标、Button/Pill/Menu/Modal/Input、markdown 家族（MessageText/MarkdownText/JsonBlock），以及 TerminalBlock。契约：api-contracts v3 §8。

## Markdown 渲染

`MarkdownText` 通过 React 元素渲染来自不受信任 assistant 输出的 GFM。它会省略原始 HTML，使相对链接及非 HTTP(S)/mailto 链接失效，以安全的外部链接属性打开 HTTP(S) 链接，并只渲染图片 alt 文本而不加载远程资源；`MessageText` 仍是用户创作内容使用的字面文本原语。元素间距、表格、链接与行内代码使用与 deepsuite `@deepseek/md` 相同的 `--dsw-alias-markdown-*` / `--dsw-font-markdown-*` token。围栏代码块通过 `CodeBlock` 渲染（语言横幅、复制控件，以及对已注册语法使用 shiki）。

## 终端输出

`TerminalBlock` 将一条 shell 命令渲染为终端表层：命令的每一行各占一个提示行（缩短后的 `cwd` 标签只出现在第一行，因为视图只知道一个工作目录，而一个 `cd` 就会让后面的行去到别处，标签之后是该行）、命令输出、非零退出码或终止信号对应的状态胶囊，以及写入原始 `output` prop 的复制控件。一枚运行状态 `StateDot` 为整次调用标记一次，位于第一行，以脱离文档流的方式落在卡片表面左侧的落区中。它用到 `StateDot` 的三种状态——`running` 期间为追逐动画，与渲染状态胶囊相同的退出状态为红色，其余为绿色——因此卡片直接陈述其命令是否仍在运行，而不是让人从有无输出中推断；由于 `StateDot` 是 `aria-hidden`，它携带一处视觉隐藏的文本标签。无论多少行都只有一枚状态点是有意为之：退出状态属于整次调用，因此每行一枚就会声称一个视图并不携带的逐行结果。命令文本使用 `white-space: pre`，因此重复空格、制表符与缩进续行都原样呈现，同时该行仍保持单行并以省略号截断。ANSI 转义序列通过运行时依赖 `anser` 解析为 React span；回车重绘与退格覆盖会按终端的行为先行结算，之后才剥除无显示意义的控制符；基础 16 色前景色映射到 `--dsw-*` token，而 256 色板与真彩色值按字面 rgb 透传。输出保持 `white-space: pre` 并支持横向滚动，因此按列对齐的输出保留其对齐而不会软换行；超过 `maxLines`（默认 16，与 TUI 转录相同的切分算法）时折叠为头部切片加尾部切片，由展开按钮控制。原理：[Web 终端卡片笔记](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md)。

## 模型体验

无。该包在浏览器中渲染纯 React 原子组件；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **字形级图标是重新绘制的近似版本**：鱼形标志（以及 ui-conversation 持有的闪光图标）来自字体字形，而本地设计数据无法导出其矢量几何；在获得精确导出路径前，使用手工重建版本代替。
- **Pill 与 Input 没有设计来源**：两个原子组件均自行定义；与其相似的侧边栏搜索字段和视图标签条由消费方组合，不是这些原子组件。
- **StateDot 的 `Active` 变体是设计中的隐藏占位符**：尚未实现；已交付的四种状态（done/warning/ongoing/error）构成完整的 P-I 表层。
- **本包面向用户的文案是内联中文，未做本地化**：这些原子组件是 zero-cordis 的，因此拿不到 `ctx.locale`；`TerminalBlock` 的退出码与信号胶囊、它的复制与展开控件，以及 `CodeBlock` 的复制控件全部硬编码。这与 locale 包记录的全仓现状一致（只有 Settings 表面做了翻译）；把它们抽取进 `zh`/`en` 字典需要为 zero-cordis 原子组件提供一条本地化通道，属于那次全仓抽取的范围。
- **`TerminalBlock` 不是终端模拟器**：它渲染已结束或仍在运行的命令输出，而不是交互式会话：SGR 颜色与属性会被遵循，而光标移动、清屏和备用屏幕序列会被剥离。基础 16 色中的洋红与青色没有对应 token，保持字面 rgb。
