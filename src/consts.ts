/**
 * 站点全局信息 —— 想改站名、作者、简介，改这里就够了。
 * 注意：域名统一在 astro.config.mjs 里配置，这里会自动读取。
 */

export const SITE_URL = import.meta.env.SITE ?? 'https://example.com';

export const SITE = {
  /** 站点标题（浏览器标签页、页头、RSS 里显示） */
  title: '我的博客',

  /** 一句话简介，会用在首页和 SEO 描述里 */
  description: '记录学习、生活与思考。',

  /** 作者署名 */
  author: '你的名字',

  /** 站点语言 */
  lang: 'zh-CN',

  /** 顶部导航 */
  nav: [
    { text: '首页', href: '/' },
    { text: '文章', href: '/posts/' },
    { text: '标签', href: '/tags/' },
    { text: '关于', href: '/about/' },
  ],

  /** 社交链接，留空则自动隐藏 */
  social: {
    github: '',
    email: '',
  },

  /** 页脚备注，可以留空 */
  footerNote: '用 Markdown 写作，用 Astro 构建。',
};
