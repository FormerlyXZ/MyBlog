/**
 * 照片墙数据（构建期读取）
 * ============================================================
 * 数据在 config/gallery.json：
 *
 *   {
 *     settings: { columnWidth, gap, boardWidth, radius, focusWidth, focusMaxHeight, dim },
 *     photos:   [ { id, src, w, h, title?, description?, tags?, date? } ]
 *   }
 *
 * 和旧版 albums.json（相册 → 照片两层、每张照片只有 1x1/4x3/4x5/9x16 四档比例）
 * 的区别，也是这次重做的核心：
 *   · 扁平：所有照片在同一个池子里，靠 tags 分类，一张图可以有多个标签；
 *   · 真实尺寸：记 w/h（像素），排版按真实宽高比铺，不再被四档比例绑死；
 *   · 顺序即排版顺序：数组顺序 = 照片海从左到右、从上到下流动的顺序。
 *
 * src 支持三种写法：图床地址（https://picture.melodyxz.top/…）、
 * 仓库内路径（/image/gallery/…）、任意外链。
 * 改完 config/gallery.json 要重启 dev 或重新 build 才生效（构建期读文件）。
 *
 * ⚠ 纯逻辑（类型 / 缺省值 / 清洗 / 标签统计）在 utils/gallery-shared.ts，
 *   那个文件不 import JSON，管理面板要用它。
 * ============================================================
 */

import galleryJson from '../../config/gallery.json';
import {
  DEFAULT_SETTINGS,
  GALLERY_PATH,
  aspectOf,
  normalizePhoto,
  normalizeSettings,
  newPhotoId,
  tagList,
  type GalleryPhoto,
  type GallerySettings,
  type GalleryTag,
} from './gallery-shared';

export { DEFAULT_SETTINGS, GALLERY_PATH, aspectOf, newPhotoId, tagList };
export type { GalleryPhoto, GallerySettings, GalleryTag };

export interface GalleryData {
  settings?: Partial<GallerySettings>;
  photos?: GalleryPhoto[];
}

const DATA = galleryJson as unknown as GalleryData;

/** 排版设置（缺字段 / 越界都会自动修正） */
export function getSettings(): GallerySettings {
  return normalizeSettings(DATA.settings);
}

/** 全部照片（保持数组顺序 = 排版顺序），坏数据直接跳过 */
export function getPhotos(): GalleryPhoto[] {
  const list = Array.isArray(DATA.photos) ? DATA.photos : [];
  return list
    .map((photo, index) => normalizePhoto(photo, index))
    .filter((photo): photo is GalleryPhoto => photo !== null);
}

/** 标签清单（筛选胶囊用它渲染） */
export function getTags(photos: GalleryPhoto[]): GalleryTag[] {
  return tagList(photos);
}
