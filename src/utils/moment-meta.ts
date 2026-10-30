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
 *     "layout": "free",            // 可选，写了就是「手动排版」：图片各带 cell
 *     "location": "杭州 · 西湖",    // 可选
 *     "mood": "🌿",                 // 可选，取下面 MOODS 里的一个 emoji
 *     "tags": ["生活"],             // 可选
 *     "pinned": true                // 可选，置顶
 *   }
 *
 * 「手动排版」的图片多一个 cell：[x, y, w, h]，单位是格，
 * 坐标系是 4×4 的画布（左上角 0,0）。比如 [0, 0, 2, 2] = 左上角占 2×2 格。
 * 上传时在编辑板上拖出来的位置就存成这个。
 * ============================================================
 */

/** 一条动态最多几张图（自动版式九宫格；手动排版画布 4×4 = 16 格） */
export const MOMENT_MAX_IMAGES = 16;
/** 一条动态最多几个附件 */
export const MOMENT_MAX_FILES = 3;

/** 手动排版画布的列数 / 行数（固定 4×4） */
export const FREE_COLS = 4;
export const FREE_ROWS = 4;
/** 少于这么多张就不给「手动排版」入口（一两张图摆 4×4 没意义） */
export const FREE_MIN_IMAGES = 4;
/** 自动版式最多显示几格（3×3 九宫格），多出来的盖灰幕显示 +N */
export const AUTO_GRID_MAX = 9;

/** 画布坐标：[x, y, w, h]，x/y 是左上角，w/h 是占几格 */
export type MomentCell = [number, number, number, number];

export interface MomentImage {
  /** 站内路径（/images/moments/xxx.jpg）或外链 URL */
  src: string;
  /** 原图宽高（只管单图版式，避免图片加载时页面抖一下） */
  w?: number;
  h?: number;
  /** 手动排版时这张图在 4×4 画布上占的格子；没排进画布就不写 */
  cell?: number[];
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
  /** 'free' = 手动排版（按每张图的 cell 排）；不写 = 按张数自动排 */
  layout?: 'free';
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
 *   >9 张     只画 9 格（3×3），第 9 格盖灰幕显示剩余张数（最多 16 张）
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
  const shown = Math.min(count, AUTO_GRID_MAX);
  return { cols: 3, shown, more: count - shown, heroRows: 0, tail: 0 };
}

/* ============================================================
   手动排版（4×4 画布）
   ============================================================
   · 编辑时画布永远是 4×4，用户随便拖；
   · 发布后卡片只渲染「实际占用到的那块矩形」（freeBoardBox），
     空着的行 / 列会被裁掉，不会留一片空白；
   · 格子是正方形，所以「比例」是网格的副产品：
     占 2×1 格就是 2:1，占 3×2 格就是 3:2，卡片缩放时比例不变，
     不需要存任何像素值。
   ============================================================ */

/** 把 JSON 里读到的 cell 收拾成合法值（钳进画布、最小 1×1）；不合法返回 null */
export function normalizeCell(value: unknown): MomentCell | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map((item) => Math.round(Number(item)));
  if (numbers.some((item) => !Number.isFinite(item))) return null;

  const w = Math.min(Math.max(numbers[2], 1), FREE_COLS);
  const h = Math.min(Math.max(numbers[3], 1), FREE_ROWS);
  const x = Math.min(Math.max(numbers[0], 0), FREE_COLS - w);
  const y = Math.min(Math.max(numbers[1], 0), FREE_ROWS - h);
  return [x, y, w, h];
}

/** 两个格子区域是否叠在一起（边贴边不算） */
export function cellsOverlap(a: MomentCell, b: MomentCell): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

/**
 * 这个格子能不能放：不越界、且不压到别的图。
 * skip 是「忽略第几张」（拖动自己时不能跟自己算重叠）。
 */
