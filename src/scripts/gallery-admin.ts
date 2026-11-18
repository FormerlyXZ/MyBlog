/**
 * 照片墙管理（/config → 照片墙 面板）
 * ============================================================
 * 一份文件管完整件事：config/gallery.json
 *   { settings: {...}, photos: [ { id, src, w, h, title?, tags? } ] }
 *
 * 能做的事：
 *   · 批量上传本地图片（浏览器里压成 WebP 直接进图床 gallery/，一个字节都不进仓库）
 *   · 从图床里挑已有的图（复用 /config 里那个媒体库弹窗）
 *   · 拖拽排序（顺序就是照片海的流动顺序）、单张删除、批量删除
 *   · 批量打标签 / 批量去标签；单张改标题、单独加删标签
 *   · 排版参数（列宽 / 间隙 / 画布比例 / 圆角 / 放大占比 / 周围缩小 / 变暗）实时可调
 *   · 「保存并提交」= 一次 GitHub commit，1 分钟后生效
 *
 * 几个实现上的取舍：
 *   · 图片一律进图床（Cloudflare R2 的 gallery/），JSON 里只留 URL ——
 *     照片几百张时，进仓库会让每次构建都变慢（原方案的 R10 风险）。
 *     想用仓库内路径或外链也行，直接往 JSON 里填（src 字段三种写法都认）。
 *   · 删除照片只从 JSON 里摘掉；图床上的文件在**提交成功之后**才删
 *     （提交失败还能改，先删文件就没得救了）。
 *   · 排序用原生 HTML5 拖放：管理面板只在桌面用，不值得为它写一套指针拖拽。
 * ============================================================
 */

import { onPageLoad } from './pageload';
import { ApiError, clearEditSession, getEditSession, onEditAuthChange, showToast } from '../utils/site';
import { commitFiles, getFile } from '../utils/github';
import { deleteMedia, mediaKeyFromUrl, uploadImage } from '../utils/media';
import { openMediaDialog } from './media-dialog';
import { registerPanelWriter } from './panel-save';
import {
  DEFAULT_SETTINGS,
  GALLERY_PATH,
  RATIO_KEYS,
  SETTING_RANGE,
  aspectOf,
  newPhotoId,
  normalizePhoto,
  normalizeSettings,
  tagList,
  type GalleryPhoto,
  type GallerySettings,
} from '../utils/gallery-shared';

/** 新文件默认带上的说明（保留文件里原有的 _说明 字段） */
const DEFAULT_NOTE =
  '照片墙数据。photos 是扁平图池，每张照片靠 tags 分类；顺序 = 数组顺序（排版从左到右、从上到下流动）。在 /config → 照片墙 里可视化编辑，也可直接改这个文件。src 支持图床地址、仓库内路径（/image/gallery/...）或任意外链；w/h 是照片像素尺寸，排版按它算宽高比。';

interface State {
  settings: GallerySettings;
  photos: GalleryPhoto[];
  picked: Set<string>;
  note: string;
  sha: string | undefined;
  dirty: boolean;
  busy: boolean;
  /** 提交成功之后要删掉的图床 key */
  trash: Set<string>;
}

const state: State = {
  settings: { ...DEFAULT_SETTINGS },
  photos: [],
  picked: new Set(),
  note: DEFAULT_NOTE,
  sha: undefined,
  dirty: false,
  busy: false,
  trash: new Set(),
};

/* ------------------------------------------------------------------ */
/* DOM 小工具                                                          */
/* ------------------------------------------------------------------ */

function root(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-galg-admin]');
}

