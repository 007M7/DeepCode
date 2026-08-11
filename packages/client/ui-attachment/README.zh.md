# @deepseek-ai/dsh-client-ui-attachment

[English](README.md) | 中文

纯 React 附件原子组件（零 cordis）：输入框草稿图片栏（`AttachmentRail`）、聊天历史图片画廊（`MessageImage`/`ImageGallery`）与原图灯箱（`ImageLightbox`）。所有文案都由持有方插件在自己的语言命名空间中解析后经 label props 传入，此包不读取任何应用状态；当前消费者是 `@deepseek-ai/dsh-client-ui-conversation`，经其 `image-labels` 模块桥接 `conversation` 词典。

## 附件栏

`AttachmentRail` 将待发送草稿图片渲染为固定 64px（16px 圆角）的缩略图横排，滚动条始终隐藏，溢出改由两端的圆形箭头提示：每次翻页滚动一个视口宽度（减去一张卡片作为上下文，下限 200px）并平滑滚动，箭头的显隐在滚动、条目数量变化和窗口尺寸变化时依据滚动几何重算。纵向滚轮转为横向平移，单次行程钳制在 60px 内，触控板的横向平移保持原生滚动。新增条目会滚动到栏尾展示，删除则保持原位。每张缩略图单击经 `onOpen` 打开原图，删除按钮位于卡片内部右上角，悬停卡片或键盘聚焦时才显示；粗指针（触屏）设备没有悬停，因此常显。是否挂载由持有方决定，仅在有条目时渲染。

## 消息图片与灯箱

`MessageImage` 渲染一张持久化历史图片，长边收敛到 240px，经持有方的 `ImageLoader` 加载会话授权 URL；加载失败渲染显式重试按钮，加载完成后单击打开 `ImageLightbox`（加载中的点击被忽略）。`ImageGallery` 将一条消息的图片包为一个对齐的弹性分组（用户消息 `end`，助手消息 `start`），空列表不渲染。`ImageLightbox` 是文档级模态预览，按 Escape、按下遮罩或点关闭按钮均可关闭，卸载时将焦点还给打开者。

## Model Experience

None, as the package renders pure React atoms in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **仅支持图片** — 非图片文件尚无附件栏卡片与历史渲染；DeepSeek Chat 风格的文件卡片和上传进度状态等输入框接受非图片附件后再做。
- **灯箱无缩放与下载** — 预览仅以适配视口的尺寸渲染原图。
