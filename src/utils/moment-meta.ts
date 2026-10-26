/**
 * 动态的「元数据」：常量、类型、纯函数
 * ============================================================
 * 这里**不读** config/moments.json —— 页面（.astro）和浏览器脚本都能引用，
 * 客户端不会因为 import 这个小模块就把整份动态数据打进来
 * （真正的数据读取在 utils/moments.ts 里，只在构建时用）。
 *
 * 一条动态长这样：
 *
 *   {
 *     "id": "k3n8xq2a",            // 8 位随机 id，也是锚点与点赞计数的 key
 *     "time": "2026-10-26 12:40",  // 本地时间，按 YYYY-MM-DD HH:mm 写
 *     "text": "正文（\n 换行）",
 *     "images": [{ "src": "/images/moments/xxx.jpg", "w": 1600, "h": 1200 }],
 *     "files":  [{ "src": "/files/moments/xxx.zip", "name": "素材.zip", "size": 1024 }],
 *     "location": "杭州 · 西湖",    // 可选
 *     "mood": "🌿",                 // 可选，取下面 MOODS 里的一个 emoji
 *     "tags": ["生活"],             // 可选
 *     "pinned": true                // 可选，置顶
 *   }
 * ============================================================
 */

/** 一条动态最多几张图（九宫格） */
export const MOMENT_MAX_IMAGES = 9;
/** 一条动态最多几个附件 */
export const MOMENT_MAX_FILES = 3;

export interface MomentImage {
  /** 站内路径（/images/moments/xxx.jpg）或外链 URL */
  src: string;
  /** 原图宽高（只管单图版式，避免图片加载时页面抖一下） */
  w?: number;
  h?: number;
}

export interface MomentFile {
  src: string;
  /** 下载时显示的文件名 */
  name: string;
  /** 字节数，显示成 1.2 MB 那种 */
  size?: number;
}

export interface Moment {
  id: string;
  /** 本地时间：YYYY-MM-DD HH:mm */
  time: string;
  text?: string;
  images?: MomentImage[];
  files?: MomentFile[];
  /** 地点，如「杭州 · 西湖」 */
  location?: string;
  /** 心情，取 MOODS 里的一个 emoji */
  mood?: string;
  tags?: string[];
  /** 置顶：排在动态流最上面 */
  pinned?: boolean;
}

/**
 * 心情 = 一个 emoji + 一句中文说法。
 * 卡片上点 emoji 会从侧面弹出这句说法；发布弹窗里鼠标悬停也能看到。
 * 顺序就是发布弹窗里的显示顺序。
 */
export const MOODS: Array<{ emoji: string; label: string }> = [
  { emoji: '😀', label: '开心' },
  { emoji: '😊', label: '微笑' },
  { emoji: '😍', label: '喜欢' },
  { emoji: '😎', label: '很酷' },
  { emoji: '🥳', label: '庆祝' },
  { emoji: '🤔', label: '思考' },
  { emoji: '😴', label: '困了' },
  { emoji: '💤', label: '想睡' },
  { emoji: '😭', label: '难过' },
  { emoji: '😤', label: '生气' },
  { emoji: '😅', label: '尴尬' },
  { emoji: '🥲', label: '哭笑不得' },
  { emoji: '😇', label: '乖巧' },
  { emoji: '🌿', label: '平静' },
  { emoji: '🌸', label: '心动' },
  { emoji: '✨', label: '期待' },
  { emoji: '☕️', label: '提神' },
  { emoji: '🍚', label: '吃饱了' },
  { emoji: '🌇', label: '傍晚' },
  { emoji: '🎮', label: '打游戏' },
  { emoji: '📚', label: '学习' },
  { emoji: '🎧', label: '听歌' },
];

/** emoji → 中文说法；不在表里的（手写 JSON 塞了别的）返回空串 */
export function moodLabel(emoji: string | undefined): string {
  if (!emoji) return '';
  return MOODS.find((item) => item.emoji === emoji)?.label ?? '';
}