function q<T extends HTMLElement>(selector: string): T | null {
  return root()?.querySelector<T>(selector) ?? null;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(text: string, kind: 'idle' | 'busy' | 'saved' | 'error' = 'idle'): void {
  const el = q<HTMLElement>('[data-galg-status]');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function markDirty(): void {
  state.dirty = true;
  setStatus('有未保存的改动', 'idle');
  const saveBtn = q<HTMLElement>('[data-galg-save]');
  if (saveBtn) saveBtn.classList.add('is-dirty');
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function buildCard(photo: GalleryPhoto, index: number): HTMLElement {
  const card = document.createElement('article');
  card.className = 'galg-card';
  card.dataset.galgCard = '';
  card.dataset.id = photo.id;
  card.draggable = true;

  const tags = (photo.tags ?? [])
    .map(
      (tag) =>
        `<button type="button" class="galg-tag" data-galg-tagrm="${esc(tag)}" title="移除标签 ${esc(tag)}">${esc(tag)}<span aria-hidden="true">✕</span></button>`,
    )
    .join('');

  const ratio = aspectOf(photo);

  card.innerHTML = `
    <div class="galg-thumb" style="--galg-ratio: ${ratio}">
      <img src="${esc(photo.src)}" alt="" loading="lazy" decoding="async" draggable="false" />
      <label class="galg-pick" title="选中这张">
        <input type="checkbox" data-galg-pick ${state.picked.has(photo.id) ? 'checked' : ''} />
      </label>
      <button type="button" class="galg-remove" data-galg-remove title="删除这张（保存后生效）">✕</button>
      <span class="galg-order">${index + 1}</span>
    </div>
    <input class="galg-title" data-galg-title value="${esc(photo.title ?? '')}" placeholder="标题（可留空）" />
    <div class="galg-tags">
      ${tags}
      <input class="galg-tag-new" data-galg-tagnew placeholder="+ 标签" size="4" />
    </div>
  `;
  return card;
}

function renderSettings(): void {
  for (const key of Object.keys(SETTING_RANGE) as Array<keyof GallerySettings>) {
    const input = q<HTMLInputElement>(`[data-galg-setting="${key}"]`);
    const out = q<HTMLElement>(`[data-galg-out="${key}"]`);
    const value = state.settings[key];
    if (input) input.value = String(value);
    if (out) out.textContent = formatSetting(key, value);
  }
}

function formatSetting(key: keyof GallerySettings, value: number): string {
  if (RATIO_KEYS.has(key)) {
    return `${Math.round(value * 100) / 100}`;
  }
  return `${Math.round(value)} px`;
}

function renderGrid(): void {
  const grid = q<HTMLElement>('[data-galg-grid]');
  if (!grid) return;

  grid.textContent = '';
  if (!state.photos.length) {
    grid.innerHTML = '<p class="galg-empty">还没有照片。点上面的「上传图片」或「从图床选」。</p>';
  } else {
    const frag = document.createDocumentFragment();
    state.photos.forEach((photo, index) => frag.append(buildCard(photo, index)));
    grid.append(frag);
  }

  const count = q<HTMLElement>('[data-galg-count]');
  if (count) {
    const tags = tagList(state.photos).length;
    count.textContent = `${state.photos.length} 张 · ${tags} 个标签`;
  }
  renderPicked();
}

/** 选中状态 / 批量按钮可用性 */
function renderPicked(): void {
  const n = state.picked.size;
  const label = q<HTMLElement>('[data-galg-selected]');
  if (label) label.textContent = n ? `已选 ${n} 张` : '未选中';

  for (const el of root()?.querySelectorAll<HTMLElement>('[data-galg-batch-op]') ?? []) {
    el.toggleAttribute('disabled', n === 0);
  }

  const all = q<HTMLInputElement>('[data-galg-pick-all]');
  if (all) {
    all.checked = state.photos.length > 0 && n === state.photos.length;
    all.indeterminate = n > 0 && n < state.photos.length;
  }
}

function renderAll(): void {
  renderSettings();
  renderGrid();
}

/* ------------------------------------------------------------------ */
/* 读 / 写                                                             */
/* ------------------------------------------------------------------ */

async function load(): Promise<void> {
  if (!getEditSession() || !root()) return;
  state.busy = true;
  setStatus('读取中…', 'busy');
  try {
    const file = await getFile(GALLERY_PATH);
    if (!file) {
      state.sha = undefined;
      state.settings = { ...DEFAULT_SETTINGS };
      state.photos = [];
      state.picked.clear();
      renderAll();
      setStatus('仓库里还没有这个文件，保存时会新建', 'idle');
      return;
    }

    state.sha = file.sha;
    const parsed: unknown = JSON.parse(file.text);
    const data = (parsed && typeof parsed === 'object' ? parsed : {}) as {
      _说明?: unknown;
      settings?: unknown;
      photos?: unknown;
    };

    state.settings = normalizeSettings(data.settings);
    state.note = typeof data._说明 === 'string' && data._说明 ? data._说明 : DEFAULT_NOTE;
    state.photos = (Array.isArray(data.photos) ? data.photos : [])
      .map((photo, index) => normalizePhoto(photo as Partial<GalleryPhoto>, index))
      .filter((photo): photo is GalleryPhoto => photo !== null);
    state.picked.clear();
    state.trash.clear();
    state.dirty = false;
    renderAll();
    setStatus(`已读取 ${state.photos.length} 张照片`, 'saved');
  } catch (error) {
    handleError(error, '读取失败');
  } finally {
    state.busy = false;
  }
}

async function save(): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }
  if (state.busy) return;
  // 没改过就别提交：否则点一下「保存并提交」也会在远端留一个空提交
  if (!state.dirty) {
    setStatus('没有改动', 'idle');
    showToast('照片墙没有改动，不用提交');
    return;
  }
  if (!state.photos.length) {
    showToast('照片池是空的：先传几张，或者确认一下吧');
    return;
  }

  // id 不能重复：重复的话筛选/聚焦会认错人
  const seen = new Set<string>();
  for (const photo of state.photos) {
    if (seen.has(photo.id)) photo.id = newPhotoId();
    seen.add(photo.id);
  }

  state.busy = true;
  setStatus('提交中…', 'busy');
  const saveBtn = q<HTMLButtonElement>('[data-galg-save]');
  if (saveBtn) saveBtn.disabled = true;

  try {
    const payload = {
      _说明: state.note,
      settings: state.settings,
      photos: state.photos.map((photo) => ({
        id: photo.id,
        src: photo.src,
        w: photo.w,
        h: photo.h,
        ...(photo.title ? { title: photo.title } : {}),
        ...(photo.description ? { description: photo.description } : {}),
        ...(photo.tags?.length ? { tags: photo.tags } : {}),
        ...(photo.date ? { date: photo.date } : {}),
      })),
    };

    const result = await commitFiles(
      [{ path: GALLERY_PATH, text: `${JSON.stringify(payload, null, 2)}\n` }],
      `gallery: 更新照片墙（${state.photos.length} 张）`,
    );
    state.sha = result.commitSha;
    state.dirty = false;
    if (saveBtn) saveBtn.classList.remove('is-dirty');

    // 提交成功之后再清图床上的孤儿文件
    const stillUsed = new Set(
      state.photos.map((photo) => mediaKeyFromUrl(photo.src)).filter(Boolean) as string[],
    );
    const trash = [...state.trash].filter((key) => !stillUsed.has(key));
    state.trash.clear();
    if (trash.length) {
      try {
        await deleteMedia(trash);
      } catch {
        /* 删不掉不影响这次提交，图床里多留几个文件而已 */
      }
    }

    setStatus('已提交，约 1 分钟后生效', 'saved');
    showToast(`已提交 ${state.photos.length} 张照片，约 1 分钟后生效`);
  } catch (error) {
    handleError(error, '保存失败');
  } finally {
    state.busy = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

function handleError(error: unknown, fallback: string): void {
  if (error instanceof ApiError && error.status === 401) {
    clearEditSession();
    showToast('写作授权已失效，请在页面顶部重新授权');
    setStatus('授权已失效', 'error');
    return;
  }
  setStatus('', 'idle');
  showToast(error instanceof Error ? error.message : fallback);
}

/* ------------------------------------------------------------------ */
/* 加照片                                                              */
/* ------------------------------------------------------------------ */

/** 当前批量标签输入框里的值（上传时顺手打上） */
function pendingTag(): string {
  return q<HTMLInputElement>('[data-galg-tag-input]')?.value.trim() ?? '';
}

function looksLikeImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i.test(file.name);
}

async function addLocalFiles(files: File[]): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }
  const images = files.filter(looksLikeImage);
  if (!images.length) {
    showToast('只能上传图片');
    return;
  }

  const tag = pendingTag();
  const queue = [...images];
  let done = 0;
  let failed = 0;
  let added = 0;

  const grid = q<HTMLElement>('[data-galg-grid]');
  const empty = grid?.querySelector('.galg-empty');
  empty?.remove();

  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        const result = await uploadImage(file, {
          folder: 'gallery',
          maxSide: 2000,
          quality: 0.88,
          targetBytes: 320 * 1024,
          maxBytes: 1.2 * 1024 * 1024,
        });
        const photo: GalleryPhoto = {
          id: newPhotoId(),
          src: result.url,
          w: result.width,
          h: result.height,
          ...(tag ? { tags: [tag] } : {}),
        };
        state.photos.push(photo);
        added += 1;
        if (grid) grid.append(buildCard(photo, state.photos.length - 1));
      } catch (error) {
        failed += 1;
        showToast(
          error instanceof Error ? `「${file.name}」上传失败：${error.message}` : '上传失败',
        );
      } finally {
        done += 1;
        setStatus(`上传 ${done}/${images.length}…`, 'busy');
      }
    }
  });

  await Promise.all(workers);

  if (added) markDirty();
  renderPicked();
  const count = q<HTMLElement>('[data-galg-count]');
  if (count) count.textContent = `${state.photos.length} 张 · ${tagList(state.photos).length} 个标签`;
  if (!state.photos.length) renderGrid();
  setStatus(
    failed ? `上传完成：成功 ${added}，失败 ${failed}` : `已加入 ${added} 张，记得点「保存并提交」`,
    failed ? 'error' : 'idle',
  );
}

