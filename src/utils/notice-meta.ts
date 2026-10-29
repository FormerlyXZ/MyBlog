/**
 * 站点公告 / 更新日志的「元数据」：类型、常量、纯函数
 * ============================================================
 * 这里**不读** config/notices.json —— 页面（.astro）和浏览器脚本都能引用，
 * 客户端不会因为 import 这个小模块就把整份公告数据打进来
 * （真正的数据读取在 utils/notices.ts 里，只在构建时用）。
 *
 * 一条公告 / 一条更新日志长这样：
 *
 *   {
 *     "id": "n9c4k2xa",           // 8 位随机 id，编辑 / 删除时靠它定位
 *     "time": "2026-10-29 21:10", // 本地时间，写 YYYY-MM-DD HH:mm 或 YYYY-MM-DD
 *     "title": "一句话标题",
 *     "content": "正文（\n 换行）",   // 可选
 *     "items": ["要点一", "要点二"],  // 可选，显示成小圆点列表
 *     "level": "info",             // 可选：公告的样式（info / success / warning）
 *     "version": "v1.1.0",         // 可选：更新日志的版本号
 *     "pinned": true,              // 可选：置顶
 *     "link": { "text": "去看看", "href": "/moments/" } // 可选：底部那个链接
 *   }
 *
 * 两个列表都允许为空；为空时弹窗显示一句提示，站长可以点「新建」写第一条。
 * ============================================================
 */

/** 两个列表：站点公告 / 更新日志 */
export type NoticeKind = 'announcements' | 'changelog';

/** 公告的样式（只影响标题旁那个小角标的颜色） */
export type NoticeLevel = 'info' | 'success' | 'warning';

export interface NoticeLink {
  /** 链接文字，留空时显示「查看详情」 */
  text: string;
  /** 站内路径（/posts/xxx/）或 https 链接 */
  href: string;
}

export interface NoticeItem {
  id: string;
  /** 本地时间：YYYY-MM-DD HH:mm（只写日期也可以） */
  time: string;
  title: string;
  /** 正文，\n 换行；显示时保留换行 */
  content?: string;
  /** 要点列表，每个元素一行 */
  items?: string[];
  level?: NoticeLevel;
  version?: string;
  pinned?: boolean;
  link?: NoticeLink;
}

export interface NoticeBook {
  announcements: NoticeItem[];
  changelog: NoticeItem[];
}

/** 弹窗里每个列表最多渲染多少条（数据本身不删，只是不一次全铺出来） */
export const NOTICE_LIST_LIMIT = 20;

/** 胶囊里最多轮播几条标题 */
export const NOTICE_TICKER_LIMIT = 5;

/** 两个列表的显示信息（顺序就是弹窗里标签页的顺序） */
export const NOTICE_KINDS: ReadonlyArray<{
  key: NoticeKind;
  /** 标签页 / 标题上的全称 */
  label: string;
  /** 按钮上的简称：「新建公告」「新建日志」 */
  short: string;
  icon: string;
  /** 列表为空时的提示 */
  empty: string;
}> = [
  {
    key: 'announcements',
    label: '站点公告',
    short: '公告',
    icon: 'material-symbols:notifications-active-rounded',
    empty: '还没有站点公告',
  },
  {
    key: 'changelog',
    label: '更新日志',
    short: '日志',
    icon: 'material-symbols:rocket-launch-rounded',
    empty: '还没有更新日志',
  },
];

/** 公告样式下拉框的选项（顺序就是编辑表单里的顺序） */
export const NOTICE_LEVELS: ReadonlyArray<{ value: NoticeLevel; label: string }> = [
  { value: 'info', label: '普通' },
  { value: 'success', label: '喜报' },
  { value: 'warning', label: '重要' },
];

/* ---------------------------------------------------------------------------
   判断 / 取词的纯函数
   --------------------------------------------------------------------------- */

export function isNoticeKind(value: unknown): value is NoticeKind {
  return value === 'announcements' || value === 'changelog';
}

export function isNoticeLevel(value: unknown): value is NoticeLevel {
  return value === 'info' || value === 'success' || value === 'warning';
}

/** 'changelog' → '更新日志' */
export function noticeKindLabel(kind: NoticeKind): string {
  return NOTICE_KINDS.find((item) => item.key === kind)?.label ?? '站点公告';
}

/** 'changelog' → '日志'（按钮上用的简称） */
export function noticeKindShort(kind: NoticeKind): string {
  return NOTICE_KINDS.find((item) => item.key === kind)?.short ?? '公告';
}

/** 'warning' → '重要' */
export function noticeLevelLabel(level: NoticeLevel | undefined): string {
  if (!level) return '';
  return NOTICE_LEVELS.find((item) => item.value === level)?.label ?? '';
}

