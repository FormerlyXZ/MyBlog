/**
 * 发布 / 编辑 / 删除动态（站长专用）
 * ============================================================
 * 一次「发布」= 一次 GitHub 提交（commitFiles，要么全成功要么全不动）：
 *   ① 新图片压缩后在浏览器里转成二进制 → public/images/moments/xxx.jpg
 *   ② 附件原样 → public/files/moments/xxx
 *   ③ 改写 config/moments.json（新动态插到最前面）
 * 提交后站点自动重建，约 1 分钟生效。
 *
 * 几个实现上的取舍：
 *   · 图片在上传前压到长边 1600px、JPEG q0.86：GitHub 单文件越小提交越快，
 *     页面上反正最宽也就 400px 左右，原图直接塞进去只会拖慢每次提交。
 *   · 编辑已有动态时，没动过的图片直接沿用原路径（不重复上传）；
 *     删掉的图片在同一个 commit 里顺手把文件也删了，不留垃圾。
 *   · 令牌来自写作会话（localStorage['melodyxz-edit']，scope=repo），
 *     退出浏览器即清除，不经过任何第三方。
 */

import { onPageLoad } from './pageload';
import {
  ApiError,
  clearEditSession,
  getEditSession,
  onEditAuthChange,
  openEditLogin,
  showToast,
} from '../utils/site';
import { commitFiles, getFile, type FileChange } from '../utils/github';
import {
  FREE_COLS,
  FREE_MIN_IMAGES,
  FREE_ROWS,
  MOMENT_MAX_FILES,
  MOMENT_MAX_IMAGES,
  canPlaceCell,
  cellRatioLabel,
  cellSpansLabel,
  cellsOverlap,
  formatFileSize,
  freeBoardBox,
  freePreset,
  normalizeCell,
  type Moment,
  type MomentCell,
  type MomentFile,
  type MomentImage,
} from '../utils/moment-meta';

/** 动态数据文件（整个文件都是这一份 JSON） */
const MOMENTS_PATH = 'config/moments.json';
/** 新图片 / 新附件落在仓库里的目录 */
const IMAGE_DIR = 'public/images/moments';
const FILE_DIR = 'public/files/moments';
/** 图片压缩：长边上限、JPEG 质量 */
const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.86;
/** 单个图片原图 / 附件的体积上限（字节） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/* ============================================================
   草稿状态
   ============================================================ */

interface DraftImage {
  /** 预览地址（新图是 blob: URL，老图是站内路径） */
  preview: string;
  /** 已经存在于仓库里的图片路径（编辑时沿用） */
  src?: string;
  /** 新选的本地文件 */
  file?: File;
  w?: number;
  h?: number;
  /** 手动排版时在 4×4 画布上占的格子；没排进画布就是 undefined */
  cell?: MomentCell;
  /** 上次在画布上占的格子：移出后留着，再放回来还是原来的大小 */
  lastCell?: MomentCell;
  /** blob: URL 用完要回收 */
  revoke?: boolean;
}

interface DraftFile {
  name: string;
  size: number;
  /** 已存在于仓库里的路径 */
  src?: string;
  file?: File;
}

const state = {
  /** 正在编辑哪条动态（null = 新建） */
  editing: null as string | null,
  text: '',
  images: [] as DraftImage[],
  files: [] as DraftFile[],
  location: '',
  tags: '',
  mood: '',
  pinned: false,
  /** 手动排版开关（画布上有图才能打开） */
  free: false,
  /** 编辑时被删掉的旧图片 / 旧附件，发布时一并从仓库删除 */
  removed: [] as string[],
  busy: false,
};

/* ============================================================
   小工具
   ============================================================ */

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地时间：2026-10-26 13:05 */
function nowText(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 8 位随机 id（和相册、音乐用的同一套写法） */
function newMomentId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    if (!existing.has(id)) return id;
  }
  return Date.now().toString(36).slice(-8);
}

/** 文件名里的脏字符折成连字符（中文保留） */
function safeName(name: string): string {
  return (
    name
      .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'file'
  );
}

function extFromType(type: string, fallback = 'jpg'): string {
  if (/png/i.test(type)) return 'png';
  if (/webp/i.test(type)) return 'webp';
  if (/gif/i.test(type)) return 'gif';
  if (/jpe?g/i.test(type)) return 'jpg';
  return fallback;
}

/** 站内路径 → 仓库路径（/images/moments/a.jpg → public/images/moments/a.jpg） */
function repoPath(src: string): string | null {
  if (!src.startsWith('/')) return null;
  if (!/^\/(images|files)\/moments\//.test(src)) return null;
  return `public${src}`;
}

const $ = <T extends HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

function setStatus(text: string): void {
  const el = $('[data-moment-status]');
  if (el) el.textContent = text;
}

/* ============================================================
   读 / 写 moments.json
   ============================================================ */

async function readMoments(): Promise<Moment[]> {
  const file = await getFile(MOMENTS_PATH);
  if (!file) return [];
  try {
    const parsed = JSON.parse(file.text);
    return Array.isArray(parsed) ? (parsed as Moment[]) : [];
  } catch {
    throw new Error('config/moments.json 不是合法的 JSON，先修好再发布');
  }
}

/* ============================================================
   图片压缩
   ============================================================ */

interface LoadedBitmap {
  width: number;
  height: number;
  source: CanvasImageSource;
  release: () => void;
}

async function loadBitmap(file: File): Promise<LoadedBitmap> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        release: () => bitmap.close(),
      };
    } catch {
      /* 某些浏览器对 HEIC / 超大图会失败，落到 <img> 方案 */
    }
  }

  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('这张图读不出来，换一张试试'));
    img.src = url;
  });
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    source: img,
    release: () => URL.revokeObjectURL(url),
  };
}

interface CompressedImage {
  buffer: ArrayBuffer;
  ext: string;
  w: number;
  h: number;
}

/**
 * 压缩一张图。
 * GIF 保留原样（压缩会丢动画）；已经在 1600px 以内且体积不大的 jpg/png/webp 也不动，
 * 避免把本来压好的图重新编码一遍（会掉画质）。
 */
async function compressImage(file: File): Promise<CompressedImage> {
  const bitmap = await loadBitmap(file);
  try {
    const { width, height } = bitmap;
    const type = file.type || '';
    const smallEnough =
      Math.max(width, height) <= MAX_SIDE &&
      file.size <= 500 * 1024 &&
      /image\/(jpeg|png|webp|gif)/i.test(type);

    if (/image\/gif/i.test(type) || smallEnough) {
      return {
        buffer: await file.arrayBuffer(),
        ext: extFromType(type),
        w: width,
        h: height,
      };
    }

    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持图片压缩，换一个浏览器试试');

    // PNG 透明区域转成 JPEG 会变黑，先铺一层白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap.source, 0, 0, outW, outH);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('图片压缩失败，换一张试试');

    return { buffer: await blob.arrayBuffer(), ext: 'jpg', w: outW, h: outH };
  } finally {
    bitmap.release();
  }
}

