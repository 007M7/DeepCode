import { defineConfig } from 'vitepress'
import { zhCN } from './zh-CN'

export default defineConfig({
  title: 'DeepSeek Harness',
  description: '插件化 Agent 开发框架',

  locales: {
    'zh-CN': zhCN,
  },

  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/deepseek-harness/deepseek-harness' },
    ],
  },
})