/* ---------------------------------------------------------------------------
   时间：解析 / 排序 / 显示
   --------------------------------------------------------------------------- */

/**
 * 解析 "2026-10-29 21:10"（也容忍 "2026-10-29"、"2026/10/29" 和 ISO 写法）；
 * 解析不了返回 null。
 *
 * 注意不要直接 new Date('2026-10-29 21:10')：带空格那种写法在部分浏览器里
 * 会被当成非法格式（Safari 直接 Invalid Date），所以手动拼。
 */
export function parseNoticeTime(value: string | undefined): Date | null {
  if (!value) return null;
  const match = String(value)
    .trim()
    .match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** 排序 / 未读判断用的时间戳（解析失败当作 0，沉到最下面） */
export function noticeTimestamp(value: string | undefined): number {
  return parseNoticeTime(value)?.getTime() ?? 0;
}

/** <time datetime="..."> 用的机器可读时间 */
export function noticeIso(value: string | undefined): string {
  return parseNoticeTime(value)?.toISOString() ?? '';
}

/**
 * 显示用时间：今年只写「10月29日 21:10」，跨年补上年份；
 * 原文只写了日期（没有时分）的就只显示日期。
 */
export function noticeDateLabel(value: string | undefined, now: Date = new Date()): string {
  const date = parseNoticeTime(value);
  if (!date) return value ?? '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hasClock = /\d{1,2}:\d{2}/.test(String(value));
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  const label = date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}年${day}`;
  return hasClock ? `${label} ${pad(date.getHours())}:${pad(date.getMinutes())}` : label;
}

/**
 * 排好的顺序：置顶优先，其余按时间从新到旧（时间相同按 id，保证稳定）。
 * 编辑表单里写回文件时也用它 —— 文件顺序始终规整。
 */
export function sortNotices(list: NoticeItem[]): NoticeItem[] {
  return [...list].sort((a, b) => {
    const pinA = a.pinned ? 1 : 0;
    const pinB = b.pinned ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    const diff = noticeTimestamp(b.time) - noticeTimestamp(a.time);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** 最新一条的时间戳（没有任何条目时返回 0） */
export function newestNoticeTimestamp(list: NoticeItem[]): number {
  let newest = 0;
  for (const item of list) newest = Math.max(newest, noticeTimestamp(item.time));
  return newest;
}

/* ---------------------------------------------------------------------------
   胶囊 / 列表里显示的那一行字
   --------------------------------------------------------------------------- */

/** 胶囊滚动的那句话：有标题用标题，没标题就取正文第一行 */
export function noticeHeadline(item: NoticeItem, max = 90): string {
  const title = String(item.title ?? '').trim();
  const source = title || String(item.content ?? '').split('\n')[0].trim();
  const text = source || '站点公告';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ---------------------------------------------------------------------------
   链接白名单：站内路径（/xxx/）或 http(s) 外链，其余一律不渲染成链接
   --------------------------------------------------------------------------- */

export function isSafeNoticeHref(href: string | undefined): boolean {
  if (!href) return false;
  const value = String(href).trim();
  if (!value) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  return /^https?:\/\//i.test(value);
}

/* ---------------------------------------------------------------------------
   把 JSON（仓库文件 / 内联数据）规整成 NoticeBook
   --------------------------------------------------------------------------- */

function normalizeList(value: unknown): NoticeItem[] {
  if (!Array.isArray(value)) return [];
  const items: NoticeItem[] = [];

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const raw = entry as Partial<NoticeItem>;

    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : '';
    const title = rawTitle || content.split('\n')[0].slice(0, 60);
    if (!title && !content) return;

    const points = Array.isArray(raw.items)
      ? raw.items.map((point) => (typeof point === 'string' ? point.trim() : '')).filter(Boolean)
      : [];

    const link = raw.link && typeof raw.link === 'object' ? raw.link : null;
    const href = link && typeof link.href === 'string' ? link.href.trim() : '';
    const linkText = link && typeof link.text === 'string' ? link.text.trim() : '';

    items.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `auto-${index}-${items.length}`,
      time: typeof raw.time === 'string' ? raw.time.trim() : '',
      title,
      content: content || undefined,
      items: points.length ? points : undefined,
      level: isNoticeLevel(raw.level) ? raw.level : undefined,
      version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : undefined,
      // 只有 true 才写进文件：省得每条都挂一个 "pinned": false
      pinned: raw.pinned === true ? true : undefined,
      link: isSafeNoticeHref(href) ? { text: linkText || '查看详情', href } : undefined,
    });
  });

  return items;
}

/** 仓库里的 JSON → 规整好的两个列表（缺字段、写错类型都不会炸） */
export function normalizeNoticeBook(raw: unknown): NoticeBook {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    announcements: normalizeList(source.announcements),
    changelog: normalizeList(source.changelog),
  };
}