/* ============================================================
   表单渲染
   ============================================================ */

function releasePreview(image: DraftImage): void {
  if (image.revoke && image.preview.startsWith('blob:')) {
    URL.revokeObjectURL(image.preview);
  }
}

function renderThumbs(): void {
  const wrap = $('[data-moment-thumbs]');
  const counter = $('[data-moment-image-count]');
  if (counter) counter.textContent = String(state.images.length);
  if (!wrap) return;

  wrap.replaceChildren();
  state.images.forEach((image, index) => {
    const cell = document.createElement('div');
    cell.className = 'moment-thumb';
    cell.dataset.thumbIndex = String(index);
    if (index === 0) cell.classList.add('is-cover');
    // 手动排版时标一下：已排进画布的角上打勾，没排进去的淡化
    if (state.free) cell.classList.add(image.cell ? 'is-placed' : 'is-unplaced');

    const img = document.createElement('img');
    img.src = image.preview;
    img.alt = `第 ${index + 1} 张`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'moment-thumb__x';
    remove.dataset.removeImage = String(index);
    remove.setAttribute('aria-label', `移除第 ${index + 1} 张图片`);
    remove.title = '移除';
    remove.textContent = '×';

    cell.append(img, remove);
    wrap.append(cell);
  });

  wrap.classList.toggle('is-empty', state.images.length === 0);
  syncBoardToggle();
}

