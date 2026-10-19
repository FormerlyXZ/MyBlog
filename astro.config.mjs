// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';

// ============================================================
//  【唯一需要改的地方】把下面换成你自己的域名
//  格式必须带 https:// 并且结尾不要加斜杠
//  例：'https://blog.example.com'  或  'https://example.com'
//  本地开发时可以先不改，上线前务必改掉，否则 RSS / sitemap 会出错
// ============================================================
const SITE_URL = 'https://melodyxz.top';

export default defineConfig({
  site: SITE_URL,

  // 生成 /posts/hello/ 这样的目录式 URL（对 CDN 和 SEO 都友好）
  trailingSlash: 'always',
  build: { format: 'directory' },

  integrations: [
    sitemap(),
    // 图标：写 <Icon name="ri:github-line" /> 即可，图标数据在本地 npm 包里，
    // 构建时不联网，只会把真正用到的那几个图标打进产物。
    icon(),
  ],

  markdown: {
    // 代码高亮：一套浅色 + 一套深色，自动跟随主题切换
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      wrap: true,
    },
  },
});
