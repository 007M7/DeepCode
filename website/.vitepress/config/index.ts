import { defineConfig } from 'vitepress'
import { zhCN } from './zh-CN'

export default defineConfig({
  title: 'DeepSeek Harness',
  description: '插件化 Agent 开发框架',

  // The design essays (design/revertible-effects, design/context-model) carry
  // real TeX; math: true wires markdown-it-mathjax3 into the pipeline.
  // markdown-it-mathjax3 is pinned to ^4 (NOT 5.x): v5 injects a <style> tag
  // per formula, which Vue's template compiler rejects ("Tags with side
  // effect … are ignored in client component templates"); v4 emits pure SVG.
  markdown: { math: true },

  locales: {
    'zh-CN': zhCN,
  },

  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/deepseek-harness/deepseek-harness' },
    ],
  },
})