function renderFiles(): void {
  const wrap = $('[data-moment-files]');
  const counter = $('[data-moment-file-count]');
  if (counter) counter.textContent = String(state.files.length);
  if (!wrap) return;

  wrap.replaceChildren();
  state.files.forEach((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'moment-chips__item';

    const name = document.createElement('span');
    name.className = 'moment-chips__name';
    name.textContent = file.name;

    const size = document.createElement('span');
    size.className = 'moment-chips__size';
    size.textContent = formatFileSize(file.size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'moment-chips__x';
    remove.dataset.removeFile = String(index);
    remove.setAttribute('aria-label', `移除附件 ${file.name}`);
    remove.title = '移除';
    remove.textContent = '×';

    chip.append(name, size, remove);
    wrap.append(chip);
  });

  wrap.classList.toggle('is-empty', state.files.length === 0);
}

/* ============================================================
   手动排版画布（4×4）
   ============================================================
   · 画布固定 4×4 格，每张图的 cell = [x, y, w, h]（单位：格）；
   · 缩略图 → 画布：拖进来（触屏长按 180ms 后拖）或点一下自动填空位；
   · 画布内：拖动换位置、拉右下角改大小；整格吸附、不许重叠，
     落点不合法就变红并弹回原处；
   · 发布时按视觉顺序排序写进 moments.json，卡片那边按 cell 渲染、
     并裁到「实际占用到的矩形」，不会留一片空白。
   ============================================================ */

interface BoardMetrics {
  rect: DOMRect;
  /** 一格多宽 / 多高（含一个 gap） */
  unitX: number;
  unitY: number;
  /** 网格内边距 */
  pad: number;
  /** 格子之间的缝（换算"几格 = 多少像素"时要用） */
  gap: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function boardItems(): HTMLElement | null {
  return $('[data-moment-board-items]');
}

function placedCells(): Array<MomentCell | undefined> {
  return state.images.map((image) => image.cell);
}

function placedCount(): number {
  return state.images.filter((image) => Boolean(normalizeCell(image.cell))).length;
}

/** 能不能开手动排版：至少有一张图 */
function canUseFree(): boolean {
  return state.images.length >= FREE_MIN_IMAGES;
}

/** 图被删光了就自动退回自动版式（格子留着，加回来还能继续用） */
function syncBoardToggle(): void {
  if (!canUseFree() && state.free) state.free = false;

  const toggle = $<HTMLButtonElement>('[data-moment-board-toggle]');
  const panel = $('[data-moment-board-panel]');
  const label = toggle?.querySelector('[data-moment-board-toggle-text]');

  if (toggle) {
    toggle.hidden = !canUseFree();
    toggle.classList.toggle('is-on', state.free);
    toggle.setAttribute('aria-pressed', String(state.free));
    toggle.title = state.free ? '切回自动版式' : '自己摆图：拖进 4×4 画布';
  }
  if (label) label.textContent = state.free ? '自动版式' : '手动排版';
  if (panel) panel.hidden = !state.free;
  // 只有开了手动排版，缩略图才是"可以拖的"
  $('[data-moment-form]')?.classList.toggle('is-free', state.free);
}

function badgeText(cell: MomentCell): string {
  return `${cellSpansLabel(cell)} · ${cellRatioLabel(cell)}`;
}

function applyItemCell(item: HTMLElement, cell: MomentCell): void {
  item.style.gridColumn = `${cell[0] + 1} / span ${cell[2]}`;
  item.style.gridRow = `${cell[1] + 1} / span ${cell[3]}`;
  const badge = item.querySelector('.moment-board__badge');
  if (badge) badge.textContent = badgeText(cell);
}

function buildBoardItem(image: DraftImage, index: number, cell: MomentCell): HTMLElement {
  const item = document.createElement('div');
  item.className = 'moment-board__item';
  item.dataset.boardItem = String(index);
  applyItemCell(item, cell);

  const img = document.createElement('img');
  img.src = image.preview;
  img.alt = '';
  img.draggable = false;

  const badge = document.createElement('span');
  badge.className = 'moment-board__badge';
  badge.textContent = badgeText(cell);

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'moment-board__handle';
  handle.dataset.boardHandle = '';
  handle.setAttribute('aria-label', `缩放第 ${index + 1} 张`);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'moment-board__del';
  remove.dataset.boardDel = String(index);
  remove.textContent = '×';
  remove.setAttribute('aria-label', `把第 ${index + 1} 张移出画布`);
  remove.title = '移出画布';

  item.append(img, badge, handle, remove);
  return item;
}

/** 重绘画布（开关、增删图、放好之后都走这里） */
function renderBoard(): void {
  syncBoardToggle();

  const slots = $('[data-moment-board-slots]');
  if (slots && !slots.childElementCount) {
    for (let index = 0; index < FREE_COLS * FREE_ROWS; index += 1) {
      const slot = document.createElement('span');
      slot.className = 'moment-board__slot';
      slots.append(slot);
    }
  }

  const items = boardItems();
  if (items) {
    items.replaceChildren();
    if (state.free) {
      state.images.forEach((image, index) => {
        const cell = normalizeCell(image.cell);
        if (cell) items.append(buildBoardItem(image, index, cell));
      });
    }
  }

  renderBoardMeta();
}

/** 画布下方那行实时说明：几张、输出多大、比例多少、还有几张没排 */
function renderBoardMeta(): void {
  const meta = $('[data-moment-board-meta]');
  if (!meta) return;

  const cells = state.images
    .map((image) => normalizeCell(image.cell))
    .filter((cell): cell is MomentCell => Boolean(cell));

  if (!cells.length) {
    meta.classList.remove('is-warn');
    meta.textContent = '画布是空的：点一下下面的缩略图放进来，或者按住拖进格子';
    return;
  }

  const box = freeBoardBox(cells);
  const unplaced = state.images.length - cells.length;
  const parts = [
    `画布上 ${cells.length} 张`,
    `输出 ${box.cols}×${box.rows} 格`,
    `版面比例 ${cellRatioLabel([0, 0, box.cols, box.rows])}`,
  ];
  if (unplaced > 0) parts.push(`还有 ${unplaced} 张没排进来（不会发布）`);

  meta.textContent = parts.join(' · ');
  meta.classList.toggle('is-warn', unplaced > 0 || cells.length < FREE_MIN_IMAGES);
}

/** 「推荐版式」：按张数先摆好，用户在画布上微调 */
function applyPreset(): void {
  const cells = freePreset(state.images.length);
  state.images.forEach((image, index) => {
    const preset = cells[index];
    image.cell = preset ? ([...preset] as MomentCell) : undefined;
  });
}

/** 点一下缩略图：在画布上就移出去，不在画布上就放进来（第一个空位） */
function toggleOnBoard(index: number): void {
  const image = state.images[index];
  if (!image || !state.free) return;

  const cell = normalizeCell(image.cell);
  if (cell) {
    image.lastCell = cell;
    image.cell = undefined;
    renderBoard();
    renderThumbs();
    showToast('已移出画布（再点一下放回来）');
    return;
  }

  autoPlace(index);
}

/**
 * 放回画布：优先按上次的大小找位置（挪出去再放回来不至于缩成 1×1），
 * 实在放不下退回 1×1，从左上往右下找第一个空位。
 */
function autoPlace(index: number): void {
  const image = state.images[index];
  if (!image || !state.free) return;

  const cells = placedCells();
  const previous = normalizeCell(image.lastCell);
  const sizes: Array<[number, number]> = previous
    ? [
        [previous[2], previous[3]],
        [1, 1],
      ]
    : [[1, 1]];

  for (const [w, h] of sizes) {
    for (let y = 0; y <= FREE_ROWS - h; y += 1) {
      for (let x = 0; x <= FREE_COLS - w; x += 1) {
        const candidate: MomentCell = [x, y, w, h];
        if (!canPlaceCell(candidate, cells, index)) continue;
        image.cell = candidate;
        image.lastCell = undefined;
        renderBoard();
        renderThumbs();
        return;
      }
    }
  }

  showToast('画布满了：先移走或缩小几张');
}

function toggleFree(): void {
  if (!canUseFree()) {
    showToast('先加一张图片，再来排版');
    return;
  }
  state.free = !state.free;
  if (state.free && !state.images.some((image) => image.cell)) applyPreset();
  renderBoard();
  renderThumbs();
  if (state.free) {
    $('[data-moment-board-panel]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ---------- 画布几何 ---------- */

function boardMetrics(): BoardMetrics | null {
  const board = $<HTMLElement>('[data-moment-board]');
  const grid = boardItems();
  if (!board || !grid) return null;
  const rect = board.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const styles = getComputedStyle(grid);
  const gap = parseFloat(styles.columnGap) || 0;
  const pad = parseFloat(styles.paddingLeft) || 0;
  const innerW = rect.width - pad * 2;
  const innerH = rect.height - pad * 2;

  return {
    rect,
    pad,
    gap,
    unitX: (innerW + gap) / FREE_COLS,
    unitY: (innerH + gap) / FREE_ROWS,
  };
}

function isInsideBoard(metrics: BoardMetrics, x: number, y: number): boolean {
  const left = metrics.rect.left + metrics.pad;
  const top = metrics.rect.top + metrics.pad;
  const width = metrics.rect.width - metrics.pad * 2;
  const height = metrics.rect.height - metrics.pad * 2;
  return x >= left && x <= left + width && y >= top && y <= top + height;
}

/** 指针位置 → 要放的格子（以手指所在格为中心） */
function pointerToCell(
  metrics: BoardMetrics,
  x: number,
  y: number,
  w: number,
  h: number,
): MomentCell {
  const column = Math.floor((x - metrics.rect.left - metrics.pad) / metrics.unitX);
  const row = Math.floor((y - metrics.rect.top - metrics.pad) / metrics.unitY);
  return [
    clamp(column - Math.floor((w - 1) / 2), 0, FREE_COLS - w),
    clamp(row - Math.floor((h - 1) / 2), 0, FREE_ROWS - h),
    w,
    h,
  ];
}

/* ---------- 吸附预览（拖动时那块虚线框） ---------- */

function snapElement(): HTMLElement | null {
  const layer = boardItems();
  if (!layer) return null;
  let element = layer.querySelector<HTMLElement>('.moment-board__preview');
  if (!element) {
    element = document.createElement('div');
    element.className = 'moment-board__preview';
    layer.append(element);
  }
  return element;
}

function showSnap(cell: MomentCell, valid: boolean, pushCount = 0): void {
  const element = snapElement();
  if (!element) return;
  element.style.display = '';
  element.style.gridColumn = `${cell[0] + 1} / span ${cell[2]}`;
  element.style.gridRow = `${cell[1] + 1} / span ${cell[3]}`;
  element.classList.toggle('is-invalid', !valid);
  element.classList.toggle('is-push', valid && pushCount > 0);
  if (valid && pushCount > 0) {
    element.dataset.push = `挤开 ${pushCount} 张`;
  } else {
    delete element.dataset.push;
  }
}

function hideSnap(): void {
  const element = boardItems()?.querySelector<HTMLElement>('.moment-board__preview');
  if (!element) return;
  element.style.display = 'none';
  delete element.dataset.push;
}

/**
 * 排挤：把被 target 压住的图挪到最近的空位。
 * 返回"谁挪到哪"；实在挪不开（画布塞满了）返回 null —— 与其挤得乱七八糟，
 * 不如让它红一下、松手弹回去。
 * 大块的先安排，因为小块更容易塞进缝里。
 */
function planPush(
  target: MomentCell,
  cells: Array<MomentCell | undefined>,
  skip: number,
): Map<number, MomentCell> | null {
  // 拖动的那张算"已经占住 target"，别人的老位置就是障碍
  const occupied: Array<MomentCell | undefined> = cells.map((cell, index) =>
    index === skip ? target : cell,
  );

  const victims: number[] = [];
  occupied.forEach((cell, index) => {
    if (index === skip || !cell) return;
    if (cellsOverlap(target, cell)) victims.push(index);
  });

  const plan = new Map<number, MomentCell>();
  if (!victims.length) return plan;

  victims.sort((a, b) => {
    const ca = occupied[a] as MomentCell;
    const cb = occupied[b] as MomentCell;
    return cb[2] * cb[3] - ca[2] * ca[3] || a - b;
  });

  for (const index of victims) {
    const current = occupied[index] as MomentCell;
    let best: MomentCell | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let y = 0; y < FREE_ROWS; y += 1) {
      for (let x = 0; x < FREE_COLS; x += 1) {
        const candidate: MomentCell = [x, y, current[2], current[3]];
        if (!canPlaceCell(candidate, occupied, index)) continue;
        const score = Math.abs(x - current[0]) + Math.abs(y - current[1]);
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    if (!best) return null;
    occupied[index] = best;
    plan.set(index, best);
  }

  return plan;
}

/**
 * 落地 + 动画：先把每张图的旧位置记下来，写回新格子后用 FLIP 从旧位置滑过去。
 * 被挤开的图和拖动的图用的是同一套动画，所以看起来是"一起让开"。
 */
function commitCells(entries: Array<{ index: number; cell: MomentCell }>): void {
  const layer = boardItems();
  if (!layer || !entries.length) {
    renderBoardMeta();
    return;
  }

  const elements = new Map<number, HTMLElement>();
  const targets = new Map<number, MomentCell>();
  for (const entry of entries) {
    // 状态先写回去：万一 DOM 里找不到元素（比如刚好重绘过），数据也不会丢
    state.images[entry.index].cell = entry.cell;
    targets.set(entry.index, entry.cell);
  }
  for (const entry of entries) {
    const element = layer.querySelector<HTMLElement>(`[data-board-item="${entry.index}"]`);
    if (element) elements.set(entry.index, element);
  }

  const before = new Map<number, DOMRect>();
  elements.forEach((element, index) => before.set(index, element.getBoundingClientRect()));

  // 归位：摘掉跟手用的 transform / 尺寸，再写回网格
  elements.forEach((element, index) => {
    const cell = targets.get(index);
    if (!cell) return;
    element.style.transition = 'none';
    element.style.transform = '';
    element.style.width = '';
    element.style.height = '';
    element.classList.remove('is-dragging', 'is-invalid');
    applyItemCell(element, cell);
  });

  // 刚从列表拖进来的那张还没有 DOM：现场建一个，让它淡入
  const fresh: HTMLElement[] = [];
  for (const entry of entries) {
    if (elements.has(entry.index)) continue;
    const image = state.images[entry.index];
    const element = buildBoardItem(image, entry.index, entry.cell);
    element.classList.add('is-appearing');
    layer.append(element);
    elements.set(entry.index, element);
    fresh.push(element);
  }

  if (fresh.length) {
    requestAnimationFrame(() => {
      for (const element of fresh) element.classList.add('is-appear-in');
    });
    window.setTimeout(() => {
      for (const element of fresh) element.classList.remove('is-appearing', 'is-appear-in');
    }, 220);
  }

  requestAnimationFrame(() => {
    const movers: HTMLElement[] = [];
    elements.forEach((element, index) => {
      const oldRect = before.get(index);
      if (!oldRect) return;
      const newRect = element.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        // 没动的那几张把临时样式收干净，别留着 transition: none 影响后面
        element.style.transition = '';
        element.style.transform = '';
        return;
      }
      element.style.transition = 'none';
      element.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
      movers.push(element);
      requestAnimationFrame(() => {
        element.style.transition = 'transform 170ms var(--ease-soft)';
        element.style.transform = '';
      });
    });
    if (movers.length) {
      window.setTimeout(() => {
        for (const element of movers) {
          element.style.transition = '';
          element.style.transform = '';
        }
      }, 260);
    }
  });

  renderBoardMeta();
  renderThumbs();
}

/* ---------- 画布内：拖动 / 缩放 ----------
   手感：
   · 手指 / 鼠标走多远，图就跟着走多远（不被格子"卡"着）；
   · 同时算一个吸附格子，用虚线框显示它要落到哪儿；
   · 松手时滑进那个格子 —— "靠近就吸上去"；
   · 格子被别的图占着也没关系：会把它们挤到最近的空位（虚线框变琥珀色，
     上面写着"挤开 N 张"）；实在挤不开才变红，松手弹回原处。         */

type BoardMode = 'move' | 'resize';

interface BoardDrag {
  index: number;
  mode: BoardMode;
  pointerId: number;
  startX: number;
  startY: number;
  /** 按下时的格子 */
  origin: MomentCell;
  /** 按下时元素的像素宽高 */
  originW: number;
  originH: number;
  /** 按下时元素左上角相对画布内容区的位置（用来把拖动钳在画布里） */
  originLeft: number;
  originTop: number;
  /** 按下时的画布尺寸（拖的时候页面别滚动，用快照更稳） */
  metrics: BoardMetrics;
  /** 松手会落到哪个格子 */
  cell: MomentCell;
  /** 这个落点合不合法（缩放时永远是合法值） */
  valid: boolean;
  /** 落点被占时需要挤开谁、挤到哪 */
  push: Map<number, MomentCell>;
  element: HTMLElement | null;
}

let boardDrag: BoardDrag | null = null;

/** n 格 = 多少像素（n * unit 减去最后那条缝） */
function spanPx(n: number, unit: number, gap: number): number {
  return Math.max(1, n * unit - gap);
}

/**
 * 缩放时想要的宽高撞到别人了（而且挤不开）：在合法尺寸里挑一个最接近想要的
 * （所以手感是"长到边界就停住"，而不是突然变红）。只会变大不会变小。
 */
function bestSpan(
  x: number,
  y: number,
  wantW: number,
  wantH: number,
  cells: Array<MomentCell | undefined>,
  skip: number,
): MomentCell {
  const minW = normalizeCell(cells[skip])?.[2] ?? 1;
  const minH = normalizeCell(cells[skip])?.[3] ?? 1;
  let best: MomentCell = [x, y, Math.max(1, minW), Math.max(1, minH)];
  let bestScore = Number.POSITIVE_INFINITY;
  for (let w = minW; w <= FREE_COLS - x; w += 1) {
    for (let h = minH; h <= FREE_ROWS - y; h += 1) {
      const candidate: MomentCell = [x, y, w, h];
      if (!canPlaceCell(candidate, cells, skip)) continue;
      const score = Math.abs(w - wantW) + Math.abs(h - wantH);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }
  return best;
}

function onBoardPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('[data-board-del]')) return;

  const item = target.closest<HTMLElement>('[data-board-item]');
  if (!item) return;

  const index = Number(item.dataset.boardItem);
  const image = state.images[index];
  const cell = normalizeCell(image?.cell);
  const metrics = boardMetrics();
  if (!image || !cell || !metrics) return;

  // 拦一下：不然手机上这一下手势会变成滚动 / 长按菜单
  event.preventDefault();

  const rect = item.getBoundingClientRect();
  boardDrag = {
    index,
    mode: target.closest('[data-board-handle]') ? 'resize' : 'move',
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    origin: cell,
    originW: rect.width,
    originH: rect.height,
    originLeft: rect.left - (metrics.rect.left + metrics.pad),
    originTop: rect.top - (metrics.rect.top + metrics.pad),
    metrics,
    cell,
    valid: true,
    push: new Map<number, MomentCell>(),
    element: item,
  };
  item.classList.add('is-dragging');
  item.setPointerCapture?.(event.pointerId);
}

function onBoardPointerMove(event: PointerEvent): void {
  const drag = boardDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;

  const metrics = drag.metrics;
  const element = drag.element;
  const contentW = metrics.rect.width - metrics.pad * 2;
  const contentH = metrics.rect.height - metrics.pad * 2;

  // 0) 拖动只在画布里进行：手指甩出画布时图也贴着边停住，
  //    这样"松手会不会被移出画布"就不再取决于最后一瞬间手指在哪儿
  const dx = clamp(
    event.clientX - drag.startX,
    -drag.originLeft,
    contentW - drag.originW - drag.originLeft,
  );
  const dy = clamp(
    event.clientY - drag.startY,
    -drag.originTop,
    contentH - drag.originH - drag.originTop,
  );
  const rawDx = event.clientX - drag.startX;
  const rawDy = event.clientY - drag.startY;

  // 1) 图跟着指针自由走（移动是平移，缩放是往右下角长）
  if (element) {
    if (drag.mode === 'move') {
      element.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    } else {
      const maxW = spanPx(FREE_COLS - drag.origin[0], metrics.unitX, metrics.gap);
      const maxH = spanPx(FREE_ROWS - drag.origin[1], metrics.unitY, metrics.gap);
      const width = clamp(drag.originW + rawDx, spanPx(1, metrics.unitX, metrics.gap), maxW);
      const height = clamp(drag.originH + rawDy, spanPx(1, metrics.unitY, metrics.gap), maxH);
      element.style.width = `${width.toFixed(1)}px`;
      element.style.height = `${height.toFixed(1)}px`;
    }
  }

  // 2) 算出要吸附到哪一格
  const cells = placedCells();

  if (drag.mode === 'move') {
    const target: MomentCell = [
      clamp(drag.origin[0] + Math.round(dx / metrics.unitX), 0, FREE_COLS - drag.origin[2]),
      clamp(drag.origin[1] + Math.round(dy / metrics.unitY), 0, FREE_ROWS - drag.origin[3]),
      drag.origin[2],
      drag.origin[3],
    ];
    drag.cell = target;
    // 空的就直接放；被占了就看能不能把那几张挤开
    const plan = canPlaceCell(target, cells, drag.index)
      ? new Map<number, MomentCell>()
      : planPush(target, cells, drag.index);
    drag.push = plan ?? new Map<number, MomentCell>();
    drag.valid = plan !== null;
    element?.classList.toggle('is-invalid', !drag.valid);
    showSnap(target, drag.valid, drag.push.size);
    return;
  }

  const wantW = clamp(drag.origin[2] + Math.round(rawDx / metrics.unitX), 1, FREE_COLS - drag.origin[0]);
  const wantH = clamp(drag.origin[3] + Math.round(rawDy / metrics.unitY), 1, FREE_ROWS - drag.origin[1]);
  const wanted: MomentCell = [drag.origin[0], drag.origin[1], wantW, wantH];

  if (canPlaceCell(wanted, cells, drag.index)) {
    drag.cell = wanted;
    drag.push = new Map<number, MomentCell>();
  } else {
    const plan = planPush(wanted, cells, drag.index);
    if (plan) {
      // 挤得开：长到想要的大小，顺便把挡路的挤走
      drag.cell = wanted;
      drag.push = plan;
    } else {
      // 挤不开：停在长不动的尺寸
      drag.cell = bestSpan(drag.origin[0], drag.origin[1], wantW, wantH, cells, drag.index);
      drag.push = new Map<number, MomentCell>();
    }
  }
  drag.valid = true;
  element?.classList.remove('is-invalid');
  showSnap(drag.cell, true, drag.push.size);
}

function onBoardPointerUp(event: PointerEvent): void {
  const drag = boardDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  boardDrag = null;
  hideSnap();

  const target = drag.valid ? drag.cell : drag.origin;
  const entries: Array<{ index: number; cell: MomentCell }> = [{ index: drag.index, cell: target }];
  if (drag.valid) {
    for (const [index, cell] of drag.push) entries.push({ index, cell });
  }

  // 落地 + FLIP：拖动的这张和让开的几张一起滑过去
  commitCells(entries);
}

/* ---------- 缩略图 → 画布 ---------- */

interface ThumbPress {
  index: number;
  pointerId: number;
  startX: number;
  startY: number;
  pointerType: string;
  /** 触屏的长按计时器 */
  timer: number | null;
  dragging: boolean;
  /** 拖进来的图占几格（画布上的图保持原大小，没排过的按 1×1） */
  span: [number, number];
  ghost: HTMLElement | null;
  cell: MomentCell | null;
  valid: boolean;
  /** 落点被占时要挤开谁 */
  push: Map<number, MomentCell> | null;
}

let thumbPress: ThumbPress | null = null;

/** 收尾：清计时器、摘掉幽灵图，落点虚线框先留着（松手后由 showSnap/hideSnap 管） */
function cleanupThumbPress(press: ThumbPress | null = thumbPress): void {
  if (!press) return;
  if (press.timer) window.clearTimeout(press.timer);
  press.ghost?.remove();
  hideSnap();
  document.body.classList.remove('is-board-dragging');
}

function onThumbPointerDown(event: PointerEvent): void {
  if (!state.free) return;
  const target = event.target as HTMLElement;
  if (target.closest('[data-remove-image]')) return;

  const thumb = target.closest<HTMLElement>('[data-thumb-index]');
  if (!thumb) return;
  const index = Number(thumb.dataset.thumbIndex);
  if (!Number.isFinite(index)) return;

  const existing = normalizeCell(state.images[index]?.cell);
  cleanupThumbPress();
  thumbPress = {
    index,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    pointerType: event.pointerType,
    timer: null,
    dragging: false,
    span: existing ? [existing[2], existing[3]] : [1, 1],
    ghost: null,
    cell: null,
    valid: false,
    push: null,
  };

  // 触屏要长按一小会儿才开始拖，否则手指一划就变成拖图，列表没法滚
  if (event.pointerType === 'touch') {
    thumbPress.timer = window.setTimeout(startThumbDrag, 180);
  }
}

function startThumbDrag(): void {
  const press = thumbPress;
  if (!press || press.dragging) return;
  if (press.timer) {
    window.clearTimeout(press.timer);
    press.timer = null;
  }

  const image = state.images[press.index];
  if (!image) return;
  press.dragging = true;
  document.body.classList.add('is-board-dragging');

  const ghost = document.createElement('div');
  ghost.className = 'moment-board__ghost';
  const ghostImage = document.createElement('img');
  ghostImage.src = image.preview;
  ghostImage.alt = '';
  ghost.append(ghostImage);
  document.body.append(ghost);
  press.ghost = ghost;

  updateThumbDrag(press.startX, press.startY);
}

function updateThumbDrag(x: number, y: number): void {
  const press = thumbPress;
  if (!press?.dragging || !press.ghost) return;

  press.ghost.style.left = `${x}px`;
  press.ghost.style.top = `${y}px`;

  const metrics = boardMetrics();
  if (!metrics || !boardItems() || !isInsideBoard(metrics, x, y)) {
    press.cell = null;
    press.valid = false;
    hideSnap();
    return;
  }

  const candidate = pointerToCell(metrics, x, y, press.span[0], press.span[1]);
  const cells = placedCells();
  const plan = canPlaceCell(candidate, cells, press.index)
    ? new Map<number, MomentCell>()
    : planPush(candidate, cells, press.index);

  press.cell = candidate;
  press.push = plan;
  press.valid = plan !== null;
  showSnap(candidate, press.valid, plan?.size ?? 0);
}

function onThumbPointerMove(event: PointerEvent): void {
  const press = thumbPress;
  if (!press || event.pointerId !== press.pointerId) return;

  if (!press.dragging) {
    const distance = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
    if (press.pointerType === 'touch') {
      // 手指在滚列表，不是要拖图
      if (distance > 12) {
        cleanupThumbPress();
        thumbPress = null;
      }
    } else if (distance > 6) {
      startThumbDrag();
    }
    return;
  }

  updateThumbDrag(event.clientX, event.clientY);
}

function onThumbPointerUp(event: PointerEvent): void {
  const press = thumbPress;
  if (!press || event.pointerId !== press.pointerId) return;
  thumbPress = null;
  const wasDragging = press.dragging;
  const cell = press.cell;
  const valid = press.valid;
  cleanupThumbPress(press);

  // 没拖起来 = 点了一下：点已放入的移出，点没放入的自动填空位
  if (!wasDragging) {
    toggleOnBoard(press.index);
    return;
  }

  if (cell && valid) {
    const entries: Array<{ index: number; cell: MomentCell }> = [{ index: press.index, cell }];
    if (press.push) {
      for (const [index, pushedCell] of press.push) entries.push({ index, cell: pushedCell });
    }
    commitCells(entries);
  } else {
    showToast('这里放不下：地方不够挤开别的图，换个位置试试');
  }
}

function onPointerMove(event: PointerEvent): void {
  if (boardDrag) onBoardPointerMove(event);
  else if (thumbPress) onThumbPointerMove(event);
}

function onPointerUp(event: PointerEvent): void {
  if (boardDrag) onBoardPointerUp(event);
  if (thumbPress) onThumbPointerUp(event);
}

function renderMood(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-moment-mood]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.momentMood === state.mood));
  }
}

