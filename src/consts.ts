/**
 * 站点全局信息 —— 想改站名、作者、简介，改这里就够了。
 * 注意：域名统一在 astro.config.mjs 里配置（SITE_URL），这里自动读取，不用重复改。
 */

export const SITE_URL = import.meta.env.SITE ?? 'https://melodyxz.top';

/**
 * 站点后端地址（Cloudflare Worker）。
 * 登录、点赞、阅读数、统计页都走它，部署方式见 worker/README.md。
 * 结尾不要加斜杠。
 */
export const API_BASE = 'https://auth.melodyxz.top';

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
    { text: '搜索', href: '/search/' },
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

/**
 * 评论系统（Giscus，基于 GitHub Discussions）
 *
 * 怎么填这两个 ID：
 *   1. 在 GitHub 仓库 Settings → General → Features 里勾选 Discussions（开启讨论区）
 *   2. 访问 https://github.com/apps/giscus 安装 giscus App（只装到本仓库）
 *   3. 打开 https://giscus.app/zh-CN ，填仓库 FormerlyXZ/MyBlog，
 *      选择「Announcements」分类（或你在讨论区里自己建的分类），
 *      页面下方生成的代码里能看到 data-repo-id 和 data-category-id
 *   4. 把这两个值分别填到下面。填完评论才会出现。
 *
 * 没填完之前，文章页不会显示评论框，其它功能不受影响。
 */
export const GISCUS = {
  enabled: true,
  repo: 'FormerlyXZ/MyBlog',
  /** 形如 R_kgDOxxxxxx */
  repoId: 'R_kgDOVOWNnA',
  /** 讨论区分类名，建议 Announcements（默认就存在） */
  category: 'Announcements',
  /** 形如 DIC_kwDOxxxxxx */
  categoryId: 'DIC_kwDOVOWNnM4DI9dS',
  /** 每篇文章对应一条讨论：按网址（路径）匹配最稳 */
  mapping: 'pathname',
  /** 评论区放在正文下面（与 giscus.app 生成的一致） */
  inputPosition: 'bottom',
  /** 是否显示表情回应 */
  reactionsEnabled: true,
  lang: 'zh-CN',
};

/** Giscus 是否已经配置完整（两个 ID 都填了才启用） */
export const GISCUS_READY = Boolean(GISCUS.repoId && GISCUS.categoryId);

/**
 * 访问统计（Cloudflare Web Analytics，可选）
 *
 * 想在 Cloudflare 上看专业图表的话：
 *   1. 打开 https://dash.cloudflare.com →（左栏）Web Analytics → 添加站点
 *   2. 填 melodyxz.top，拿到一段带 token 的脚本，把 token（长串字母数字）填到下面
 *   3. 保存后重新部署，访问几天后控制台里就能看到流量曲线、来源、国家
 *
 * 留空则什么脚本都不加载，网站不受影响。
 * 注意：这只是"图表"，页面上每篇文章的阅读数由自建统计页负责，两者互不影响。
 */
export const ANALYTICS = {
  cloudflareToken: '',
};
