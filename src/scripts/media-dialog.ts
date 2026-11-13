/**
 * 媒体库（图床）面板逻辑
 * ============================================================
 * 一套代码装在两个地方：
 *   · <MediaDialog /> —— 编辑器里弹出来的选图窗（pick / insert / manage）
 *   · /media/ 独立页 —— 完整管理台，多一列分类侧栏
 *
 * 能做的事：
 *   上传（拖放 / 粘贴 / 选择，可选压缩、可选画质）
 *   浏览（面包屑 + 分类侧栏 + 筛选 + 分页）
 *   管理（新建 / 改名 / 删除 文件夹与文件，复制链接，大图预览，批量操作）
 *
 * 目录是虚拟的：R2 的 key 里带 / 就等于目录，建空目录写一个 0 字节占位。
 * 所有写操作都要站长令牌，Worker 再验一次 OWNER_LOGINS。
 * ============================================================
 */

import { getEditSession, openEditLogin, showToast } from '../utils/site';
import { describeCompression, formatBytes } from '../utils/imaging';
import {
  MEDIA_FOLDERS,
  createFolder,
  deleteFolder,
  deleteMedia,
  listMedia,
  mediaStats,
  mediaUrl,
  moveMedia,
  renameFolder,
  uploadFile,
  uploadImage,
  type MediaFile,
  type MediaStats,
  type UploadProgress,
} from '../utils/media';

/* ============================================================
   对外接口
   ============================================================ */

export type MediaMode = 'pick' | 'insert' | 'manage';

export interface MediaDialogOptions {
  mode?: MediaMode;
  /** 打开时进到哪个目录，如 'posts'；留空进根目录 */
  folder?: string;
  /** 最多选几个（pick 默认 1，insert 默认 0 = 不限） */
  maxSelect?: number;
  /** 状态栏里的提示语 */
  hint?: string;
  /** 标题栏文字，默认「媒体库」 */
  title?: string;
}

export interface MediaPick {
  files: MediaFile[];
  /** 和 files 一一对应的公网地址 */
  urls: string[];
  /** 第一个的地址（选一张时直接用这个） */
  url: string;
}

/** 画质档位：决定压缩的长边、质量、目标体积 */
const QUALITY_PRESETS = {
  high: { maxSide: 3200, quality: 0.9, targetBytes: 700 * 1024, maxBytes: 3 * 1024 * 1024 },
  standard: { maxSide: 2560, quality: 0.8, targetBytes: 320 * 1024, maxBytes: 1.5 * 1024 * 1024 },
  tiny: { maxSide: 1920, quality: 0.68, targetBytes: 120 * 1024, maxBytes: 500 * 1024 },
} as const;

type QualityKey = keyof typeof QUALITY_PRESETS;

/** 记住上次的上传选项，下次打开不用重设 */
const PREFS_KEY = 'melodyxz-media-prefs';

interface Prefs {
  compress: boolean;
  quality: QualityKey;
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Partial<Prefs>;
      const quality: QualityKey =
        data.quality && data.quality in QUALITY_PRESETS ? data.quality : 'standard';
      return { compress: data.compress !== false, quality };
    }
  } catch {
    /* 忽略 */
  }
  return { compress: true, quality: 'standard' };
}

function writePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略 */
  }
}

/* ============================================================
   状态
   ============================================================ */

interface State {
  mode: MediaMode;
  maxSelect: number;
  /** 当前目录前缀，不带结尾斜杠；'' = 根目录 */
  folder: string;
  files: MediaFile[];
  folders: { name: string; prefix: string }[];
  cursor: string | null;
  /** 已选 key，按点选顺序排列（插入正文时保持这个顺序） */
  selected: string[];
  search: string;
  prefs: Prefs;
  loading: boolean;
  busy: boolean;
  uploading: boolean;
  stats: MediaStats | null;
  hint: string;
  /** 预览当前看的是第几个（在 state.files 里的下标） */
  previewIndex: number;
}

const state: State = {
  mode: 'manage',
  maxSelect: 0,
  folder: '',
  files: [],
  folders: [],
  cursor: null,
  selected: [],
  search: '',
  prefs: readPrefs(),
  loading: false,
  busy: false,
  uploading: false,
  stats: null,
  hint: '',
  previewIndex: -1,
};

/** 当前打开的弹窗在 await 什么：关窗时给它 null */
let settle: ((value: MediaPick | null) => void) | null = null;

/* ============================================================
   DOM 小工具
   ============================================================ */

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-media-root]');
}