/** 未授权 / 已授权 两种界面 */
function renderGate(): void {
  const gate = $('[data-moment-gate]');
  const form = $('[data-moment-form]');
  const authed = Boolean(getEditSession());
  if (gate) gate.hidden = authed;
  if (form) form.hidden = !authed;
}

/** 把 state 写回表单控件（打开编辑时用） */
function fillForm(): void {
  const text = document.querySelector<HTMLTextAreaElement>('[data-moment-text]');
  if (text) text.value = state.text;

  const location = document.querySelector<HTMLInputElement>('[data-moment-location]');
  if (location) location.value = state.location;

  const tags = document.querySelector<HTMLInputElement>('[data-moment-tags]');
  if (tags) tags.value = state.tags;

  const pinned = document.querySelector<HTMLInputElement>('[data-moment-pinned]');
  if (pinned) pinned.checked = state.pinned;

  renderThumbs();
  renderFiles();
  renderMood();
  renderBoard();

  const title = $('[data-moment-dialog-title]');
  if (title) title.textContent = state.editing ? '编辑动态' : '发布动态';
  const publishLabel = $('[data-moment-publish-label]');
  if (publishLabel) publishLabel.textContent = state.editing ? '保存修改' : '发布';
}

/** 清空草稿（关闭 / 发布成功后调用） */
function resetDraft(): void {
  for (const image of state.images) releasePreview(image);
  cleanupThumbPress();
  thumbPress = null;
  boardDrag = null;
  state.editing = null;
  state.text = '';
  state.images = [];
  state.files = [];
  state.location = '';
  state.tags = '';
  state.mood = '';
  state.pinned = false;
  state.free = false;
  state.removed = [];
  setStatus('');
  fillForm();
}

