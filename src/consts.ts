/**
 * 技术常量（与内容无关，写死在代码里）
 * ============================================================
 * 站名、签名、菜单、Banner、页脚这些「内容」已经搬到 config/site.json，
 * 由 src/site.config.ts 读取。本文件只保留改代码才该改的东西。
 * ============================================================
 */

/**
 * 站点后端地址（Cloudflare Worker）。
 * 登录、点赞、阅读数、统计页都走它，部署方式见 worker/README.md。
 * 结尾不要加斜杠。
 */
export const API_BASE = 'https://auth.melodyxz.top';

/**
 * 站长 GitHub 用户名（可写多个）。
 * 页面上的「✎ 写文章 / ⚙ 站点配置 / ✎ 编辑本篇」入口对访客隐藏；
 * 只要满足下面任意一条就会显示：
 *   ① 在本浏览器里用 GitHub 授权过写作权限（melodyxz-edit 存在）
 *   ② 用列表里的 GitHub 账号登录过本站（点赞登录）
 * 这只是"显示开关"，真正的权限始终在 GitHub 那边，伪造也进不去后台。
 * 注意：这个列表要和 worker/wrangler.toml 里的 OWNER_LOGINS 保持一致。
 */
export const ADMIN_OWNERS = ['FormerlyXZ'];

/**
 * 站点源码仓库（在线写作 / 站点配置 / 相册编辑要往这里提交）。
 * 与 Giscus 用的仓库是同一个；改了用户名或仓库名要同步这里。
 */
export const REPO = {
  owner: 'FormerlyXZ',
  name: 'MyBlog',
  /** 默认分支 */
  branch: 'main',
};

/**
 * 访问统计（Cloudflare Web Analytics，可选）
 *
 * 想在 Cloudflare 上看专业图表的话：
 *   1. 打开 https://dash.cloudflare.com →（左栏）Web Analytics → 添加站点
 *   2. 填 melodyxz.top，拿到一段带 token 的脚本，把 token 填到下面
 *   3. 保存后重新构建，访问几天后控制台里就能看到流量曲线、来源、国家
 *
 * 留空则什么脚本都不加载，网站不受影响。
 * 注意：这只是"图表"，页面上每篇文章的阅读数由自建统计接口负责，两者互不影响。
 */
export const ANALYTICS = {
  cloudflareToken: '',
};

/* ============================================================
   以下为「兼容层」：给尚未重写的老页面/老组件用
   P2–P6 逐页替换完成后，这一整段会随旧组件一起删除。
   新代码请直接从 src/site.config.ts 导入：
     SITE / USER / SITE_MENU / PAGE_TEXTS / GISCUS / FOOTER
   ============================================================ */

import {
  SITE as SITE_CFG,
  SITE_URL as SITE_URL_CFG,
  USER as USER_CFG,
  GISCUS as GISCUS_CFG,
  GISCUS_ENABLED,
} from './site.config';

export const SITE_URL = SITE_URL_CFG;

/** 旧接口：{ title, description, author, lang, nav, social, footerNote } */
export const SITE = {
  title: SITE_CFG.title,
  description: SITE_CFG.description,
  author: USER_CFG.name,
  lang: SITE_CFG.language,
  /** 旧顶部导航，新布局用 site.config 里的 menu */
  nav: [
    { text: '首页', href: '/' },
    { text: '文章', href: '/posts/' },
    { text: '标签', href: '/tags/' },
    { text: '搜索', href: '/search/' },
    { text: '关于', href: '/about/' },
  ],
  social: {
    github: USER_CFG.social.find((s) => s.icon.includes('github'))?.href ?? '',
    email: '',
  },
  footerNote: '用 Markdown 写作，用 Astro 构建。',
};

/** 旧接口：评论配置 */
export const GISCUS = GISCUS_CFG;

/** 旧接口：评论是否已配置完整 */
export const GISCUS_READY = GISCUS_ENABLED;