/** 先在本面板里找，找不到再退回整个文档（dialog 元素本身在面板外面） */
function $<T extends HTMLElement>(selector: string): T | null {
  return (panel()?.querySelector<T>(selector) ?? document.querySelector<T>(selector)) as T | null;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 图标仓库：从 <template data-media-icons> 里克隆，和静态图标同源 */
let iconCache: Map<string, string> | null = null;

function icon(name: string): HTMLElement {
  if (!iconCache) {
    iconCache = new Map();
    const template = document.querySelector<HTMLTemplateElement>('template[data-media-icons]');
    if (template) {
      for (const span of template.content.querySelectorAll<HTMLElement>('[data-icon]')) {
        const key = span.dataset.icon;
        if (key) iconCache.set(key, span.innerHTML);
      }
    }
  }
  const span = h('span', 'inline-flex shrink-0 items-center justify-center');
  span.innerHTML = iconCache.get(name) ?? '';
  return span;
}

/* ============================================================
   渲染：状态条
   ============================================================ */

function setStatus(text: string): void {
  const node = $('[data-media-status]');
  if (node) node.textContent = text;
}

function isImage(file: MediaFile): boolean {
  if (file.type) return file.type.startsWith('image/');
  return /\.(webp|jpe?g|png|gif|avif|svg|bmp)$/i.test(file.name);
}

/* ============================================================
   渲染：面包屑
   ============================================================ */

function renderCrumbs(): void {
  const nav = $('[data-media-crumbs]');
  if (!nav) return;
  nav.replaceChildren();

  const segments = state.folder ? state.folder.split('/') : [];

  const crumb = (label: string, target: string, isLast: boolean): HTMLElement => {
    const button = h('button', 'btn-pill flex-none px-2.5 py-1 text-[0.6875rem]', label);
    button.type = 'button';
    if (isLast) button.classList.add('btn-pill--active');
    button.addEventListener('click', () => void goTo(target));
    return button;
  };

  nav.append(crumb('全部', '', segments.length === 0));

  let path = '';
  segments.forEach((segment, index) => {
    const chevron = h('span', 'flex-none text-base-content/25');
    chevron.append(icon('chevron'));
    nav.append(chevron);

    path = path ? `${path}/${segment}` : segment;
    nav.append(crumb(segment, path, index === segments.length - 1));
  });
}

/* ============================================================
   渲染：分类侧栏（只有独立页才有）
   ============================================================ */

function renderSide(): void {
  const side = $('[data-media-side]');
  if (!side) return;
  side.replaceChildren();

  const counts = new Map<string, number>();
  for (const folder of state.stats?.folders ?? []) counts.set(folder.name, folder.files);

  const heading = h('p', 'px-2 py-1 text-[0.625rem] font-bold tracking-wide text-base-content/35 uppercase', '分类');
  side.append(heading);

  const item = (
    label: string,
    prefix: string,
    count: number,
    options: { hint?: string; dimmed?: boolean; manageable?: boolean } = {},
  ): HTMLElement => {
    const row = h('div', 'media-side__row group');
    const button = h('button', 'media-side__item');
    button.type = 'button';
    if (prefix === state.folder) button.classList.add('is-active');
    if (options.dimmed) button.classList.add('is-dim');
    if (options.hint) button.title = options.hint;

    button.append(icon(prefix ? 'folderOpen' : 'folder'));
    button.append(h('span', 'min-w-0 flex-1 truncate text-left', label));
    button.append(h('span', 'flex-none text-[0.625rem] tabular-nums opacity-55', String(count)));
    button.addEventListener('click', () => void goTo(prefix));

    row.append(button);

    // 一级目录才给改名 / 删除（子目录在面包屑里点进去后同样能操作）
    if (options.manageable) {
      const ops = h('span', 'media-side__ops');
      const rename = h('button', 'media-op h-5 w-5');
      rename.type = 'button';
      rename.title = '重命名分类';
      rename.setAttribute('aria-label', '重命名分类');
      rename.append(icon('rename'));
      rename.addEventListener('click', (event) => {
        event.stopPropagation();
        askRenameFolder(prefix);
      });

      const remove = h('button', 'media-op media-op--danger h-5 w-5');
      remove.type = 'button';
      remove.title = '删除分类（连同里面的文件）';
      remove.setAttribute('aria-label', '删除分类');
      remove.append(icon('trash'));
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        void askDeleteFolder(prefix);
      });

      ops.append(rename, remove);
      row.append(ops);
    }

    return row;
  };

  const total = state.stats?.files ?? 0;
  side.append(item('全部文件', '', total, { hint: '图床里的所有文件' }));

  const known = new Set<string>();
  for (const [name] of counts) {
    if (!name) continue;
    known.add(name);
    side.append(item(name, name, counts.get(name) ?? 0, { manageable: true }));
  }

  // 预设分类：还没建出来的也显示成「0」，让人知道该往哪传
  const presets = MEDIA_FOLDERS.filter((folder) => !known.has(folder.key));
  if (presets.length) {
    side.append(
      h('p', 'mt-2 px-2 py-1 text-[0.625rem] font-bold tracking-wide text-base-content/35 uppercase', '推荐分类'),
    );
    for (const preset of presets) {
      side.append(item(preset.key, preset.key, 0, { hint: preset.hint, dimmed: true }));
    }
  }
}

/* ============================================================
   渲染：用量
   ============================================================ */