export function canPlaceCell(
  cell: MomentCell,
  cells: Array<MomentCell | null | undefined>,
  skip = -1,
): boolean {
  if (cell[0] < 0 || cell[1] < 0) return false;
  if (cell[0] + cell[2] > FREE_COLS || cell[1] + cell[3] > FREE_ROWS) return false;
  return cells.every((other, index) => index === skip || !other || !cellsOverlap(cell, other));
}

/** 实际占用的矩形：输出时按它裁剪（左上角挪到原点） */
export function freeBoardBox(cells: MomentCell[]): {
  cols: number;
  rows: number;
  /** 原点的偏移，渲染时 x - ox + 1 就是 grid-column */
  ox: number;
  oy: number;
} {
  if (!cells.length) return { cols: 1, rows: 1, ox: 0, oy: 0 };
  const ox = Math.min(...cells.map((cell) => cell[0]));
  const oy = Math.min(...cells.map((cell) => cell[1]));
  const right = Math.max(...cells.map((cell) => cell[0] + cell[2]));
  const bottom = Math.max(...cells.map((cell) => cell[1] + cell[3]));
  return { cols: Math.max(1, right - ox), rows: Math.max(1, bottom - oy), ox, oy };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 占格 → 最简比例：2×2 → 1:1，2×1 → 2:1，4×2 → 2:1 */
export function cellRatioLabel(cell: [number, number, number, number]): string {
  const w = Math.max(1, cell[2]);
  const h = Math.max(1, cell[3]);
  const divisor = gcd(w, h);
  return `${w / divisor}:${h / divisor}`;
}

/** 占格 → 「2×1」 */
export function cellSpansLabel(cell: [number, number, number, number]): string {
  return `${Math.max(1, cell[2])}×${Math.max(1, cell[3])}`;
}

/**
 * 默认版式：切换「手动排版」时先摆成这样，用户在画布上微调即可
 * （总不能让人对着 16 个空格子发呆）。
 * 4~9 张和自动九宫格长得一样，10 张以上就按 4 列一行行铺满。
 */
export function freePreset(count: number): MomentCell[] {
  const n = Math.min(Math.max(Math.round(count) || 0, 0), MOMENT_MAX_IMAGES);
  if (n <= 0) return [];
  if (n === 4) {
    return [
      [0, 0, 2, 2],
      [2, 0, 2, 2],
      [0, 2, 2, 2],
      [2, 2, 2, 2],
    ];
  }
  if (n === 5) {
    return [
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [3, 0, 1, 1],
      [2, 1, 1, 1],
      [3, 1, 1, 1],
    ];
  }
  if (n === 6) {
    return [
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [2, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
      [2, 1, 1, 1],
    ];
  }
  if (n === 7) {
    return [
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [3, 0, 1, 1],
      [2, 1, 1, 1],
      [3, 1, 1, 1],
      [0, 2, 2, 1],
      [2, 2, 2, 1],
    ];
  }
  if (n === 8) {
    return [
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [2, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 1, 1],
      [1, 2, 2, 1],
    ];
  }
  if (n === 9) {
    return [
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [2, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 1, 1],
      [1, 2, 1, 1],
      [2, 2, 1, 1],
    ];
  }
  return Array.from({ length: n }, (_, index) => {
    return [index % FREE_COLS, Math.floor(index / FREE_COLS), 1, 1] as MomentCell;
  });
}

/** 按视觉顺序（从上到下、从左到右）排：灯箱和读屏的顺序靠它 */
export function sortByCell<T extends { cell?: number[] | MomentCell }>(items: T[]): T[] {
  const keyed = items.map((item, index) => ({ item, index, cell: normalizeCell(item.cell) }));
  keyed.sort((a, b) => {
    if (!a.cell || !b.cell) return a.index - b.index;
    return a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0] || a.index - b.index;
  });
  return keyed.map((entry) => entry.item);
}

/** 这条动态是不是手动排版（且真的排进去过图） */
export function isFreeLayout(moment: { layout?: string; images?: MomentImage[] }): boolean {
  if (moment.layout !== 'free') return false;
  return (moment.images ?? []).some((image) => normalizeCell(image.cell));
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
