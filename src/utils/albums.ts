/**
 * 相册数据工具
 * ============================================================
 * 数据存在 config/albums.json，字段与参考站（RyuChan）保持一致：
 *   AlbumItem { id, date, event, title, description, icon, photos[] }
 *   Photo     { src, variant, title?, description? }
 *
 * variant 只有四种：1x1 / 4x3 / 4x5 / 9x16。
 * 上传照片时按图片「实际宽高比」自动挑最接近的一种（见 detectVariant）。
 *
 * 照片文件放 public/image/albums/，src 也支持外链 URL。
 * 注意：改完 config/albums.json 要重启 dev 或重新 build 才生效。
 * ============================================================
 */

import albumsJson from '../../config/albums.json';

/** 四种图片比例 */
export type PhotoVariant = '1x1' | '4x3' | '4x5' | '9x16';

export interface Photo {
  /** 仓库内路径（/image/albums/xxx.jpg）或外链 URL */
  src: string;
  variant: PhotoVariant;
  title?: string;
  description?: string;
}

export interface AlbumItem {
  id: string;
  /** 2026-05-20 */
  date: string;
  /** 事件名 / 封面主标题 */
  event: string;
  /** 副标题 */
  title: string;
  description: string;
  /** emoji 或 iconify 名（如 lucide:camera） */
  icon: string;
  photos: Photo[];
}

export const ALBUMS: AlbumItem[] = albumsJson as AlbumItem[];

/** 取全部相册（按日期从新到旧） */
export function getAlbums(): AlbumItem[] {
  return [...ALBUMS].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 按 id 取单个相册 */
export function getAlbum(id: string | null | undefined): AlbumItem | undefined {
  if (!id) return undefined;
  return ALBUMS.find((album) => album.id === id);
}

/** 每种比例对应的 CSS aspect-ratio，直接给 style 用 */
export const VARIANT_RATIO: Record<PhotoVariant, string> = {
  '1x1': '1 / 1',
  '4x3': '4 / 3',
  '4x5': '4 / 5',
  '9x16': '9 / 16',
};

/** 每种比例对应的数值宽高比 */
const VARIANT_VALUE: Record<PhotoVariant, number> = {
  '1x1': 1,
  '4x3': 4 / 3,
  '4x5': 4 / 5,
  '9x16': 9 / 16,
};

/**
 * 按图片实际宽高，挑最接近的比例。
 * 例：1200×800 → 4x3；900×1600 → 9x16
 */
export function detectVariant(width: number, height: number): PhotoVariant {
  if (!width || !height) return '4x3';
  const ratio = width / height;

  let best: PhotoVariant = '4x3';
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const variant of Object.keys(VARIANT_VALUE) as PhotoVariant[]) {
    const diff = Math.abs(VARIANT_VALUE[variant] - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = variant;
    }
  }
  return best;
}

/**
 * 浏览器端用：加载图片后自动判定比例。
 * 只在客户端脚本里调用（依赖 Image 对象）。
 */
export function detectVariantFromUrl(src: string): Promise<PhotoVariant> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(detectVariant(img.naturalWidth, img.naturalHeight));
    img.onerror = () => resolve('4x3');
    img.src = src;
  });
}

/** 生成一个 8 位随机 id（与参考站长度一致） */
export function newAlbumId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

/** 照片墙地址：/photo-wall/?id=xxx */
export function albumUrl(id: string): string {
  return `/photo-wall/?id=${encodeURIComponent(id)}`;
}
