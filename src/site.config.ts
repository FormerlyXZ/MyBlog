/**
 * 站点内容配置中心
 * ============================================================
 * 想改站名、签名、菜单、Banner、页脚、评论……都改 config/site.json，
 * 不需要碰任何 .astro 文件。
 *
 * 这个文件负责：
 *   ① 把 config/site.json 读进来
 *   ② 和内置默认值做深合并（JSON 里少写字段也不会让构建炸掉）
 *   ③ 导出带类型的常量给页面用
 *
 * 注意：config/*.json 是「构建输入」，改完要重启 dev 或重新 build 才生效。
 * ============================================================
 */

import siteJson from '../config/site.json';

/* ---------------- 类型定义 ---------------- */

export interface SocialLink {
  label: string;
  href: string;
  /** iconify 名，例如 ri:github-line、material-symbols:mail-outline */
  icon: string;
}

export interface MenuItem {
  id: string;
  text: string;
  href: string;
  icon: string;
}

export interface PageText {
  title: string;
  subtitle?: string;
  /** 首页 Banner 打字机轮播的句子 */
  typewriter?: string[];
}

export interface BannerConfig {
  images: string[];
  /** 轮播间隔（毫秒） */
  interval: number;
  /** 桌面高度，例如 70vh */
  height: string;
  /** 黑色遮罩不透明度 0–1 */
  overlay: number;
}

export type BannerMode = 'default' | 'fullscreen' | 'hidden' | 'background';

export interface ThemeConfig {
  light: string;
  dark: string;
  allowSelector: boolean;
  bannerMode: BannerMode;
}

export interface SiteConfig {
  title: string;
  tab: string;
  description: string;
  language: string;
  titleType: 'text' | 'image';
  titleImage: string;
  favicon: string;
  dateFormat: string;
  banner: BannerConfig;
  theme: ThemeConfig;
}

export interface UserConfig {
  name: string;
  description: string;
  avatar: string;
  site: string;
  social: SocialLink[];
}

export interface GiscusConfig {
  repo: string;
  repoId: string;
  category: string;
  categoryId: string;
  mapping: string;
  inputPosition: 'top' | 'bottom';
  reactionsEnabled: boolean;
  lang: string;
}

export interface FooterConfig {
  social: SocialLink[];
  poweredBy: string;
  copyright: string;
  /** 备案号，留空则不显示这一行 */
  icp: string;
  icpLink: string;
}

export interface FullConfig {
  site: SiteConfig;
  user: UserConfig;
  menu: MenuItem[];
  pages: Record<string, PageText>;
  blog: { pageSize: number };
  comments: { provider: string; giscus: GiscusConfig };
  footer: FooterConfig;
}

/* ---------------- 默认值（JSON 缺字段时兜底） ---------------- */

const DEFAULTS: FullConfig = {
  site: {
    title: "MelodyZzX's Blog",
    tab: "MelodyZzX's Blog",
    description: '记录技术、生活与思考的个人空间。',
    language: 'zh-CN',
    titleType: 'text',
    titleImage: '/logo.png',
    favicon: '/favicon.svg',
    dateFormat: 'YYYY年MM月DD日',
    banner: {
      images: ['/banner/1.svg'],
      interval: 8000,
      height: '70vh',
      overlay: 0.4,
    },
    theme: {
      light: 'garden',
      dark: 'dracula',
      allowSelector: true,
      bannerMode: 'default',
    },
  },
  user: {
    name: 'FormerlyXZ',
    description: '',
    avatar: '/profile.svg',
    site: 'https://melodyxz.top',
    social: [],
  },
  menu: [],
  pages: {},
  blog: { pageSize: 8 },
  comments: {
    provider: 'giscus',
    giscus: {
      repo: '',
      repoId: '',
      category: 'Announcements',
      categoryId: '',
      mapping: 'pathname',
      inputPosition: 'bottom',
      reactionsEnabled: true,
      lang: 'zh-CN',
    },
  },
  footer: {
    social: [],
    poweredBy: '基于 Astro 构建 · 设计参考 RyuChan',
    copyright: '',
    icp: '',
    icpLink: 'https://beian.miit.gov.cn/',
  },
};

/** 深合并：对象逐层递归，数组整体覆盖（不做元素级合并） */
function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch as T;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch as T;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? mergeDeep(out[key], value) : value;
  }
  return out as T;
}

/* ---------------- 合并并导出 ---------------- */

export const SITE_CONFIG: FullConfig = mergeDeep(DEFAULTS, siteJson);

/** 站点域名（astro.config.mjs 里配置，这里自动读取） */
export const SITE_URL: string = import.meta.env.SITE ?? SITE_CONFIG.user.site;

/** 站点主体信息 */
export const SITE = SITE_CONFIG.site;

/** 站长信息（个人卡：头像、签名、社交） */
export const USER = SITE_CONFIG.user;

/** 顶部菜单（D19：文章 / 导航 / 相册 / 项目） */
export const SITE_MENU = SITE_CONFIG.menu;

/** 各页面的 Banner 标题/副标题，按页面 id 取 */
export const PAGE_TEXTS = SITE_CONFIG.pages;

/** 首页每页文章数 */
export const BLOG_PAGE_SIZE = SITE_CONFIG.blog.pageSize;

/** 评论（Giscus）配置 */
export const GISCUS = SITE_CONFIG.comments.giscus;

/** Giscus 是否配置完整（两个 ID 都填了才启用），没填就给个假的让评论框隐藏 */
export const GISCUS_ENABLED =
  SITE_CONFIG.comments.provider === 'giscus' && Boolean(GISCUS.repoId && GISCUS.categoryId);

/** 页脚配置 */
export const FOOTER = SITE_CONFIG.footer;

/** Banner 配置 */
export const BANNER = SITE.banner;

/** 主题配置 */
export const THEME = SITE.theme;

/** 取某页面的 Banner 文案，取不到就回落到站点标题 */
export function pageText(id: string): PageText {
  return PAGE_TEXTS[id] ?? { title: SITE.title, subtitle: SITE.description };
}
