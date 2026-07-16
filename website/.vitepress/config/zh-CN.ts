import type { DefaultTheme, LocaleSpecificConfig } from 'vitepress'
import apiSidebarData from './api-sidebar.json'

const guideSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '入门',
    items: [
      { text: '介绍', link: '/zh-CN/guide/' },
      { text: '快速开始', link: '/zh-CN/guide/quickstart' },
      { text: '配置文件', link: '/zh-CN/guide/config' },
    ],
  },
]

const developSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '基础',
    items: [
      { text: '第一个插件', link: '/zh-CN/develop/basic/' },
      { text: '开发一个 Tool', link: '/zh-CN/develop/basic/tool' },
      { text: '插件配置', link: '/zh-CN/develop/basic/config' },
    ],
  },
  {
    text: '框架能力',
    items: [
      { text: '插件与生命周期', link: '/zh-CN/develop/framework/' },
      { text: '服务与依赖', link: '/zh-CN/develop/framework/service' },
      { text: '事件系统', link: '/zh-CN/develop/framework/events' },
    ],
  },
  {
    text: '实战',
    items: [
      { text: '能力的三层拆分', link: '/zh-CN/develop/practice/' },
      { text: 'LLM 适配器', link: '/zh-CN/develop/practice/llm-adapter' },
    ],
  },
]

// The API section sidebar is GENERATED (scripts/gen-website-api.ts writes
// api-sidebar.json alongside the pages), so navigation can never drift from
// the generated page set. Only the hand-written hub link lives here.
const apiSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '框架 API',
    items: [
      { text: '总览', link: '/zh-CN/api/' },
      ...apiSidebarData.cordis,
    ],
  },
  {
    text: 'Harness API',
    items: apiSidebarData.harness,
  },
]

const designSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '系统设计',
    items: [
      { text: '概述', link: '/zh-CN/design/' },
      { text: '可组合性与插件系统', link: '/zh-CN/design/composability' },
      { text: '作用与余作用', link: '/zh-CN/design/effects-coeffects' },
      { text: '可逆作用', link: '/zh-CN/design/revertible-effects' },
      { text: '响应式余作用', link: '/zh-CN/design/reactive-coeffects' },
      { text: '上下文模型', link: '/zh-CN/design/context-model' },
    ],
  },
]

export const zhCN: LocaleSpecificConfig<DefaultTheme.Config> = {
  label: '简体中文',
  lang: 'zh-CN',
  themeConfig: {
    nav: [
      { text: '入门', link: '/zh-CN/guide/', activeMatch: '/zh-CN/guide/' },
      { text: '开发', link: '/zh-CN/develop/basic/', activeMatch: '/zh-CN/develop/' },
      { text: 'API', link: '/zh-CN/api/', activeMatch: '/zh-CN/api/' },
      { text: '设计', link: '/zh-CN/design/', activeMatch: '/zh-CN/design/' },
    ],
    sidebar: {
      '/zh-CN/guide/': guideSidebar,
      '/zh-CN/develop/': developSidebar,
      '/zh-CN/api/': apiSidebar,
      '/zh-CN/design/': designSidebar,
    },
    // level [2,3]: the generated API pages put each member at h3 (### ctx.foo)
    // under an h2 scope/statics group — both belong in the page outline.
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
  },
}