/** 从图床挑图：已经有地址的直接进池子，一个字节都不重新上传 */
async function pickFromLibrary(): Promise<void> {
  const picked = await openMediaDialog({
    mode: 'insert',
    folder: 'gallery',
    hint: '选图床里已有的图片，或者直接在弹窗里上传',
  });
  if (!picked) return;

  const images = picked.files.filter(
    (file) =>
      (file.type || '').startsWith('image/') ||
      /\.(webp|jpe?g|png|gif|avif)$/i.test(file.name),
  );
  if (!images.length) {
    showToast('选中的不是图片');
    return;
  }

  const tag = pendingTag();
  for (const file of images) {
    const size =
      file.width && file.height ? { w: file.width, h: file.height } : await probeSize(file.url);
    state.photos.push({
      id: newPhotoId(),
      src: file.url,
      w: size.w,
      h: size.h,
      ...(tag ? { tags: [tag] } : {}),
    });
  }
  markDirty();
  renderGrid();
  setStatus(`已加入 ${images.length} 张，记得点「保存并提交」`, 'idle');
}

/** 图床列表没带尺寸时（老对象）现场量一下，排版要用 */
function probeSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1200, h: img.naturalHeight || 900 });
    img.onerror = () => resolve({ w: 1200, h: 900 });
    img.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* 单张 / 批量操作                                                      */