function renderUsage(): void {
  const text = $('[data-media-usage]');
  const bar = $<HTMLElement>('[data-media-usage-bar]');
  if (!state.stats) {
    if (text) text.textContent = '用量统计中…';
    if (bar) bar.style.width = '0%';
    return;
  }

  const { bytes, files, byType, quotaBytes } = state.stats;
  const ratio = quotaBytes > 0 ? Math.min(1, bytes / quotaBytes) : 0;
  if (bar) {
    bar.style.width = `${(ratio * 100).toFixed(2)}%`;
    bar.classList.toggle('bg-primary/70', ratio < 0.85);
    bar.classList.toggle('bg-error/70', ratio >= 0.85);
  }
  if (text) {
    text.textContent =
      `已用 ${formatBytes(bytes)} / ${formatBytes(quotaBytes)} · ${files} 个文件` +
      `（图片 ${byType.image} · 音频 ${byType.audio} · 视频 ${byType.video} · 其它 ${byType.other}）`;
  }
}

/* ============================================================
   渲染：底栏选中态
   ============================================================ */

function renderSelection(): void {
  const label = $('[data-media-selected]');
  if (label) {
    if (!state.selected.length) {
      label.textContent = state.hint || '未选择';
    } else if (state.selected.length === 1) {
      const file = state.files.find((item) => item.key === state.selected[0]);
      label.textContent = `已选 1 个：${file?.name ?? state.selected[0]}`;
    } else {
      label.textContent = `已选 ${state.selected.length} 个`;
    }
  }

  const empty = state.selected.length === 0;
  for (const selector of ['[data-media-act="copy"]', '[data-media-act="delete"]', '[data-media-act="cover"]', '[data-media-act="confirm"]']) {
    const button = $<HTMLButtonElement>(selector);
    if (button) button.disabled = empty;
  }
}

/* ============================================================
   渲染：网格
   ============================================================ */

function renderGrid(): void {
  const grid = $('[data-media-grid]');
  const empty = $('[data-media-empty]');
  const more = $('[data-media-more]');
  if (!grid) return;

  grid.replaceChildren();

  const keyword = state.search.trim().toLowerCase();
  const folders = keyword
    ? state.folders.filter((folder) => folder.name.toLowerCase().includes(keyword))
    : state.folders;
  const files = keyword
    ? state.files.filter((file) => file.name.toLowerCase().includes(keyword))
    : state.files;

  for (const folder of folders) grid.append(renderFolderTile(folder.name, folder.prefix));
  for (const file of files) grid.append(renderFileTile(file));

  const total = folders.length + files.length;
  if (empty) {
    empty.classList.toggle('hidden', total > 0);
    empty.classList.toggle('flex', total === 0);
  }
  const title = $('[data-media-empty-title]');
  if (title) title.textContent = keyword ? '没有匹配的文件' : '这个目录还是空的';

  if (more) {
    more.classList.toggle('hidden', !state.cursor || Boolean(keyword));
    more.classList.toggle('flex', Boolean(state.cursor) && !keyword);
  }

  renderSelection();
}

function renderFolderTile(name: string, prefix: string): HTMLElement {
  const tile = h('button', 'media-folder media-tile text-left');
  tile.type = 'button';
  tile.title = prefix;

  const face = h('span', 'media-folder__face');
  face.append(icon('folder'));

  tile.append(face, h('span', 'truncate px-0.5 text-[0.6875rem] font-medium text-base-content/70', name));
  tile.addEventListener('click', () => void goTo(prefix.replace(/\/$/, '')));
  return tile;
}

function renderFileTile(file: MediaFile): HTMLElement {
  const tile = h('figure', 'media-tile');
  tile.dataset.key = file.key;
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-selected', state.selected.includes(file.key) ? 'true' : 'false');
  tile.title = `${file.key}\n${formatBytes(file.size)}`;

  /* --- 缩略图 --- */
  const thumb = h('span', 'media-tile__thumb');
  if (isImage(file)) {
    const img = h('img');
    img.src = file.url;
    img.alt = file.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    thumb.append(img);
  } else {
    const ext = (file.name.split('.').pop() || '?').toUpperCase().slice(0, 4);
    thumb.append(h('span', 'grid h-full w-full place-items-center text-xs font-bold text-primary/70', ext));
  }

  const check = h('span', 'media-tile__check');
  check.append(icon('check'));
  thumb.append(check);

  /* --- 悬浮操作：预览 / 复制链接 / 改名 / 删除 --- */
  const ops = h('span', 'media-tile__ops');
  const op = (
    name: string,
    iconName: string,
    label: string,
    handler: () => void,
    danger = false,
  ): HTMLButtonElement => {
    const button = h('button', `media-op${danger ? ' media-op--danger' : ''}`);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(icon(iconName));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  };

  const fileIndex = state.files.indexOf(file);
  ops.append(
    op('preview', 'zoom', '预览大图', () => openPreview(fileIndex)),
    op('copy', 'link', '复制链接', () => void copyUrls([file.url])),
    op('rename', 'rename', '重命名', () => askRenameFile(file)),
    op('delete', 'trash', '删除', () => void removeFiles([file.key], file.name), true),
  );
  thumb.append(ops);

  tile.append(
    thumb,
    h('span', 'truncate px-0.5 text-[0.6875rem] font-medium text-base-content/70', file.name),
    h('span', 'px-0.5 text-[0.625rem] text-base-content/40', formatBytes(file.size)),
  );

  tile.addEventListener('click', () => toggleSelect(file.key));
  tile.addEventListener('dblclick', () => {
    // 选图场景双击 = 选中并直接确认；管理场景双击 = 看大图
    if (state.mode === 'manage') {
      openPreview(fileIndex);
      return;
    }
    toggleSelect(file.key, true);
    void confirmPick();
  });
  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleSelect(file.key);
    }
  });

  return tile;
}