/* ============================================================
   “加图 / 加附件”
   ============================================================ */

function looksLikeImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i.test(file.name);
}

function addImages(files: File[]): void {
  let added = 0;
  for (const file of files) {
    if (!looksLikeImage(file)) continue;
    if (state.images.length >= MOMENT_MAX_IMAGES) {
      showToast(`最多 ${MOMENT_MAX_IMAGES} 张图片`);
      break;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast(`「${file.name}」太大了（超过 20MB），先压一下`);
      continue;
    }
    state.images.push({
      preview: URL.createObjectURL(file),
      file,
      w: undefined,
      h: undefined,
      revoke: true,
    });
    added += 1;
  }
  if (added) {
    renderThumbs();
    renderBoard();
  }
}

function addFiles(files: File[]): void {
  let added = 0;
  for (const file of files) {
    if (state.files.length >= MOMENT_MAX_FILES) {
      showToast(`最多 ${MOMENT_MAX_FILES} 个附件`);
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast(`「${file.name}」太大了（超过 20MB）`);
      continue;
    }
    state.files.push({ name: file.name, size: file.size, file });
    added += 1;
  }
  if (added) renderFiles();
}

/** 提交失败：令牌过期就顺手清掉，让弹窗退回「授权」那一屏 */
function handleError(error: unknown): void {
  setStatus('');
  if (error instanceof ApiError && error.status === 401) {
    clearEditSession();
    renderGate();
    showToast('写作授权已失效，重新授权后再试');
    return;
  }
  showToast(error instanceof Error ? error.message : '操作失败，请稍后再试');
}

