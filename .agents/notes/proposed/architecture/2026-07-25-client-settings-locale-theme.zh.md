# Agent Note: Client Settings、Locale 与 Theme 分层

Status: proposed

[English](2026-07-25-client-settings-locale-theme.md) | 中文

## Problem

浏览器端已有的 Settings 直接写在 Sidebar 内，语言和主题也由组件本地状态直接改 DOM。这使 Settings 无法由独立插件扩展，偏好状态没有稳定的跨插件服务契约，主题 registry 同时承担状态与呈现职责。

## Proposal

Sidebar 声明 `sidebar.settings` 单坑位，`ui-settings` 占用它并声明 `settings.section` list 坑位。每个 section 由独立插件贡献；Settings 壳只从 slot ledger 读取 entry metadata 生成导航，通过 `only` 渲染当前 section。

Settings 入口是 sidebar Foot 的 Settings 行，点击直接打开 1080×700 居中浮层（黑 24% 遮罩）；close 按钮、点击遮罩、ESC 均关闭。无任何中间菜单形态。

`@deepseek-ai/dsh-client-locale` 提供 `ctx.locale`，`ui-theme` 提供 `ctx.theme`。两个 service 都以 getter 读取、setter 写入并用 typed Cordis change event 发布 immutable snapshot；service 自己持久化偏好（只存 id，坏值回退默认）。

General 的 apply 层订阅 `locale/change` 和 `theme/change`，把 snapshot 投影到该 section 声明的 Zustand store。React 组件只读 `useStore`、写注入的 setter callback，不读取 ctx 或 service。

Theme 偏好三态：`light`、`dark`、`system`，默认 `system`（无持久化偏好或坏值时）。system 的解析属主题领域：ThemeService 持有 `prefers-color-scheme` matchMedia 监听（环境感知，非 DOM 呈现），偏好为 system 且系统配色变化时重发 snapshot；snapshot 同时携带 `preference` 与解析后的 `active` 定义。

Theme service 不操作 DOM。`ui-layout` 初始读取 Theme getter，随后订阅 `theme/change`，由 Layout 持有的 presenter 按 `active` 更新 `body[data-ds-dark-theme]` 和主题 token；presenter 不感知 system，只消费已解析结果。

### 首期 section 范围

| section | 插件 | 首期内容 |
|---|---|---|
| General | `ui-settings-general` | Language（Selector 下拉）与 Appearance（Light/Dark/System 三 cube）真实可切；Permission、Tool Call 仅视觉骨架，无写操作 |
| Models | `ui-settings-models` | 仅导航项，内容区为空 |
| Plugin | 不建包 | 首期不做，导航不出现该项（无目标的外链入口不上屏；后续插件注册 section 即自动出现） |

首期只翻译 Settings 浮层内文案（General 各行 + 导航）；其他页面文案不动。

### Slot topology

```text
root
└─ sidebar
   └─ sidebar.settings                 single/root
      └─ ui-settings
         └─ settings.section           list/root
            ├─ general                 ui-settings-general
            └─ models                  ui-settings-models
```

section contribution 使用 declaration-aware deferral，不依赖 client manifest 的 apply 顺序。

### Service contracts

```ts
type ThemePreference = 'light' | 'dark' | 'system'

interface ThemeDefinition {
  id: string
  colorScheme: 'light' | 'dark'
  tokens: Record<string, string>
}

interface ThemeSnapshot {
  preference: ThemePreference
  active: ThemeDefinition            // system 已解析为具体 light/dark 定义
  themes: readonly ThemeDefinition[]
  revision: number
}

interface LocaleDefinition {
  id: 'zh' | 'en'
  label: string
}

interface LocaleSnapshot {
  active: 'zh' | 'en'
  locales: readonly LocaleDefinition[]
  revision: number
}

interface Events {
  /** @param snapshot - Current locale registry snapshot. @mode emit */
  'locale/change'(snapshot: LocaleSnapshot): void
  /** @param snapshot - Current theme registry snapshot. @mode emit */
  'theme/change'(snapshot: ThemeSnapshot): void
}
```

Locale 内置中文和 English；`setLocale`/`setTheme` 是唯一写入口，未知 id 失败。

## Alternatives considered

**由 app shell 统一订阅偏好并重渲染 root slot tree。** 语言和主题变化只需要更新实际消费者；全树刷新放大影响面，也把业务偏好接入 shell。

**Theme service 直接修改 DOM。** registry service 因此依赖呈现环境，生命周期与全局样式所有权不清；Layout 已经拥有页面根呈现边界。

**system 由 Layout presenter 解析。** presenter 需自带 matchMedia 订阅并在 themes 列表里挑选具体定义，呈现层被迫理解偏好语义；解析放服务侧则所有消费者拿到一致的已解析 snapshot。

**Settings import 并枚举各 section。** 新增页面必须修改壳插件，破坏「每个功能由自己的插件占坑」的组合模型。

**把 Locale/Theme snapshot 直接注入 React。** inject 结果按 entry identity 缓存，易变值会陈旧；为每个 service 自造 React hook 也绕开 slot store 的统一绑定。

## Acceptance criteria

- Settings 壳只依赖 slot ledger，不依赖任一 section 实现。
- Locale 与 Theme 的写入只走 setter，持续同步只走 change event。
- General store 初始化走 getter，后续由两个 event 更新并局部重渲染。
- Layout 独立应用 Theme snapshot，Theme service 不访问 DOM；presenter 不出现 system 分支。
- 中文/English 与 Light/Dark/System 能切换并刷新后恢复；偏好为 system 时系统配色变化即时生效。
- Models 只有导航项与空内容区；Permission、Tool Call 骨架无写操作。
- 浮层经 close 按钮、遮罩点击、ESC 均可关闭。

## Risks

slot 声明与 contribution 的 apply 顺序不固定，所有新 section 必须保留 declaration-aware registration 和幂等防护。service event 可能早于 section 首次渲染，General store 的 init 与 controller attach 都必须从 getter 对齐当前 snapshot。Layout 卸载时必须清理自己设置的全局属性，ThemeService dispose 时必须移除 matchMedia 监听，避免 HMR 后残留。
