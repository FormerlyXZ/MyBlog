/**
 * 站点全局信息 —— 想改站名、作者、简介，改这里就够了。
 * 注意：域名统一在 astro.config.mjs 里配置（SITE_URL），这里自动读取，不用重复改。
 */

export const SITE_URL = import.meta.env.SITE ?? 'https://melodyxz.top';

export const SITE = {
  /** 站点标题（浏览器标签页、页头、RSS 里显示） */
  title: 'MelodyZzX的Blog',

  /** 一句话简介，会用在首页和 SEO 描述里 */
  description: '记录技术、生活与思考的个人空间。',

  /** 作者署名 */
  author: 'FormerlyXZ',

  /** 站点语言 */
  lang: 'zh-CN',

  /** 顶部导航 */
  nav: [
    { text: '首页', href: '/' },
    { text: '文章', href: '/posts/' },
    { text: '标签', href: '/tags/' },
    { text: '关于', href: '/about/' },
  ],

  /** 社交链接，留空则自动隐藏（邮箱建议别直接写，容易被爬虫收集） */
  social: {
    github: 'https://github.com/FormerlyXZ',
    email: '',
  },

  /** 页脚备注，可以留空 */
  footerNote: '用 Markdown 写作，用 Astro 构建。',
};