/* ============================================================
   发布 / 保存
   ============================================================ */

function splitTags(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((tag) => tag.replace(/^#+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function publish(): Promise<void> {
  if (state.busy) return;
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }
  if (!state.text.trim() && state.images.length === 0 && state.files.length === 0) {
    showToast('写点什么，或者至少加一张图');
    document.querySelector<HTMLTextAreaElement>('[data-moment-text]')?.focus();
    return;
  }

  state.busy = true;
  const publishBtn = document.querySelector<HTMLButtonElement>('[data-moment-publish]');
  if (publishBtn) publishBtn.disabled = true;

  try {
    const existing = await readMoments();
    const ids = new Set(existing.map((item) => item.id));
    const id = state.editing ?? newMomentId(ids);
    const stamp = Date.now().toString(36);

    const changes: FileChange[] = [];
    const images: MomentImage[] = [];
    const files: MomentFile[] = [];

    // ---- 手动排版：只有画布上真正摆过的图才发，按视觉顺序（上→下、左→右）排 ----
    const useFree = state.free && state.images.length >= FREE_MIN_IMAGES;
    if (useFree && placedCount() < FREE_MIN_IMAGES) {
      showToast('画布上还没有图：先拖一张进去，或者切回自动版式');
      return;
    }

    const ordered = state.images
      .map((image, index) => ({ image, index, cell: useFree ? normalizeCell(image.cell) : null }))
      .filter((entry) => !useFree || entry.cell)
      .sort((a, b) => {
        if (!a.cell || !b.cell) return a.index - b.index;
        return a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0];
      });

    // ---- 图片：老的沿原路径，新的并发压缩后上传 ----
    const pending = ordered.filter((entry) => !entry.image.src && entry.image.file);
    const compressed = new Map<number, CompressedImage>();
    let compressedCount = 0;
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const task = queue.shift();
        if (!task) return;
        const file = task.image.file;
        if (!file) continue;
        compressed.set(task.index, await compressImage(file));
        compressedCount += 1;
        setStatus(`压缩图片 ${compressedCount}/${pending.length}…`);
      }
    });
    await Promise.all(workers);

    let imageIndex = 0;
    for (const entry of ordered) {
      const { image, index, cell } = entry;
      const cellField = cell ? { cell: [...cell] as number[] } : {};

      if (image.src) {
        images.push({ src: image.src, w: image.w, h: image.h, ...cellField });
        continue;
      }

      const result = compressed.get(index);
      if (!result) continue;
      imageIndex += 1;
      const path = `${IMAGE_DIR}/${id}-${stamp}-${imageIndex}.${result.ext}`;
      changes.push({ path, binary: result.buffer });
      images.push({
        src: `/${path.replace(/^public\//, '')}`,
        w: result.w,
        h: result.h,
        ...cellField,
      });
    }

    // ---- 附件：原样上传 ----
    let fileIndex = 0;
    for (const file of state.files) {
      if (file.src) {
        files.push({ src: file.src, name: file.name, size: file.size });
        continue;
      }
      if (!file.file) continue;

      fileIndex += 1;
      setStatus(`上传附件 ${fileIndex}…`);
      const path = `${FILE_DIR}/${id}-${stamp}-${fileIndex}-${safeName(file.name)}`;
      changes.push({ path, binary: await file.file.arrayBuffer() });
      files.push({
        src: `/${path.replace(/^public\//, '')}`,
        name: file.file.name,
        size: file.file.size,
      });
    }

    // ---- 要删掉的旧文件：显式删的 + 手动排版时没排进画布的老图 ----
    const removals = new Set<string>();
    for (const src of state.removed) {
      const path = repoPath(src);
      if (path) removals.add(path);
    }
    const keptSrcs = new Set(images.map((image) => image.src));
    for (const image of state.images) {
      if (!image.src || keptSrcs.has(image.src)) continue;
      const path = repoPath(image.src);
      if (path) removals.add(path);
    }
    for (const path of removals) changes.push({ path, remove: true });

    // ---- 组装这条动态 ----
    const base = existing.find((item) => item.id === id);
    const moment: Moment = {
      id,
      // 编辑时保留原来的发布时间；新建就用「现在」
      time: base?.time ?? nowText(),
      text: state.text.trim(),
      ...(useFree && images.length >= FREE_MIN_IMAGES ? { layout: 'free' as const } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
      ...(state.location.trim() ? { location: state.location.trim() } : {}),
      ...(state.mood ? { mood: state.mood } : {}),
      ...(splitTags(state.tags).length ? { tags: splitTags(state.tags) } : {}),
      ...(state.pinned ? { pinned: true } : {}),
    };

    const next = base
      ? existing.map((item) => (item.id === id ? moment : item))
      : [moment, ...existing];

    changes.push({
      path: MOMENTS_PATH,
      text: `${JSON.stringify(next, null, 2)}\n`,
    });

    setStatus('提交中…');
    await commitFiles(
      changes,
      base ? `moment: 更新动态 ${id}` : `moment: 发布动态 ${id}`,
    );

    setStatus('已提交，等自动部署完成后生效');
    showToast(base ? '已保存，约 1 分钟后生效' : '已发布，约 1 分钟后生效');
    resetDraft();
    closeDialog();
  } catch (error) {
    handleError(error);
  } finally {
    state.busy = false;
    if (publishBtn) publishBtn.disabled = false;
  }
}