function paintSelection(): void {
  const grid = $('[data-media-grid]');
  if (grid) {
    for (const tile of grid.querySelectorAll<HTMLElement>('.media-tile[data-key]')) {
      const key = tile.dataset.key ?? '';
      tile.setAttribute('aria-selected', state.selected.includes(key) ? 'true' : 'false');
    }
  }
  renderSelection();
}

/* ============================================================
   预览大图
   ============================================================ */

function openPreview(index: number): void {
  if (index < 0 || index >= state.files.length) return;
  state.previewIndex = index;
  const file = state.files[index];
  const box = $<HTMLElement>('[data-media-preview]');
  const img = $<HTMLImageElement>('[data-media-preview-img]');
  const name = $('[data-media-preview-name]');
  const meta = $('[data-media-preview-meta]');
  if (!box || !img) return;

  img.src = file.url;
  img.alt = file.name;
  if (name) name.textContent = file.name;
  if (meta) {
    const parts = [formatBytes(file.size)];
    if (file.type) parts.push(file.type.split('/')[1]?.toUpperCase() ?? '');
    parts.push(file.key);
    meta.textContent = parts.filter(Boolean).join(' · ');
  }
  box.classList.remove('hidden');
  box.classList.add('flex');

  const prev = $<HTMLElement>('[data-media-preview-prev]');
  const next = $<HTMLElement>('[data-media-preview-next]');
  if (prev) prev.style.visibility = index > 0 ? 'visible' : 'hidden';
  if (next) next.style.visibility = index < state.files.length - 1 ? 'visible' : 'hidden';
}

function closePreview(): void {
  const box = $<HTMLElement>('[data-media-preview]');
  if (box) {
    box.classList.add('hidden');
    box.classList.remove('flex');
  }
  state.previewIndex = -1;
}

function stepPreview(delta: number): void {
  const next = state.previewIndex + delta;
  if (next < 0 || next >= state.files.length) return;
  openPreview(next);
}

/* ============================================================
   选择
   ============================================================ */

function toggleSelect(key: string, onlyKey = false): void {
  if (onlyKey) {
    state.selected = [key];
    paintSelection();
    return;
  }

  const index = state.selected.indexOf(key);
  if (index !== -1) {
    state.selected.splice(index, 1);
  } else {
    // pick 模式和设了上限的场景：选新的就顶掉最老的
    const limit = state.mode === 'pick' ? 1 : state.maxSelect;
    if (limit > 0 && state.selected.length >= limit) {
      state.selected = limit === 1 ? [key] : [...state.selected.slice(1), key];
    } else {
      state.selected.push(key);
    }
  }
  paintSelection();
}

function selectedFiles(): MediaFile[] {
  return state.selected
    .map((key) => state.files.find((file) => file.key === key))
    .filter((file): file is MediaFile => Boolean(file));
}

/* ============================================================
   加载
   ============================================================ */

async function loadListing(options: { append?: boolean } = {}): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  setStatus('读取目录…');
  try {
    const cursor = options.append ? state.cursor ?? undefined : undefined;
    const listing = await listMedia(state.folder, cursor);
    if (options.append) {
      state.files = [...state.files, ...listing.files];
      state.folders = [...state.folders, ...listing.folders];
    } else {
      state.files = listing.files;
      state.folders = listing.folders;
      // 换目录了，之前选中的东西已经不在这里，清掉免得删错
      state.selected = state.selected.filter((key) => state.files.some((file) => file.key === key));
    }
    state.cursor = listing.cursor;
    renderCrumbs();
    renderSide();
    renderGrid();
    setStatus('');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '读取图床失败');
  } finally {
    state.loading = false;
  }
}

async function loadStats(): Promise<void> {
  try {
    state.stats = await mediaStats();
  } catch {
    state.stats = null;
  }
  renderUsage();
  renderSide();
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadListing(), loadStats()]);
}

async function goTo(prefix: string): Promise<void> {
  state.folder = prefix.replace(/^\/+|\/+$/g, '');
  state.cursor = null;
  state.search = '';
  const search = $<HTMLInputElement>('[data-media-search]');
  if (search) search.value = '';
  hideInputRow();
  closePreview();
  await loadListing();
}

