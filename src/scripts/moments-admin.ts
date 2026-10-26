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
  MOMENT_MAX_FILES,
  MOMENT_MAX_IMAGES,
  formatFileSize,
  type Moment,
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
    if (index === 0) cell.classList.add('is-cover');

    const img = document.createElement('img');
    img.src = image.preview;
    img.alt = `第 ${index + 1} 张`;
    img.loading = 'lazy';
    img.decoding = 'async';

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

  const title = $('[data-moment-dialog-title]');
  if (title) title.textContent = state.editing ? '编辑动态' : '发布动态';
  const publishLabel = $('[data-moment-publish-label]');
  if (publishLabel) publishLabel.textContent = state.editing ? '保存修改' : '发布';
}

/** 清空草稿（关闭 / 发布成功后调用） */
function resetDraft(): void {
  for (const image of state.images) releasePreview(image);
  state.editing = null;
  state.text = '';
  state.images = [];
  state.files = [];
  state.location = '';
  state.tags = '';
  state.mood = '';
  state.pinned = false;
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
  if (added) renderThumbs();
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

    // ---- 图片：老的沿路径，新的压缩后上传 ----
    const newImages = state.images.filter((image) => image.file && !image.src);
    let imageIndex = 0;
    for (const image of state.images) {
      if (image.src) {
        images.push({ src: image.src, w: image.w, h: image.h });
        continue;
      }
      if (!image.file) continue;

      imageIndex += 1;
      setStatus(`压缩第 ${imageIndex}/${newImages.length} 张图片…`);
      const compressed = await compressImage(image.file);
      const path = `${IMAGE_DIR}/${id}-${stamp}-${imageIndex}.${compressed.ext}`;
      changes.push({ path, binary: compressed.buffer });
      images.push({
        src: `/${path.replace(/^public\//, '')}`,
        w: compressed.w,
        h: compressed.h,
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

    // ---- 编辑时删掉的旧图片 / 旧附件，同一个 commit 里清掉 ----
    for (const src of state.removed) {
      const path = repoPath(src);
      if (path) changes.push({ path, remove: true });
    }

    // ---- 组装这条动态 ----
    const base = existing.find((item) => item.id === id);
    const moment: Moment = {
      id,
      // 编辑时保留原来的发布时间；新建就用「现在」
      time: base?.time ?? nowText(),
      text: state.text.trim(),
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
    state.images = (moment.images ?? []).map((image) => ({
      preview: image.src,
      src: image.src,
      w: image.w,
      h: image.h,
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