/* ============================================================
   编辑 / 删除已有动态
   ============================================================ */

async function startEdit(id: string): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权写作权限');
    return;
  }
  try {
    const list = await readMoments();
    const moment = list.find((item) => item.id === id);
    if (!moment) {
      showToast('找不到这条动态，刷新页面再试');
      return;
    }

    resetDraft();
    state.editing = moment.id;
    state.text = moment.text ?? '';
    state.location = moment.location ?? '';
    state.tags = (moment.tags ?? []).join(', ');
    state.mood = moment.mood ?? '';
    state.pinned = Boolean(moment.pinned);
    // 手动排版的动态：把每张图的格子也读回来，否则编辑一次版式就没了
    state.free = moment.layout === 'free' && (moment.images ?? []).length >= FREE_MIN_IMAGES;
    state.images = (moment.images ?? []).map((image) => ({
      preview: image.src,
      src: image.src,
      w: image.w,
      h: image.h,
      cell: normalizeCell(image.cell) ?? undefined,
    }));
    state.files = (moment.files ?? []).map((file) => ({
      name: file.name,
      size: file.size ?? 0,
      src: file.src,
    }));

    fillForm();
    openDialog();
  } catch (error) {
    handleError(error);
  }
}

async function removeMoment(id: string): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权写作权限');
    return;
  }
  if (!window.confirm('删除这条动态？图片和附件也会一起删掉，提交后约 1 分钟生效。')) return;

  try {
    const existing = await readMoments();
    const moment = existing.find((item) => item.id === id);
    if (!moment) {
      showToast('找不到这条动态，刷新页面再试');
      return;
    }

    const changes: FileChange[] = [];
    for (const image of moment.images ?? []) {
      const path = repoPath(image.src);
      if (path) changes.push({ path, remove: true });
    }
    for (const file of moment.files ?? []) {
      const path = repoPath(file.src);
      if (path) changes.push({ path, remove: true });
    }

    const next = existing.filter((item) => item.id !== id);
    changes.push({ path: MOMENTS_PATH, text: `${JSON.stringify(next, null, 2)}\n` });

    showToast('删除中…');
    await commitFiles(changes, `moment: 删除动态 ${id}`);
    showToast('已删除，约 1 分钟后生效');
  } catch (error) {
    handleError(error);
  }
}

/* ============================================================
   弹窗
   ============================================================ */

function openDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-moment-dialog]');
  if (!dialog) return;
  renderGate();
  if (!dialog.open) dialog.showModal();
}

function closeDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-moment-dialog]');
  if (!dialog?.open) return;
  dialog.close();
}

/* ============================================================
   初始化
   ============================================================ */

/** 全局指针监听只挂一次（换页会换一份 DOM，但 window 只有一个） */
let globalPointerBound = false;