/* ============================================================
   上传
   ============================================================ */

async function handleFiles(fileList: FileList | File[]): Promise<void> {
  if (state.uploading || state.busy) return;
  const files = Array.from(fileList);
  if (!files.length) return;

  // 整批进同一个目录：当前在子目录就传这里，在根目录就按内容挑 posts / files。
  // 一批文件散到两个目录里对使用者来说太莫名其妙了。
  const hasImage = files.some((file) => file.type.startsWith('image/'));
  const target = state.folder || (hasImage ? 'posts' : 'files');

  state.uploading = true;
  const uploaded: MediaFile[] = [];
  let finished = 0;

  /**
   * 并发上传。
   * 从国内往 Cloudflare 传是「按连接掐」的（单条 20–30KB/s），
   * 所以 2–3 路一起传能明显缩短一批图的总时间；再多也没用，反而都变慢。
   */
  const CONCURRENCY = Math.min(3, files.length);
  const queue = files.map((file, index) => ({ file, index }));
  const progress = new Map<number, number>();

  const report = (label: string): void => {
    setStatus(`上传中 ${finished}/${files.length} · ${label}`);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      const { file, index } = task;

      const onProgress = (info: UploadProgress): void => {
        progress.set(index, info.percent ?? 0);
        const percents = [...progress.values()];
        const average = Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length);
        report(`${average}% · ${file.name}`);
      };

      try {
        if (state.prefs.compress && file.type.startsWith('image/')) {
          const result = await uploadImage(file, {
            folder: target,
            ...QUALITY_PRESETS[state.prefs.quality],
            onProgress,
          });
          uploaded.push({
            key: result.key,
            name: result.key.split('/').pop() ?? result.key,
            url: result.url,
            size: result.size,
            uploaded: new Date().toISOString(),
            type: result.type,
            width: result.width,
            height: result.height,
          });
          if (result.recompressed) {
            setStatus(`${file.name} · ${describeCompression(result)}`);
          }
        } else {
          const result = await uploadFile(file, { folder: target, onProgress });
          uploaded.push({
            key: result.key,
            name: result.key.split('/').pop() ?? result.key,
            url: result.url,
            size: result.size,
            uploaded: new Date().toISOString(),
            type: result.type,
          });
        }
      } catch (error) {
        showToast(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`);
      } finally {
        finished += 1;
        progress.delete(index);
        report('');
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } finally {
    state.uploading = false;
  }

  if (!uploaded.length) {
    setStatus('');
    return;
  }

  // 传完自动选中新文件：选图场景直接变成「可以用这张了」
  state.selected = uploaded.map((file) => file.key);
  if (state.folder !== target) {
    // 在根目录传的图跑进了分类里，直接跟过去，别让人对着空目录发呆
    await goTo(target);
    state.selected = uploaded.map((file) => file.key);
    paintSelection();
  } else {
    await refreshAll();
  }
  setStatus(`已上传 ${uploaded.length} 个文件 → ${target}/`);
  showToast(`已上传 ${uploaded.length} 个文件`);
}

/* ============================================================
   文件 / 目录操作
   ============================================================ */

function folderOf(key: string): string {
  const index = key.lastIndexOf('/');
  return index === -1 ? '' : key.slice(0, index);
}

function askRenameFile(file: MediaFile): void {
  showInputRow({
    label: '重命名',
    value: file.name,
    submit: async (value) => {
      const next = value.trim().replace(/^\/+/g, '');
      if (!next) throw new Error('文件名不能为空');
      if (next === file.name) {
        hideInputRow();
        return;
      }
      const dir = folderOf(file.key);
      const target = dir ? `${dir}/${next}` : next;
      state.busy = true;
      setStatus('重命名中…');
      try {
        await moveMedia(file.key, target);
        hideInputRow();
        showToast('已重命名');
        await refreshAll();
      } finally {
        state.busy = false;
        setStatus('');
      }
    },
  });
}

function askRenameFolder(prefix: string): void {
  const parent = folderOf(prefix);
  showInputRow({
    label: '重命名分类',
    value: prefix.slice(parent ? parent.length + 1 : 0),
    submit: async (value) => {
      const name = value.trim().replace(/^\/+|\/+$/g, '');
      if (!name) throw new Error('分类名不能为空');
      const target = parent ? `${parent}/${name}` : name;
      if (target === prefix) {
        hideInputRow();
        return;
      }
      state.busy = true;
      setStatus('搬文件中…');
      try {
        const result = await renameFolder(prefix, target);
        hideInputRow();
        showToast(`已改名，搬了 ${result.moved}/${result.total} 个对象`);
        if (state.folder === prefix || state.folder.startsWith(`${prefix}/`)) {
          state.folder = state.folder.replace(prefix, target);
        }
        await refreshAll();
      } finally {
        state.busy = false;
        setStatus('');
      }
    },
  });
}

async function askDeleteFolder(prefix: string): Promise<void> {
  const count = state.stats?.folders.find((folder) => folder.name === prefix)?.files ?? 0;
  const ok = window.confirm(
    `删除分类「${prefix}」？\n\n` +
      `里面的${count > 0 ? `${count} 个` : ''}文件会一起删掉，不能撤销。\n` +
      `已经引用这些文件的文章会出现裂图。\n\n` +
      `只想清空内容、保留分类的话，进去把文件一个个删掉就行。`,
  );
  if (!ok) return;

  state.busy = true;
  setStatus('删除分类中…');
  try {
    const deleted = await deleteFolder(prefix);
    showToast(`已删除分类 ${prefix}（${deleted} 个文件）`);
    if (state.folder === prefix || state.folder.startsWith(`${prefix}/`)) {
      state.folder = '';
    }
    await refreshAll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除分类失败');
  } finally {
    state.busy = false;
    setStatus('');
  }
}

async function removeFiles(keys: string[], name: string): Promise<void> {
  const what = keys.length === 1 ? name : `${keys.length} 个文件`;
  const ok = window.confirm(
    `删除${what}？这个操作不能撤销。\n\n注意：已经引用它的文章会出现裂图。`,
  );
  if (!ok) return;

  state.busy = true;
  setStatus('删除中…');
  try {
    const deleted = await deleteMedia(keys);
    state.selected = state.selected.filter((key) => !keys.includes(key));
    closePreview();
    showToast(`已删除 ${deleted} 个文件`);
    await refreshAll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除失败');
  } finally {
    state.busy = false;
    setStatus('');
  }
}

async function copyUrls(urls: string[]): Promise<void> {
  if (!urls.length) return;
  const text = urls.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(urls.length === 1 ? '链接已复制' : `已复制 ${urls.length} 个链接`);
    return;
  } catch {
    /* 剪贴板被拒（非 https / 用户拒绝）→ 退回老办法 */
  }
  const area = h('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    document.execCommand('copy');
    showToast('链接已复制');
  } catch {
    showToast('复制失败，请手动选中链接');
  }
  area.remove();
}

/* ============================================================
   输入行（新建文件夹 / 重命名共用）
   ============================================================ */

interface InputRowOptions {
  label: string;
  value?: string;
  placeholder?: string;
  submit: (value: string) => Promise<void>;
}

let inputRowSubmit: ((value: string) => Promise<void>) | null = null;

function showInputRow(options: InputRowOptions): void {
  const row = $<HTMLFormElement>('[data-media-input-row]');
  const label = $('[data-media-input-label]');
  const field = $<HTMLInputElement>('[data-media-input-field]');
  if (!row || !label || !field) return;

  label.textContent = options.label;
  field.value = options.value ?? '';
  field.placeholder = options.placeholder ?? '';
  row.classList.remove('hidden');
  row.classList.add('flex');

  inputRowSubmit = options.submit;
  field.focus();
  field.select();
}

function hideInputRow(): void {
  const row = $<HTMLFormElement>('[data-media-input-row]');
  const field = $<HTMLInputElement>('[data-media-input-field]');
  if (row) {
    row.classList.add('hidden');
    row.classList.remove('flex');
  }
  if (field) field.value = '';
  inputRowSubmit = null;
}

/* ============================================================
   模式 / 打开 / 关闭
   ============================================================ */

function applyMode(): void {
  const cover = $<HTMLButtonElement>('[data-media-act="cover"]');
  const confirm = $<HTMLButtonElement>('[data-media-act="confirm"]');

  if (confirm) {
    const show = state.mode !== 'manage';
    confirm.classList.toggle('hidden', !show);
    confirm.classList.toggle('inline-flex', show);
    const span = confirm.querySelector('span');
    if (span) span.textContent = state.mode === 'pick' ? '用这张' : '插入正文';
  }
  if (cover) {
    const show = state.mode === 'pick';
    cover.classList.toggle('hidden', !show);
    cover.classList.toggle('inline-flex', show);
  }
}

export async function openMediaDialog(options: MediaDialogOptions = {}): Promise<MediaPick | null> {
  const dialog = document.querySelector<HTMLDialogElement>('[data-media-dialog]');
  if (!dialog) {
    showToast('页面里没有媒体库组件（缺少 <MediaDialog />）');
    return null;
  }

  bindOnce();

  state.mode = options.mode ?? 'manage';
  state.maxSelect = options.maxSelect ?? (state.mode === 'pick' ? 1 : 0);
  state.hint = options.hint ?? '';
  state.folder = (options.folder ?? '').replace(/^\/+|\/+$/g, '');
  state.selected = [];
  state.search = '';
  state.cursor = null;
  state.files = [];
  state.folders = [];

  const title = $('[data-media-title]');
  if (title) {
    title.textContent =
      options.title ??
      (state.mode === 'pick' ? '选一张图' : state.mode === 'insert' ? '插入图片 / 文件' : '媒体库');
  }

  const search = $<HTMLInputElement>('[data-media-search]');
  if (search) search.value = '';
  hideInputRow();
  closePreview();
  applyMode();
  renderCrumbs();
  renderGrid();
  renderSelection();

  const compressBox = $<HTMLInputElement>('[data-media-compress]');
  if (compressBox) compressBox.checked = state.prefs.compress;
  const qualitySelect = $<HTMLSelectElement>('[data-media-quality]');
  if (qualitySelect) qualitySelect.value = state.prefs.quality;
  syncQualityUi();

  if (!dialog.open) dialog.showModal();
  void refreshAll();

  return new Promise<MediaPick | null>((resolve) => {
    settle = resolve;
  });
}

function closeWith(value: MediaPick | null): void {
  // 先把 settle 摘下来再关窗：dialog.close() 会派发 close 事件，
  // 那个监听里还会再看一眼 settle，摘晚了就会先被 resolve 成 null。
  const resolve = settle;
  settle = null;
  const dialog = document.querySelector<HTMLDialogElement>('[data-media-dialog]');
  if (dialog?.open) dialog.close();
  resolve?.(value);
}

async function confirmPick(): Promise<void> {
  const files = selectedFiles();
  if (!files.length) {
    showToast('先选一个文件');
    return;
  }
  closeWith({ files, urls: files.map((file) => file.url), url: files[0].url });
}

/* ============================================================
   事件绑定（只绑一次）
   ============================================================ */

function bindOnce(): void {
  const root = panel();
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';

  const dialog = document.querySelector<HTMLDialogElement>('[data-media-dialog]');
  if (dialog && dialog.dataset.bound !== '1') {
    dialog.dataset.bound = '1';
    dialog.addEventListener('close', () => {
      const resolve = settle;
      settle = null;
      resolve?.(null);
    });
    // 点 backdrop 关窗（点在 dialog 元素本身上就是 backdrop）
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeWith(null);
    });
    dialog.addEventListener('paste', (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        event.preventDefault();
        void handleFiles(files);
      }
    });
  }

  $('[data-media-close]')?.addEventListener('click', () => closeWith(null));

  /* ---- 工具条 ---- */
  $('[data-media-upload]')?.addEventListener('click', () => {
    $<HTMLInputElement>('[data-media-file-input]')?.click();
  });

  $('[data-media-file-input]')?.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) void handleFiles(input.files);
    input.value = '';
  });

  $('[data-media-newfolder]')?.addEventListener('click', () => {
    showInputRow({
      label: '新建文件夹',
      placeholder: '例如 gallery（建子目录就写 gallery/2026）',
      submit: async (value) => {
        const name = value.trim().replace(/^\/+|\/+$/g, '');
        if (!name) throw new Error('文件夹名不能为空');
        const target = state.folder ? `${state.folder}/${name}` : name;
        state.busy = true;
        try {
          await createFolder(target);
          hideInputRow();
          showToast(`已创建 ${target}/`);
          await refreshAll();
        } finally {
          state.busy = false;
        }
      },
    });
  });

  $('[data-media-refresh]')?.addEventListener('click', () => void refreshAll());

  $('[data-media-selectall]')?.addEventListener('click', () => {
    const keys = state.files.map((file) => file.key);
    const limit = state.mode === 'pick' ? 1 : state.maxSelect;
    state.selected = limit > 0 ? keys.slice(0, limit) : keys;
    paintSelection();
  });

  $('[data-media-search]')?.addEventListener('input', (event) => {
    state.search = (event.target as HTMLInputElement).value;
    renderGrid();
  });

  $('[data-media-loadmore]')?.addEventListener('click', () => void loadListing({ append: true }));

  /* ---- 上传选项 ---- */
  $('[data-media-compress]')?.addEventListener('change', (event) => {
    state.prefs.compress = (event.target as HTMLInputElement).checked;
    writePrefs(state.prefs);
    syncQualityUi();
  });

  $('[data-media-quality]')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value as QualityKey;
    if (value in QUALITY_PRESETS) {
      state.prefs.quality = value;
      writePrefs(state.prefs);
    }
  });

  /* ---- 输入行 ---- */
  const inputRow = $<HTMLFormElement>('[data-media-input-row]');
  const inputField = $<HTMLInputElement>('[data-media-input-field]');
  inputRow?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!inputRowSubmit || !inputField) return;
    try {
      await inputRowSubmit(inputField.value);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '操作失败');
    }
  });
  inputField?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      hideInputRow();
    }
  });
  $('[data-media-input-cancel]')?.addEventListener('click', () => hideInputRow());

  /* ---- 底栏动作 ---- */
  $('[data-media-act="copy"]')?.addEventListener('click', () => {
    void copyUrls(selectedFiles().map((file) => file.url));
  });
  $('[data-media-act="delete"]')?.addEventListener('click', () => {
    const files = selectedFiles();
    if (files.length) void removeFiles(files.map((file) => file.key), files[0].name);
  });
  $('[data-media-act="cover"]')?.addEventListener('click', () => void confirmPick());
  $('[data-media-act="confirm"]')?.addEventListener('click', () => void confirmPick());

  /* ---- 预览 ---- */
  $('[data-media-preview-close]')?.addEventListener('click', () => closePreview());
  $('[data-media-preview-prev]')?.addEventListener('click', () => stepPreview(-1));
  $('[data-media-preview-next]')?.addEventListener('click', () => stepPreview(1));
  $('[data-media-preview-copy]')?.addEventListener('click', () => {
    const file = state.files[state.previewIndex];
    if (file) void copyUrls([file.url]);
  });
  $('[data-media-preview-open]')?.addEventListener('click', () => {
    const file = state.files[state.previewIndex];
    if (file) window.open(file.url, '_blank', 'noopener');
  });
  $('[data-media-preview]')?.addEventListener('click', (event) => {
    if (event.target === $('[data-media-preview]')) closePreview();
  });

  document.addEventListener('keydown', (event) => {
    if (state.previewIndex < 0) return;
    if (event.key === 'Escape') {
      closePreview();
      event.stopPropagation();
    } else if (event.key === 'ArrowLeft') {
      stepPreview(-1);
    } else if (event.key === 'ArrowRight') {
      stepPreview(1);
    }
  });

  /* ---- 拖放上传 ---- */
  const drop = $('[data-media-drop]');
  if (drop) {
    let depth = 0;
    const stop = (event: DragEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    drop.addEventListener('dragenter', (event) => {
      stop(event);
      depth += 1;
      drop.classList.add('is-drag');
    });
    drop.addEventListener('dragover', (event) => {
      stop(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    drop.addEventListener('dragleave', (event) => {
      stop(event);
      depth = Math.max(0, depth - 1);
      if (depth === 0) drop.classList.remove('is-drag');
    });
    drop.addEventListener('drop', (event) => {
      stop(event);
      depth = 0;
      drop.classList.remove('is-drag');
      const files = event.dataTransfer?.files;
      if (files?.length) void handleFiles(files);
    });
  }
}

function syncQualityUi(): void {
  const wrap = $('[data-media-quality-wrap]');
  const hint = $('[data-media-compress-hint]');
  if (wrap) {
    wrap.classList.toggle('hidden', !state.prefs.compress);
    wrap.classList.toggle('flex', state.prefs.compress);
  }
  if (hint) {
    hint.textContent = state.prefs.compress
      ? '只在本地压缩，不上传任何第三方。GIF / SVG / 已压缩好的小 WebP 会原样保留。'
      : '按原图上传（保留原始格式与体积）。手机流量或大图建议开启压缩。';
  }
}

/* ============================================================
   独立管理页（/media/）的入口
   ============================================================ */

/**
 * 初始化独立管理页。
 * 没登录 / 不是站长 → 只显示授权提示，一个请求都不发。
 */
export function initMediaPage(): void {
  const gate = document.querySelector<HTMLElement>('[data-media-gate]');
  const body = document.querySelector<HTMLElement>('[data-media-page]');
  const login = document.querySelector<HTMLElement>('[data-media-login]');

  const render = (): void => {
    const session = getEditSession();
    const ready = Boolean(session);
    if (gate) gate.classList.toggle('hidden', ready);
    if (gate) gate.classList.toggle('flex', !ready);
    if (body) body.classList.toggle('hidden', !ready);
    if (body) body.classList.toggle('flex', ready);
    if (login && session) {
      login.textContent = `已授权：${session.login}`;
    }
    if (ready && body && body.dataset.loaded !== '1') {
      body.dataset.loaded = '1';
      bindOnce();
      applyMode();
      const compressBox = $<HTMLInputElement>('[data-media-compress]');
      if (compressBox) compressBox.checked = state.prefs.compress;
      const qualitySelect = $<HTMLSelectElement>('[data-media-quality]');
      if (qualitySelect) qualitySelect.value = state.prefs.quality;
      syncQualityUi();
      renderCrumbs();
      void refreshAll();
    }
  };

  render();

  if (login) {
    login.addEventListener('click', async () => {
      // 注意：openEditLogin 里是同步的 window.open，
      // 前面绝不能有 await（动态 import 也算）——否则会丢掉用户手势，弹窗被浏览器拦掉。
      try {
        await openEditLogin();
        render();
      } catch (error) {
        showToast(error instanceof Error ? error.message : '授权失败');
      }
    });
  }
}

/* ============================================================
   给编辑器用的小工具
   ============================================================ */

/** 把一组文件变成 Markdown 插图（图片）或链接（其它） */
export function mediaMarkdown(files: MediaFile[]): string {
  return files
    .map((file) => {
      const isImg =
        (file.type || '').startsWith('image/') ||
        /\.(webp|jpe?g|png|gif|avif|svg)$/i.test(file.name);
      const alt = file.name.replace(/\.[^.]+$/, '');
      return isImg ? `![${alt}](${file.url})` : `[${file.name}](${file.url})`;
    })
    .join('\n\n');
}

export { mediaUrl };