/* ------------------------------------------------------------------ */

function findPhoto(id: string): GalleryPhoto | undefined {
  return state.photos.find((photo) => photo.id === id);
}

function removePhotos(ids: Set<string>): void {
  if (!ids.size) return;
  const keep: GalleryPhoto[] = [];
  for (const photo of state.photos) {
    if (!ids.has(photo.id)) {
      keep.push(photo);
      continue;
    }
    // 图床上的文件留到提交成功之后删；仓库内路径 / 外链不动
    const key = mediaKeyFromUrl(photo.src);
    if (key) state.trash.add(key);
  }
  state.photos = keep;
  for (const id of ids) state.picked.delete(id);
}

function addTagTo(ids: Set<string>, tag: string): number {
  const name = tag.trim();
  if (!name || !ids.size) return 0;
  let changed = 0;
  for (const photo of state.photos) {
    if (!ids.has(photo.id)) continue;
    const tags = new Set(photo.tags ?? []);
    if (tags.has(name)) continue;
    tags.add(name);
    photo.tags = [...tags];
    changed += 1;
  }
  return changed;
}

function removeTagFrom(ids: Set<string>, tag: string): number {
  const name = tag.trim();
  if (!name || !ids.size) return 0;
  let changed = 0;
  for (const photo of state.photos) {
    if (!ids.has(photo.id)) continue;
    const before = photo.tags ?? [];
    const after = before.filter((item) => item !== name);
    if (after.length === before.length) continue;
    if (after.length) photo.tags = after;
    else delete photo.tags;
    changed += 1;
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* 拖拽排序                                                            */
/* ------------------------------------------------------------------ */

let dragId: string | null = null;

function commitOrder(): void {
  const grid = q<HTMLElement>('[data-galg-grid]');
  if (!grid) return;
  const order = [...grid.querySelectorAll<HTMLElement>('[data-galg-card]')].map(
    (card) => card.dataset.id ?? '',
  );
  if (order.length !== state.photos.length) return;

  const byId = new Map(state.photos.map((photo) => [photo.id, photo]));
  const next: GalleryPhoto[] = [];
  for (const id of order) {
    const photo = byId.get(id);
    if (photo) next.push(photo);
  }
  if (next.length !== state.photos.length) return;

  const changed = next.some((photo, index) => photo !== state.photos[index]);
  state.photos = next;
  if (changed) markDirty();
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

/**
 * 上一次绑过事件的容器节点。
 *
 * 不能用 `let bound = false` 那种一次性布尔守卫：本站开了 <ClientRouter />，
 * 换页时 DOM 会被替换、而 ES 模块只执行一次，于是「离开 /config 再回来」时
 * init() 会再次跑到这里，却因为 bound 已经是 true 直接早退 ——
 * 新 DOM 一个监听都没有，整栏按钮（上传图片 / 从图床选 / 保存并提交 / 拖拽排序）
 * 全部点不动，看着像「功能坏了」。
 * 所以守的是「绑的是不是现在这个节点」：节点换了就重新绑。
 */
let boundEl: HTMLElement | null = null;

function bind(): void {
  const container = root();
  if (!container || container === boundEl) return;
  boundEl = container;

  /* --- 工具栏 --- */
  container.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest('[data-galg-upload]')) {
      q<HTMLInputElement>('[data-galg-file]')?.click();
      return;
    }
    if (target.closest('[data-galg-library]')) {
      void pickFromLibrary();
      return;
    }
    if (target.closest('[data-galg-save]')) {
      void save();
      return;
    }
    if (target.closest('[data-galg-reload]')) {
      if (state.dirty && !window.confirm('有未保存的改动，确定重新读取吗？')) return;
      void load();
      return;
    }

    /* --- 批量操作 --- */
    if (target.closest('[data-galg-select-all]')) {
      state.picked = new Set(state.photos.map((photo) => photo.id));
      renderGrid();
      return;
    }
    if (target.closest('[data-galg-select-none]')) {
      state.picked.clear();
      renderGrid();
      return;
    }
    if (target.closest('[data-galg-tag-add]') || target.closest('[data-galg-tag-remove]')) {
      const input = q<HTMLInputElement>('[data-galg-tag-input]');
      const tag = input?.value.trim() ?? '';
      if (!tag) {
        showToast('先在输入框里写一个标签');
        input?.focus();
        return;
      }
      if (!state.picked.size) {
        showToast('先选中要打标签的照片');
        return;
      }
      const adding = Boolean(target.closest('[data-galg-tag-add]'));
      const changed = adding
        ? addTagTo(state.picked, tag)
        : removeTagFrom(state.picked, tag);
      if (!changed) {
        showToast(adding ? '这些照片已经有这个标签了' : '这些照片没有这个标签');
        return;
      }
      markDirty();
      renderGrid();
      setStatus(`已${adding ? '加' : '去'}标签「${tag}」：${changed} 张`, 'idle');
      return;
    }
    if (target.closest('[data-galg-batch-del]')) {
      if (!state.picked.size) return;
      const ok = window.confirm(`从照片墙删掉选中的 ${state.picked.size} 张？（保存后生效）`);
      if (!ok) return;
      removePhotos(new Set(state.picked));
      markDirty();
      renderGrid();
      return;
    }

    /* --- 单张 --- */
    const removeBtn = target.closest<HTMLElement>('[data-galg-remove]');
    if (removeBtn) {
      const card = removeBtn.closest<HTMLElement>('[data-galg-card]');
      const id = card?.dataset.id;
      if (id) {
        removePhotos(new Set([id]));
        markDirty();
        renderGrid();
      }
      return;
    }

    const tagRm = target.closest<HTMLElement>('[data-galg-tagrm]');
    if (tagRm) {
      const card = tagRm.closest<HTMLElement>('[data-galg-card]');
      const id = card?.dataset.id;
      const tag = tagRm.dataset.galgTagrm ?? '';
      if (id && tag) {
        removeTagFrom(new Set([id]), tag);
        markDirty();
        renderGrid();
      }
    }
  });

  /* --- 勾选 --- */
  container.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.matches('[data-galg-pick-all]')) {
      state.picked = target.checked
        ? new Set(state.photos.map((photo) => photo.id))
        : new Set();
      renderGrid();
      return;
    }
    if (target.matches('[data-galg-pick]')) {
      const card = target.closest<HTMLElement>('[data-galg-card]');
      const id = card?.dataset.id;
      if (!id) return;
      if (target.checked) state.picked.add(id);
      else state.picked.delete(id);
      renderPicked();
    }
  });

  /* --- 改标题 --- */
  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.matches('[data-galg-title]')) {
      const card = target.closest<HTMLElement>('[data-galg-card]');
      const photo = card?.dataset.id ? findPhoto(card.dataset.id) : undefined;
      if (!photo) return;
      const value = target.value.trim();
      if (value) photo.title = value;
      else delete photo.title;
      markDirty();
      return;
    }

    if (target.matches('[data-galg-setting]')) {
      const key = target.dataset.galgSetting as keyof GallerySettings | undefined;
      if (!key || !(key in SETTING_RANGE)) return;
      const range = SETTING_RANGE[key];
      state.settings[key] = Math.min(range.max, Math.max(range.min, Number(target.value)));
      const out = q<HTMLElement>(`[data-galg-out="${key}"]`);
      if (out) out.textContent = formatSetting(key, state.settings[key]);
      markDirty();
    }
  });

  /* --- 单张加标签（回车） --- */
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.matches('[data-galg-tagnew]')) return;

    event.preventDefault();
    const card = target.closest<HTMLElement>('[data-galg-card]');
    const id = card?.dataset.id;
    const tag = target.value.trim();
    if (!id || !tag) return;
    addTagTo(new Set([id]), tag);
    markDirty();
    renderGrid();
  });

  /* --- 文件选择 --- */
  const fileInput = q<HTMLInputElement>('[data-galg-file]');
  fileInput?.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void addLocalFiles(files);
  });

  /* --- 拖拽排序 --- */
  const grid = q<HTMLElement>('[data-galg-grid]');
  if (grid) {
    grid.addEventListener('dragstart', (event) => {
      const card = (event.target as Element | null)?.closest<HTMLElement>('[data-galg-card]');
      if (!card) return;
      dragId = card.dataset.id ?? null;
      card.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragId ?? '');
      }
    });

    const clearDrag = (): void => {
      dragId = null;
      for (const card of grid.querySelectorAll('.is-dragging')) card.classList.remove('is-dragging');
    };

    grid.addEventListener('dragend', () => {
      clearDrag();
      commitOrder();
    });

    grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (!dragId) return;
      const card = (event.target as Element | null)?.closest<HTMLElement>('[data-galg-card]');
      if (!card || card.dataset.id === dragId) return;

      const dragged = grid.querySelector<HTMLElement>(
        `[data-galg-card][data-id="${CSS.escape(dragId)}"]`,
      );
      if (!dragged) return;

      const rect = card.getBoundingClientRect();
      const after = event.clientX - rect.left > rect.width / 2;
      card.parentNode?.insertBefore(dragged, after ? card.nextSibling : card);
    });

    grid.addEventListener('drop', (event) => {
      event.preventDefault();
      clearDrag();
      commitOrder();
    });
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function init(): void {
  const container = root();
  if (!container) return;
  bind();
  if (getEditSession()) {
    void load();
  } else {
    renderAll();
    setStatus('等待授权…', 'idle');
  }
}

onEditAuthChange(() => {
  if (getEditSession()) void load();
});

onPageLoad(init);

/** 顶栏那颗保存按钮切到这一栏时，交给这里 —— 写的是 config/gallery.json */
registerPanelWriter('gallery', {
  label: '照片墙',
  save,
  isDirty: () => state.dirty,
});