function bindGlobalPointer(): void {
  if (globalPointerBound) return;
  globalPointerBound = true;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  // 拖动期间不许页面跟着滚（触屏上 pointer 事件拦不住原生滚动，只能这样）
  window.addEventListener(
    'touchmove',
    (event) => {
      if (thumbPress?.dragging || boardDrag) event.preventDefault();
    },
    { passive: false },
  );
}

function initComposer(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-moment-dialog]');
  if (!dialog) return;

  // 换页（ClientRouter）后 DOM 是新的，要重新绑；同一份 DOM 只绑一次
  if (dialog.dataset.bound === '1') {
    renderGate();
    return;
  }
  dialog.dataset.bound = '1';

  // 打开
  document.querySelector('[data-moment-compose]')?.addEventListener('click', () => {
    resetDraft();
    openDialog();
  });

  // 关闭 / 取消
  dialog.querySelector('[data-moment-close]')?.addEventListener('click', () => {
    resetDraft();
    closeDialog();
  });
  dialog.querySelector('[data-moment-cancel]')?.addEventListener('click', () => {
    resetDraft();
    closeDialog();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      resetDraft();
      closeDialog();
    }
  });
  dialog.addEventListener('cancel', () => {
    resetDraft();
  });

  // 授权
  dialog.querySelector('[data-moment-login]')?.addEventListener('click', async () => {
    try {
      await openEditLogin();
      renderGate();
      showToast('授权成功，可以发了');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '授权失败');
    }
  });

  // 文字 / 地点 / 话题 / 置顶
  dialog
    .querySelector<HTMLTextAreaElement>('[data-moment-text]')
    ?.addEventListener('input', (event) => {
      state.text = (event.target as HTMLTextAreaElement).value;
    });
  dialog
    .querySelector<HTMLInputElement>('[data-moment-location]')
    ?.addEventListener('input', (event) => {
      state.location = (event.target as HTMLInputElement).value;
    });
  dialog
    .querySelector<HTMLInputElement>('[data-moment-tags]')
    ?.addEventListener('input', (event) => {
      state.tags = (event.target as HTMLInputElement).value;
    });
  dialog
    .querySelector<HTMLInputElement>('[data-moment-pinned]')
    ?.addEventListener('change', (event) => {
      state.pinned = (event.target as HTMLInputElement).checked;
    });

  // 心情：点一下选中，再点一下取消
  for (const btn of dialog.querySelectorAll<HTMLButtonElement>('[data-moment-mood]')) {
    btn.addEventListener('click', () => {
      const mood = btn.dataset.momentMood ?? '';
      state.mood = state.mood === mood ? '' : mood;
      renderMood();
    });
  }

  // 选图片 / 选附件
  const imageInput = dialog.querySelector<HTMLInputElement>('[data-moment-image-input]');
  const fileInput = dialog.querySelector<HTMLInputElement>('[data-moment-file-input]');

  dialog.querySelector('[data-moment-pick-image]')?.addEventListener('click', () => {
    imageInput?.click();
  });
  dialog.querySelector('[data-moment-pick-file]')?.addEventListener('click', () => {
    fileInput?.click();
  });

  imageInput?.addEventListener('change', () => {
    addImages([...(imageInput.files ?? [])]);
    imageInput.value = '';
  });
  fileInput?.addEventListener('change', () => {
    addFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });

  // 移除已选
  dialog.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const removeImage = target.closest<HTMLElement>('[data-remove-image]');
    if (removeImage) {
      const index = Number(removeImage.dataset.removeImage);
      const [removed] = state.images.splice(index, 1);
      if (removed) {
        releasePreview(removed);
        if (removed.src) state.removed.push(removed.src);
      }
      renderThumbs();
      renderBoard();
      return;
    }

    const removeFile = target.closest<HTMLElement>('[data-remove-file]');
    if (removeFile) {
      const index = Number(removeFile.dataset.removeFile);
      const [removed] = state.files.splice(index, 1);
      if (removed?.src) state.removed.push(removed.src);
      renderFiles();
    }
  });

  // 直接粘贴图片
  dialog.addEventListener('paste', (event) => {
    const items = [...(event.clipboardData?.items ?? [])];
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    const images = files.filter((file) => looksLikeImage(file));
    const others = files.filter((file) => !looksLikeImage(file));
    if (images.length) addImages(images);
    if (others.length) addFiles(others);
  });

  // 拖进来
  dialog.addEventListener('dragover', (event) => {
    event.preventDefault();
    dialog.classList.add('is-drag');
  });
  dialog.addEventListener('dragleave', (event) => {
    if (event.target === dialog) dialog.classList.remove('is-drag');
  });
  dialog.addEventListener('drop', (event) => {
    event.preventDefault();
    dialog.classList.remove('is-drag');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    const images = files.filter((file) => looksLikeImage(file));
    const others = files.filter((file) => !looksLikeImage(file));
    if (images.length) addImages(images);
    if (others.length) addFiles(others);
  });

  // 发布
  dialog.querySelector('[data-moment-publish]')?.addEventListener('click', () => {
    void publish();
  });

  // ---- 手动排版：开关 / 推荐版式 / 画布拖动 ----
  dialog.querySelector('[data-moment-board-toggle]')?.addEventListener('click', () => {
    toggleFree();
  });
  dialog.querySelector('[data-moment-board-preset]')?.addEventListener('click', () => {
    if (!state.free) return;
    applyPreset();
    renderBoard();
    renderThumbs();
  });

  const boardItemsLayer = dialog.querySelector<HTMLElement>('[data-moment-board-items]');
  boardItemsLayer?.addEventListener('pointerdown', onBoardPointerDown);
  boardItemsLayer?.addEventListener('click', (event) => {
    const remove = (event.target as HTMLElement).closest<HTMLElement>('[data-board-del]');
    if (!remove) return;
    const index = Number(remove.dataset.boardDel);
    const image = state.images[index];
    if (!image) return;
    image.lastCell = normalizeCell(image.cell) ?? undefined;
    image.cell = undefined;
    renderBoard();
    renderThumbs();
  });

  const thumbLayer = dialog.querySelector<HTMLElement>('[data-moment-thumbs]');
  thumbLayer?.addEventListener('pointerdown', onThumbPointerDown);

  bindGlobalPointer();

  // 卡片上的「编辑 / 删除」（访客看不到，但也不依赖它做鉴权）
  for (const btn of document.querySelectorAll<HTMLElement>('[data-moment-edit]')) {
    if (btn.dataset.bound === '1') continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const card = btn.closest<HTMLElement>('[data-moment]');
      const id = card?.dataset.momentId;
      if (id) void startEdit(id);
    });
  }
  for (const btn of document.querySelectorAll<HTMLElement>('[data-moment-delete]')) {
    if (btn.dataset.bound === '1') continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const card = btn.closest<HTMLElement>('[data-moment]');
      const id = card?.dataset.momentId;
      if (id) void removeMoment(id);
    });
  }

  renderGate();
  fillForm();
}

onEditAuthChange(() => renderGate());

onPageLoad(initComposer);