/** 解析 "2026-10-26 12:40"（也容忍 ISO 写法）；解析不了返回 null */
export function parseMomentTime(value: string | undefined): Date | null {
  if (!value) return null;
  const match = value
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
    // 手动按本地时间构造：不要用 new Date('2026-10-26 12:40')，
    // 那种带空格的写法在部分浏览器 / 运行时里会被当成非法格式（Safari 直接 Invalid Date）
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** 排序用的时间戳（解析失败当作 0，沉到最下面） */
export function momentTimestamp(time: string): number {
  return parseMomentTime(time)?.getTime() ?? 0;
}

/** 卡片锚点（分享链接末尾那段），也是点赞 / 阅读计数的路径 */
export function momentAnchor(id: string): string {
  return `m-${id}`;
}

/** 点赞 / 阅读计数用的路径：/moments/#m-xxx（和分享链接保持一致） */
export function momentPath(id: string): string {
  return `/moments/#${momentAnchor(id)}`;
}

/** 站内直达链接（分享按钮复制的就是它） */
export function momentUrl(id: string): string {
  return momentPath(id);
}

/**
 * 服务端渲染的绝对时间：今年只写「10月24日 09:02」，跨年补上年份。
 * 浏览器里 moments.ts 会把它升级成「3 小时前 / 昨天 21:10」这种相对时间，
 * 没有 JS 的访客看到的是这个绝对时间 —— 两种都说得通。
 */
export function momentDateLabel(time: string, now: Date = new Date()): string {
  const date = parseMomentTime(time);
  if (!date) return time;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${clock}`
    : `${date.getFullYear()}年${day} ${clock}`;
}

/** <time datetime="..."> 用的机器可读时间 */
export function momentIso(time: string): string {
  return parseMomentTime(time)?.toISOString() ?? '';
}

/**
 * 图片版式：列数 / 实际渲染几张 / 被灰幕盖住的「+N」/ 首图占几行 / 末尾几张拉宽。
 *
 * 排法（对齐朋友圈、微博那种九宫格）：
 *   1 张      单图，按原图比例（--ratio），宽度和高度都收着
 *   2 张      两列并排（每张 1.5 格大小）
 *   3 张      一行三列
 *   4 张      2×2
 *   5 张      首图放大一倍（马赛克）：首图占 2×2 格，其余 4 张小格排在右边，
 *             整块 4 列 × 2 行，正好填满不留空缺
 *   6 张      两行三列（本来就能填满，不放大）
 *   7 张      首图 2×2 + 右侧 4 小格（同 5 张的上半块），
 *             最后一行的 2 张各占 2 列（2×1 宽图），正好把整行铺满
 *   8 张      前两行各 3 张，最后一行 1 张小图 + 1 张 2×1 宽图，正好铺满第 3 行
 *   9 张      3×3 九宫格
 *   >9 张     只画 9 格，第 9 格盖灰幕显示剩余张数
 */
export function mediaLayout(count: number): {
  cols: number;
  shown: number;
  more: number;
  /** 首图占几行（0 = 不放大）；配合 CSS 的 span 2 列用 */
  heroRows: number;
  /** 末尾几张各自拉宽成 2×1，用来铺满最后一行（0 = 不拉宽） */
  tail: number;
} {
  if (count <= 0) return { cols: 0, shown: 0, more: 0, heroRows: 0, tail: 0 };
  if (count === 1) return { cols: 1, shown: 1, more: 0, heroRows: 0, tail: 0 };
  if (count === 2 || count === 4) {
    return { cols: 2, shown: count, more: 0, heroRows: 0, tail: 0 };
  }
  // 5 张：首图 2×2 + 4 张小图 = 4 列 2 行
  if (count === 5) return { cols: 4, shown: 5, more: 0, heroRows: 2, tail: 0 };
  // 7 张：首图 2×2 + 4 张小图（上半块 2 行）+ 最后 2 张拉成 2×1 铺满第 3 行
  if (count === 7) return { cols: 4, shown: 7, more: 0, heroRows: 2, tail: 2 };
  // 8 张：前两行 3 + 3，最后一行 1 张小图 + 1 张 2×1 宽图，正好铺满第 3 行
  if (count === 8) return { cols: 3, shown: 8, more: 0, heroRows: 0, tail: 1 };
  const shown = Math.min(count, MOMENT_MAX_IMAGES);
  return { cols: 3, shown, more: count - shown, heroRows: 0, tail: 0 };
}

/** 文件大小：1234 → 1.2 KB */
export function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
