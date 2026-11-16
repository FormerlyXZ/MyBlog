/**
 * 照片墙的纯逻辑（不读任何 JSON）
 * ============================================================
 * 分成两个文件的原因：
 *   · 这个文件 —— 类型、缺省值、清洗、标签统计。页面和管理面板共用。
 *   · utils/gallery.ts —— 额外 import 了 config/gallery.json（构建期数据）。
 *
 * 管理面板（/config）是从 GitHub 现读现写的，绝不能 import 那份 JSON，
 * 否则几百张照片的数据会被整份打进客户端包里。所以逻辑都放在这儿。
 * ============================================================
 */

export interface GalleryPhoto {
  /** 稳定 id，用于排序、筛选、deep-link（?p=id） */
  id: string;
  /** 图床 URL / 仓库内路径 / 外链 */
  src: string;
  /** 像素宽（排版按它算宽高比） */
  w: number;
  /** 像素高 */
  h: number;
  title?: string;
  description?: string;
  /** 分类标签，可多个 */
  tags?: string[];
  /** 拍摄/发布时间，可选 */
  date?: string;
}

export interface GallerySettings {
  /** 列宽（px）：一列照片的基准宽度，整片照片海的节奏由它决定 */
  columnWidth: number;
  /** 图与图之间的间隙（px）—— 放大时四周也是同一个间隙 */
  gap: number;
  /** 画布横向铺开多少个「屏幕宽」（1 = 正好一屏，3 = 三屏宽，能横向拖很远） */
  boardWidth: number;
  /** 图片圆角（px） */
  radius: number;
  /** 点开后那张照片的目标宽度（占视口宽度的比例） */
  focusWidth: number;
  /** 点开后那张照片的高度上限（占视口高度的比例）—— 竖图会被这条卡住 */
  focusMaxHeight: number;
  /** 点开后其余照片的变暗程度 */
  dim: number;
}

/** 数据文件路径（管理面板写回用） */
export const GALLERY_PATH = 'config/gallery.json';

export const DEFAULT_SETTINGS: GallerySettings = {
  columnWidth: 232,
  gap: 8,
  boardWidth: 3.2,
  radius: 4,
  focusWidth: 0.52,
  focusMaxHeight: 0.8,
  dim: 0.6,
};

/** 每个设置项的合理区间，页面和管理面板共用（手改 JSON 写坏了也不至于毁掉整页） */
export const SETTING_RANGE: Record<
  keyof GallerySettings,
  { min: number; max: number; step: number; label: string; hint: string }
> = {
  columnWidth: {
    min: 150,
    max: 340,
    step: 2,
    label: '列宽',
    hint: '一列照片的基准宽度（px），整片照片海的节奏由它决定',
  },
  gap: { min: 0, max: 24, step: 1, label: '间隙', hint: '照片之间的缝（px）；放大时四周也是同一个缝' },
  boardWidth: {
    min: 1.6,
    max: 6,
    step: 0.1,
    label: '画布宽度',
    hint: '照片海横向铺开几个屏幕宽。越大横向能拖得越远（竖向高度会自动配平）',
  },
  radius: { min: 0, max: 18, step: 1, label: '圆角', hint: '0 = 硬边直角' },
  focusWidth: {
    min: 0.3,
    max: 0.8,
    step: 0.02,
    label: '放大宽度',
    hint: '点开后那张照片的目标宽度，占视口宽度的比例',
  },
  focusMaxHeight: {
    min: 0.5,
    max: 0.95,
    step: 0.01,
    label: '放大高度上限',
    hint: '点开后那张照片最高不超过视口高度的多少；竖图会被这条卡住',
  },
  dim: { min: 0, max: 0.9, step: 0.02, label: '变暗', hint: '点开后其余照片压暗多少' },
};

/** 这几项是「比例」不是像素：管理面板要按小数显示 */
export const RATIO_KEYS = new Set<keyof GallerySettings>([
  'boardWidth',
  'focusWidth',
  'focusMaxHeight',
  'dim',
]);

const FALLBACK_W = 1200;
const FALLBACK_H = 900;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 逐字段夹到合理区间，缺的用缺省值 */
export function normalizeSettings(raw: unknown): GallerySettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<GallerySettings>;
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof GallerySettings>) {
    const range = SETTING_RANGE[key];
    out[key] = clampNumber(safeNumber(source[key], DEFAULT_SETTINGS[key]), range.min, range.max);
  }
  return out;
}

/** 清洗一条照片：补齐 w/h、去掉空标签、丢掉没有 src 的坏数据。返回 null 表示这条不要 */
export function normalizePhoto(raw: Partial<GalleryPhoto>, index: number): GalleryPhoto | null {
  const src = typeof raw.src === 'string' ? raw.src.trim() : '';
  if (!src) return null;

  const width = safeNumber(raw.w, 0);
  const height = safeNumber(raw.h, 0);
  const w = width > 0 ? width : FALLBACK_W;
  const h = height > 0 ? height : FALLBACK_H;

  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map((tag) => String(tag).trim()).filter(Boolean))]
    : [];

  return {
    id:
      typeof raw.id === 'string' && raw.id
        ? raw.id
        : // 没写 id 的老数据按位置补一个稳定的，别用随机数（否则每次构建都变）
          `p${String(index + 1).padStart(4, '0')}`,
    src,
    w,
    h,
    ...(raw.title ? { title: String(raw.title) } : {}),
    ...(raw.description ? { description: String(raw.description) } : {}),
    ...(tags.length ? { tags } : {}),
    ...(raw.date ? { date: String(raw.date) } : {}),
  };
}

/** 宽 / 高，夹在 0.28 ~ 4 之间（全景长条会把一整列撑爆） */
export function aspectOf(photo: Pick<GalleryPhoto, 'w' | 'h'>): number {
  const ratio = photo.w / photo.h;
  if (!Number.isFinite(ratio) || ratio <= 0) return FALLBACK_W / FALLBACK_H;
  return clampNumber(ratio, 0.28, 4);
}

export interface GalleryTag {
  tag: string;
  count: number;
}

/** 标签清单：按出现次数从多到少，同次数按首次出现顺序 */
export function tagList(photos: GalleryPhoto[]): GalleryTag[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  photos.forEach((photo, index) => {
    for (const tag of photo.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
      if (!firstSeen.has(tag)) firstSeen.set(tag, index);
    }
  });

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (firstSeen.get(a.tag) ?? 0) - (firstSeen.get(b.tag) ?? 0));
}

/** 8 位随机 id（相册/动态/音乐都用这一套写法） */
export function newPhotoId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}
