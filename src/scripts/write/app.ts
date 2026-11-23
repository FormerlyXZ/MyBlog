/**
 * 写作台（/write）主程序
 * ============================================================
 * 一个桌面笔记应用式的三栏工作区：
 *
 *   左栏  所有文章 / 搜索 / 筛选 / 批量管理 / 导入 / 同步
 *   中栏  标题 + 元信息 + Markdown 编辑 / 分屏预览 / 纯预览
 *   右栏  智能快捷操作（所有 Markdown 语法）+ 文档大纲
 *
 * 数据流：
 *   · 页面构建时把「已发布文章」的元信息嵌在 #write-manifest 里（不含草稿，
 *     访客看 HTML 也拿不到隐藏内容）；
 *   · 站长授权后自动从 GitHub tree 拉一次完整清单（含草稿 / 外部改动）；
 *   · 打开文章时才按需读取 .md 正文，保存 = 一次 commit。
 *
 * 原有能力全部保留：.md 导入（单个 / 批量）、单篇 / 系列、图床选图与拖拽上传、
 * Markdown 预览、GitHub 授权、退出。令牌只在本机 localStorage。
 * ============================================================
 */

import { onPageLoad } from '../pageload';
import {
  clearEditSession,
  getEditSession,
  onEditAuthChange,
  openEditLogin,
  showToast,
} from '../../utils/site';
import { commitFiles, getFile, listTree, type FileChange } from '../../utils/github';
import { openMediaDialog } from '../media-dialog';
import type { MediaFile } from '../../utils/media';
import { formatDate } from '../../utils/date';
import { countWords, readingMinutes, previewWarnings, renderMarkdown } from '../markdown';
import { initCodeFolds, refreshCodeFolds } from '../code-fold';
import { initCodeCopy } from '../code-copy';
import { initTables } from '../table-scroll';
import { highlightPreviewCode } from '../highlight';
import '../image-zoom';
import {
  POSTS_DIR,
  buildMarkdown,
  buildSeriesIndex,
  extractHeadings,
  idFromPath,
  padOrder,
  parseList,
  parseMarkdown,
  patchFrontmatter,
  postPath,
  seriesIndexPath,
  slugify,
  splitList,
  today,
  unquote,
  type PostDraft,
} from './frontmatter';
import {
  getEditor,
  insertBlock,
  insertCodeBlock,
  insertFootnote,
  insertInline,
  insertLink,
  insertTable,
  mediaToMarkdown,
  prefixLines,
  surround,
} from './insert';

/* ============================================================
   类型
   ============================================================ */

type FilterKey = 'all' | 'draft' | 'published' | 'pinned' | 'series';
type SortKey = 'updated' | 'date' | 'title';
type ViewMode = 'edit' | 'split' | 'preview';
type RightTab = 'tools' | 'outline';
type DialogMode = 'create' | 'edit';

interface Entry {
  id: string;
  path: string;
  title: string;
  date: string;
  updated: string;
  description: string;
  categories: string[];
  tags: string[];
  image: string;
  badge: string;
  draft: boolean;
  series: string;
  seriesTitle: string;
  seriesOrder: number | null;
  words: number;
}

interface DocMeta {
  mode: 'single' | 'series';
  title: string;
  slug: string;
  date: string;
  updated: string;
  description: string;
  categories: string;
  tags: string;
  image: string;
  attachments: string;
  badge: boolean;
  draft: boolean;
  /** 目录树最多显示几级（'1'~'6'，'' = 自动） */
  tocDepth: string;
  series: string;
  seriesOrder: string;
  seriesTitle: string;
}

interface OriginalMeta {
  slug: string;
  series: string;
  seriesOrder: string;
  path: string;
}

interface Doc {
  key: string;
  id: string;
  path: string;
  originalPath: string;
  isNew: boolean;
  meta: DocMeta;
  body: string;
  original: OriginalMeta;
}

interface LocalDraft {
  at: number;
  meta: DocMeta;
  body: string;
}

interface AppState {
  root: HTMLElement | null;
  entries: Entry[];
  current: Doc | null;
  filter: FilterKey;
  sort: SortKey;
  query: string;
  batch: boolean;
  selected: Set<string>;
  /** 左栏里收起的系列（点击系列标题左边的箭头切换） */
  collapsedSeries: Set<string>;
  leftOpen: boolean;
  rightOpen: boolean;
  mode: ViewMode;
  rightTab: RightTab;
  dialogMode: DialogMode;
  dirty: boolean;
  busy: boolean;
  loading: boolean;
  syncing: boolean;
  loadToken: number;
  slugTouched: boolean;
  previewTimer: number;
  autosaveTimer: number;
  initialOpening: boolean;
  pendingDraft: LocalDraft | null;
  lastSavedAt: string;
  lastLocalAt: number;
}

const state: AppState = {
  root: null,
  entries: [],
  current: null,
  filter: 'all',
  sort: 'updated',
  query: '',
  batch: false,
  selected: new Set(),
  collapsedSeries: new Set(),
  leftOpen: true,
  rightOpen: true,
  mode: 'edit',
  rightTab: 'tools',
  dialogMode: 'create',
  dirty: false,
  busy: false,
  loading: false,
  syncing: false,
  loadToken: 0,
  slugTouched: false,
  previewTimer: 0,
  autosaveTimer: 0,
  initialOpening: false,
  pendingDraft: null,
  lastSavedAt: '',
  lastLocalAt: 0,
};

/* ============================================================
   小工具
   ============================================================ */

function $<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function $$<T extends Element = HTMLElement>(selector: string): T[] {
  return [...document.querySelectorAll<T>(selector)];
}

function nowTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function formatLocalTime(at: number): string {
  if (!at) return '';
  const date = new Date(at);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function setText(selector: string, text: string): void {
  const el = $<HTMLElement>(selector);
  if (el) el.textContent = text;
}

function isAuthed(): boolean {
  return Boolean(getEditSession());
}

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw !== '0';
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/* ---------------- 悬停提示 ----------------
   用一个 fixed 的小气泡代替 CSS ::after：
   ::after 会被 dialog / 侧栏的 overflow 裁掉，弹窗里的问号就露不出来。
   这里用事件委托 + 实时定位，滚动时自动收起。 */

let tooltipBound = false;

function tooltipElement(): HTMLElement {
  let el = document.getElementById('wx-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wx-tooltip';
    el.className = 'wx-tooltip';
    el.hidden = true;
    el.setAttribute('role', 'tooltip');
    document.body.append(el);
  }
  return el;
}

function bindTooltips(): void {
  if (tooltipBound) return;
  tooltipBound = true;

  const show = (target: HTMLElement): void => {
    const text = target.dataset.tip ?? '';
    if (!text) return;
    const tip = tooltipElement();
    tip.textContent = text;

    // 弹窗在浏览器的 top layer 里，气泡挂在 dialog 下面才会显示在它上面
    const host = target.closest('dialog') ?? document.body;
    if (tip.parentElement !== host) host.append(tip);

    tip.hidden = false;
    const rect = target.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - box.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    let top = rect.top - box.height - 8;
    if (top < 8) top = rect.bottom + 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  const hide = (): void => {
    const tip = document.getElementById('wx-tooltip');
    if (tip) tip.hidden = true;
  };

  document.addEventListener('pointerover', (event) => {
    const target = (event.target as Element | null)?.closest?.('[data-tip]');
    if (target instanceof HTMLElement) show(target);
  });
  document.addEventListener('pointerout', (event) => {
    const target = (event.target as Element | null)?.closest?.('[data-tip]');
    if (target) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener(
    'scroll',
    () => {
      hide();
    },
    true,
  );

  // 手机没有 hover：点一下问号，气泡停留 2.6 秒
  document.addEventListener(
    'click',
    (event) => {
      const target = (event.target as Element | null)?.closest?.('.wx-q[data-tip]');
      if (!(target instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      show(target);
      window.setTimeout(hide, 2600);
    },
    true,
  );
}

/* ============================================================
   清单：构建期数据 / 仓库同步
   ============================================================ */

function normalizeEntry(raw: Partial<Entry>): Entry | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    path: typeof raw.path === 'string' ? raw.path : `${POSTS_DIR}/${raw.id}.md`,
    title: typeof raw.title === 'string' ? raw.title : '未命名文章',
    date: typeof raw.date === 'string' ? raw.date.slice(0, 10) : '',
    updated: typeof raw.updated === 'string' ? raw.updated.slice(0, 10) : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    categories: Array.isArray(raw.categories) ? raw.categories.map(String) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    image: typeof raw.image === 'string' ? raw.image : '',
    badge: typeof raw.badge === 'string' ? raw.badge : '',
    draft: raw.draft === true,
    series: typeof raw.series === 'string' ? raw.series : '',
    seriesTitle: typeof raw.seriesTitle === 'string' ? raw.seriesTitle : '',
    seriesOrder:
      typeof raw.seriesOrder === 'number' && Number.isFinite(raw.seriesOrder)
        ? raw.seriesOrder
        : null,
    words: typeof raw.words === 'number' ? raw.words : 0,
  };
}

function readManifest(): Entry[] {
  try {
    const raw = document.getElementById('write-manifest')?.textContent ?? '[]';
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => normalizeEntry(item as Partial<Entry>))
      .filter((item): item is Entry => Boolean(item));
  } catch {
    return [];
  }
}

/** 一段 .md 文本 → 清单条目（同步 / 导入都用它） */
function entryFromText(path: string, text: string): Entry {
  const { data, body } = parseMarkdown(text);
  const rawOrder = unquote(String(data.seriesOrder ?? '')).trim();
  const fileName = path.split('/').pop() ?? path;
  const fileOrder = fileName.match(/^(\d+)-/)?.[1] ?? '';
  const isIndex = /\/index\.md$/i.test(path);
  let order: number | null = rawOrder === '' ? null : Number(rawOrder);
  if (order === null && isIndex) order = 0;
  if (order === null && fileOrder) order = Number(fileOrder);

  return {
    id: idFromPath(path),
    path,
    title: unquote(data.title ?? '').trim() || '未命名文章',
    date: (unquote(data.date ?? '').trim() || '').slice(0, 10),
    updated: (unquote(data.updated ?? '').trim() || '').slice(0, 10),
    description: unquote(data.description ?? ''),
    categories: parseList(data.categories ?? ''),
    tags: parseList(data.tags ?? ''),
    image: unquote(data.image ?? ''),
    badge: unquote(data.badge ?? ''),
    draft: unquote(data.draft ?? '').toLowerCase() === 'true',
    series: unquote(data.series ?? '').trim(),
    seriesTitle: unquote(data.seriesTitle ?? ''),
    seriesOrder: order !== null && Number.isFinite(order) ? order : null,
    words: countWords(body),
  };
}

function sortEntries(list: Entry[]): Entry[] {
  const stamp = (entry: Entry) => entry.updated || entry.date || '0000-00-00';
  const pin = (entry: Entry) => (entry.badge === 'Pin' ? 1 : 0);
  return [...list].sort((a, b) => {
    const pinDiff = pin(b) - pin(a);
    if (pinDiff !== 0) return pinDiff;
    const timeDiff = stamp(b).localeCompare(stamp(a));
    if (timeDiff !== 0) return timeDiff;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}

/** 从 GitHub 拉全量清单（含草稿）：tree 一次 + 每篇一次 contents */
async function syncEntries(options: { silent?: boolean } = {}): Promise<void> {
  if (!isAuthed() || state.syncing) return;
  state.syncing = true;
  setSyncBusy(true);

  try {
    const files = await listTree(POSTS_DIR);
    const paths = files.filter((file) => /\.md$/i.test(file.path)).map((file) => file.path);
    if (!paths.length) throw new Error('仓库里没有找到 Markdown 文章');

    const entries: Entry[] = [];
    const queue = [...paths];
    let done = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const path = queue.shift();
        if (!path) return;
        try {
          const file = await getFile(path);
          if (file) entries.push(entryFromText(path, file.text));
        } catch {
          /* 单篇读失败不影响其它文章 */
        }
        done += 1;
        if (!options.silent) setSyncStatus(`同步 ${done}/${paths.length}`);
      }
    };

    await Promise.all(Array.from({ length: 4 }, () => worker()));
    state.entries = sortEntries(entries);
    renderList();
    if (!options.silent) showToast(`已从仓库同步 ${entries.length} 篇文章`);
  } catch (error) {
    if (!options.silent) {
      showToast(error instanceof Error ? error.message : '同步失败');
    } else {
      console.warn('[write] 自动同步失败，先用构建期清单', error);
    }
  } finally {
    state.syncing = false;
    setSyncBusy(false);
    setSyncStatus('');
  }
}

function setSyncBusy(busy: boolean): void {
  const button = $<HTMLElement>('[data-wx-sync]');
  if (button) button.classList.toggle('is-busy', busy);
}

function setSyncStatus(text: string): void {
  const el = $<HTMLElement>('[data-wx-sync-status]');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

/* ============================================================
   文档 ↔ 表单
   ============================================================ */

function docFromText(entry: Entry, text: string): Doc {
  const { data, body } = parseMarkdown(text);
  const series = unquote(data.series ?? '').trim();
  const rawOrder = unquote(String(data.seriesOrder ?? '')).trim();
  const rawTocDepth = unquote(data.tocDepth ?? '').trim();
  const fileName = entry.id.split('/').pop() ?? entry.id;
  const fileOrder = fileName.match(/^(\d+)-/)?.[1] ?? '';
  const isIndex = Boolean(series) && (rawOrder === '0' || /\/index$/.test(entry.id));
  const slug = isIndex ? 'index' : series ? fileName.replace(/^\d+-/, '') : fileName;
  const seriesOrder = isIndex ? '0' : rawOrder || fileOrder || (series ? '1' : '');

  const meta: DocMeta = {
    mode: series ? 'series' : 'single',
    title: unquote(data.title ?? '').trim(),
    slug,
    date: (unquote(data.date ?? '').trim() || today()).slice(0, 10),
    updated: (unquote(data.updated ?? '').trim() || '').slice(0, 10),
    description: unquote(data.description ?? ''),
    categories: parseList(data.categories ?? '').join(', '),
    tags: parseList(data.tags ?? '').join(', '),
    image: unquote(data.image ?? ''),
    attachments: parseList(data.attachments ?? '').join('\n'),
    badge: unquote(data.badge ?? '') === 'Pin',
    draft: unquote(data.draft ?? '').toLowerCase() === 'true',
    tocDepth: /^[1-6]$/.test(rawTocDepth) ? rawTocDepth : '',
    series,
    seriesOrder,
    seriesTitle: unquote(data.seriesTitle ?? ''),
  };

  return {
    key: entry.id,
    id: entry.id,
    path: entry.path,
    originalPath: entry.path,
    isNew: false,
    meta,
    body: body.replace(/^\s+/, ''),
    original: { slug, series, seriesOrder: meta.seriesOrder, path: entry.path },
  };
}

function docFromDraft(draft: PostDraft, isNew: boolean, path = ''): Doc {
  const id = path ? idFromPath(path) : '';
  return {
    key: isNew ? '__new' : id,
    id,
    path,
    originalPath: path,
    isNew,
    meta: {
      mode: draft.mode,
      title: draft.title,
      slug: draft.slug,
      date: draft.date || today(),
      updated: draft.updated,
      description: draft.description,
      categories: draft.categories,
      tags: draft.tags,
      image: draft.image,
      attachments: draft.attachments,
      badge: draft.badge,
      draft: draft.draft,
      tocDepth: draft.tocDepth ?? '',
      series: draft.series,
      seriesOrder: draft.seriesOrder,
      seriesTitle: draft.seriesTitle,
    },
    body: draft.body.replace(/^\s+/, ''),
    original: { slug: draft.slug, series: draft.series, seriesOrder: draft.seriesOrder, path },
  };
}

function docToDraft(doc: Doc): PostDraft {
  // 老版本存下来的本地草稿没有 tocDepth，补个空串，保存时按默认处理
  return { ...doc.meta, tocDepth: doc.meta.tocDepth ?? '', body: doc.body };
}

function entryFromDoc(doc: Doc, path: string, id: string): Entry {
  const meta = doc.meta;
  return {
    id,
    path,
    title: meta.title || '未命名文章',
    date: meta.date,
    updated: meta.updated,
    description: meta.description,
    categories: splitList(meta.categories),
    tags: splitList(meta.tags),
    image: meta.image,
    badge: meta.badge ? 'Pin' : '',
    draft: meta.draft,
    series: meta.mode === 'series' ? meta.series.trim() : '',
    seriesTitle: meta.seriesTitle,
    seriesOrder:
      meta.mode === 'series' && meta.seriesOrder.trim() !== ''
        ? Number(meta.seriesOrder)
        : null,
    words: countWords(doc.body),
  };
}

function autoSlug(meta: DocMeta): string {
  const base = slugify(meta.title);
  if (!base) return '';
  if (meta.mode === 'series') return base;
  return meta.date ? `${meta.date}-${base}` : base;
}

/**
 * 保存时用哪个路径。
 * 文件名 / 系列 / 序号都没动过 → 沿用原路径，避免把 `4-xxx.md` 这种
 * 没补零的历史文件「顺手重命名」。
 */
function resolvePath(doc: Doc): string {
  const meta = doc.meta;
  if (
    !doc.isNew &&
    doc.original.path &&
    meta.slug === doc.original.slug &&
    meta.series === doc.original.series &&
    meta.seriesOrder === doc.original.seriesOrder
  ) {
    return doc.original.path;
  }
  return postPath(docToDraft(doc));
}

/* ============================================================
   本地草稿（防手滑）
   ============================================================ */

function draftKey(doc: Doc): string {
  return `wxdoc:${doc.originalPath || 'new'}`;
}

function readLocalDraft(path: string): LocalDraft | null {
  try {
    const raw = localStorage.getItem(`wxdoc:${path || 'new'}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<LocalDraft>;
    if (!data || typeof data.body !== 'string' || !data.meta) return null;
    return { at: Number(data.at) || 0, meta: data.meta as DocMeta, body: data.body };
  } catch {
    return null;
  }
}

function writeLocalDraft(): void {
  const doc = state.current;
  if (!doc) return;
  try {
    localStorage.setItem(
      draftKey(doc),
      JSON.stringify({ at: Date.now(), meta: doc.meta, body: doc.body }),
    );
    state.lastLocalAt = Date.now();
    updateSaveState();
  } catch {
    /* 存不下就算了 */
  }
}

function removeLocalDrafts(paths: string[]): void {
  try {
    for (const path of paths) localStorage.removeItem(`wxdoc:${path || 'new'}`);
  } catch {
    /* 忽略 */
  }
}

function scheduleAutosave(): void {
  window.clearTimeout(state.autosaveTimer);
  state.autosaveTimer = window.setTimeout(() => writeLocalDraft(), 800);
}

function checkLocalDraft(): void {
  const doc = state.current;
  if (!doc) {
    state.pendingDraft = null;
    renderRecovery();
    return;
  }

  const draft = readLocalDraft(doc.originalPath);
  if (!draft) {
    state.pendingDraft = null;
    renderRecovery();
    return;
  }

  const same =
    draft.body === doc.body && JSON.stringify(draft.meta) === JSON.stringify(doc.meta);
  if (same) {
    removeLocalDrafts([doc.originalPath]);
    state.pendingDraft = null;
  } else {
    state.pendingDraft = draft;
  }
  renderRecovery();
}

function renderRecovery(): void {
  const bar = $<HTMLElement>('[data-wx-recovery]');
  if (!bar) return;
  const draft = state.pendingDraft;
  bar.hidden = !draft;
  if (!draft) return;
  setText('[data-wx-recovery-time]', formatLocalTime(draft.at));
}

function restoreLocalDraft(): void {
  const doc = state.current;
  const draft = state.pendingDraft;
  if (!doc || !draft) return;

  doc.meta = { ...draft.meta };
  doc.body = draft.body;
  state.pendingDraft = null;
  state.dirty = true;
  renderRecovery();
  renderEditor();
  markDirty();
  showToast('已恢复本地草稿');
}

function discardLocalDraft(): void {
  const doc = state.current;
  if (doc) removeLocalDrafts([doc.originalPath]);
  state.pendingDraft = null;
  renderRecovery();
  updateSaveState();
}

/* ============================================================
   授权界面
   ============================================================ */

function renderGate(): void {
  const gate = $<HTMLElement>('[data-write-gate]');
  const app = $<HTMLElement>('[data-wx-app]');
  const logout = $<HTMLElement>('[data-edit-logout]');
  const authed = isAuthed();

  if (gate) gate.hidden = authed;
  if (app) {
    app.hidden = !authed;
    app.classList.toggle('hidden', !authed);
    app.classList.toggle('flex', authed);
  }
  if (logout) logout.hidden = !authed;

  if (authed) {
    void maybeOpenInitial();
    void syncEntries({ silent: true });
  } else {
    state.current = null;
    state.dirty = false;
    state.pendingDraft = null;
    state.selected.clear();
    state.batch = false;
    renderEditor();
    renderList();
  }
}

/* ============================================================
   列表
   ============================================================ */

function filteredEntries(): Entry[] {
  const query = state.query.trim().toLowerCase();
  let list = state.entries.filter((entry) => {
    if (state.filter === 'draft' && !entry.draft) return false;
    if (state.filter === 'published' && entry.draft) return false;
    if (state.filter === 'pinned' && entry.badge !== 'Pin') return false;
    if (state.filter === 'series' && !entry.series) return false;

    if (!query) return true;
    const haystack = [
      entry.title,
      entry.description,
      entry.series,
      entry.seriesTitle,
      ...entry.categories,
      ...entry.tags,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });

  if (state.sort === 'title') {
    list = [...list].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  } else if (state.sort === 'date') {
    list = [...list].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  } else {
    list = sortEntries(list);
  }
  return list;
}

function renderList(): void {
  const listEl = $<HTMLElement>('[data-wx-list]');
  const emptyEl = $<HTMLElement>('[data-wx-list-empty]');
  const countEl = $<HTMLElement>('[data-wx-count]');
  const labelEl = $<HTMLElement>('[data-wx-list-label]');
  if (!listEl) return;

  const scrollTop = listEl.scrollTop;
  const sorted = filteredEntries();
  const fragment = document.createDocumentFragment();
  let articleCount = 0;

  const showVirtual =
    Boolean(state.current?.isNew) &&
    (state.filter === 'all' || state.filter === 'draft') &&
    !state.query.trim();
  if (showVirtual && state.current) {
    fragment.append(buildRow(entryFromDoc(state.current, '', '__new'), true));
    articleCount += 1;
  }

  // 系列单独成组：组头就是系列介绍页，章节缩进挂在下面
  const seenSeries = new Set<string>();
  for (const entry of sorted) {
    if (!entry.series) {
      fragment.append(buildRow(entry, false));
      articleCount += 1;
      continue;
    }
    if (seenSeries.has(entry.series)) continue;
    seenSeries.add(entry.series);

    const members = sorted.filter((item) => item.series === entry.series);
    fragment.append(buildSeriesGroup(entry.series, members));
    articleCount += members.length;
  }

  listEl.replaceChildren(fragment);
  listEl.scrollTop = scrollTop;

  if (emptyEl) {
    emptyEl.hidden = articleCount > 0;
    emptyEl.classList.toggle('hidden', articleCount > 0);
  }
  if (countEl) countEl.textContent = String(state.entries.length + (state.current?.isNew ? 1 : 0));
  if (labelEl) {
    const labels: Record<FilterKey, string> = {
      all: '全部文章',
      draft: '草稿',
      published: '已发布',
      pinned: '置顶',
      series: '系列',
    };
    labelEl.textContent = `${labels[state.filter]} · ${articleCount}`;
  }

  updateBatchUi();
}

/** 某个系列的介绍页（seriesOrder 0 或 <系列>/index.md） */
function seriesIndexEntry(series: string): Entry | undefined {
  return state.entries.find(
    (entry) =>
      entry.series === series &&
      (entry.seriesOrder === 0 || /\/index$/i.test(entry.id)),
  );
}

/**
 * 系列分组。
 * 组头是系列名（点击只展开 / 收起），介绍页作为第一行「系列说明」，
 * 章节按序号缩进挂在下面 —— 左栏一眼能看出哪些文章属于同一套长文。
 */
function buildSeriesGroup(series: string, members: Entry[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'wx-series';
  const collapsed = state.collapsedSeries.has(series);
  root.classList.toggle('is-collapsed', collapsed);

  const indexEntry = seriesIndexEntry(series);
  const intro = indexEntry ? members.find((entry) => entry.id === indexEntry.id) : undefined;
  const chapters = members
    .filter((entry) => entry.id !== indexEntry?.id)
    .sort((a, b) => (a.seriesOrder ?? 999) - (b.seriesOrder ?? 999));
  const title = indexEntry?.seriesTitle || members[0]?.seriesTitle || series;

  const head = document.createElement('div');
  head.className = 'wx-series__head';
  head.classList.toggle(
    'is-active',
    Boolean(
      state.current &&
        !state.current.isNew &&
        members.some((entry) => entry.id === state.current?.id),
    ),
  );

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'wx-series__toggle';
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.setAttribute('aria-label', collapsed ? '展开系列章节' : '收起系列章节');
  toggle.textContent = '▾';
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSeries(series, root);
  });

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'wx-series__open';
  open.textContent = title;
  open.title = '展开 / 收起系列章节';
  open.addEventListener('click', () => toggleSeries(series, root));

  const count = document.createElement('span');
  count.className = 'wx-series__count';
  count.textContent = chapters.length ? `${chapters.length} 章` : '系列';

  head.append(toggle, open, count);
  root.append(head);

  const items = document.createElement('div');
  items.className = 'wx-series__items';
  const inner = document.createElement('div');
  inner.className = 'wx-series__inner';
  if (intro) inner.append(buildRow(intro, false, { child: true, intro: true }));
  for (const entry of chapters) inner.append(buildRow(entry, false, { child: true }));
  items.append(inner);
  root.append(items);

  return root;
}

function toggleSeries(series: string, root?: HTMLElement): void {
  const collapsed = state.collapsedSeries.has(series);
  if (collapsed) state.collapsedSeries.delete(series);
  else state.collapsedSeries.add(series);
  writeCollapsedSeries();

  const items = root?.querySelector<HTMLElement>('.wx-series__items');
  const inner = items?.querySelector<HTMLElement>('.wx-series__inner');
  if (!root || !items || !inner) {
    renderList();
    return;
  }

  // 只切这一组的展开状态（不重绘整张列表），才能量到高度做动画
  const height = inner.scrollHeight;
  if (collapsed) {
    // 展开：0 → 实际高度；动画结束交回 none，后续内容变化不受限
    items.style.maxHeight = '0px';
    root.classList.remove('is-collapsed');
    root.querySelector('.wx-series__toggle')?.setAttribute('aria-expanded', 'true');
    window.requestAnimationFrame(() => {
      items.style.maxHeight = `${height}px`;
      const done = (): void => {
        // 动画途中又被点回收起：别把 max-height 交回 none，否则收起会跳一下
        if (root.classList.contains('is-collapsed')) return;
        items.style.maxHeight = 'none';
        items.removeEventListener('transitionend', done);
      };
      items.addEventListener('transitionend', done);
      window.setTimeout(done, 420);
    });
  } else {
    // 收起：实际高度 → 0
    items.style.maxHeight = `${items.getBoundingClientRect().height}px`;
    root.classList.add('is-collapsed');
    root.querySelector('.wx-series__toggle')?.setAttribute('aria-expanded', 'false');
    window.requestAnimationFrame(() => {
      items.style.maxHeight = '0px';
    });
  }
}

function readCollapsedSeries(): Set<string> {
  try {
    const raw = localStorage.getItem('wx-collapsed-series');
    const data = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(data) ? data.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedSeries(): void {
  try {
    localStorage.setItem('wx-collapsed-series', JSON.stringify([...state.collapsedSeries]));
  } catch {
    /* 忽略 */
  }
}

function buildRow(
  entry: Entry,
  virtual: boolean,
  options: { child?: boolean; intro?: boolean } = {},
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'wx-row';
  row.dataset.wxRow = entry.id;
  row.tabIndex = 0;
  row.setAttribute('role', 'option');
  if (options.child) row.classList.add('wx-row--child');
  if (options.intro) row.classList.add('wx-row--intro');

  const active = state.current
    ? virtual
      ? state.current.isNew
      : !state.current.isNew && state.current.id === entry.id
    : false;
  row.setAttribute('aria-selected', active ? 'true' : 'false');
  row.classList.toggle('is-active', active);
  row.classList.toggle('is-draft', entry.draft || virtual);
  row.classList.toggle('is-batch', state.batch);
  row.classList.toggle('is-selected', !virtual && state.selected.has(entry.id));

  if (state.batch) {
    const check = document.createElement('span');
    check.className = 'wx-row__check';
    check.setAttribute('aria-hidden', 'true');
    row.append(check);
  }

  const body = document.createElement('span');
  body.className = 'wx-row__body';

  const title = document.createElement('span');
  title.className = 'wx-row__title';
  title.textContent = options.intro ? '系列说明' : entry.title || '未命名文章';
  if (options.intro) title.title = entry.title;
  body.append(title);

  const meta = document.createElement('span');
  meta.className = 'wx-row__meta';

  const dot = document.createElement('span');
  dot.className = 'wx-row__dot';
  meta.append(dot);

  const date = document.createElement('span');
  date.className = 'wx-row__date';
  date.textContent = entry.date || '未定日期';
  meta.append(date);

  if (virtual) {
    const tag = document.createElement('span');
    tag.className = 'wx-row__tag';
    tag.textContent = '未保存';
    meta.append(tag);
  } else if (entry.series) {
    const tag = document.createElement('span');
    tag.className = 'wx-row__tag wx-row__tag--series';
    tag.textContent = options.intro
      ? '引言'
      : entry.seriesOrder === 0
        ? '系列'
        : `第 ${entry.seriesOrder ?? '?'} 章`;
    meta.append(tag);
  }

  if (entry.badge === 'Pin') {
    const pin = document.createElement('span');
    pin.className = 'wx-row__pin';
    pin.textContent = '置顶';
    meta.append(pin);
  }

  body.append(meta);
  row.append(body);

  if (entry.draft) {
    const badge = document.createElement('span');
    badge.className = 'wx-row__draft';
    badge.textContent = '草稿';
    row.append(badge);
  }

  row.addEventListener('click', () => {
    if (state.batch && !virtual) {
      toggleSelect(entry.id);
      return;
    }
    if (virtual) {
      closeMobileDrawers();
      focusTitle();
      return;
    }
    void openEntry(entry).then(() => closeMobileDrawers());
  });

  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    row.click();
  });

  return row;
}

function toggleSelect(id: string): void {
  if (!id || id === '__new') return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderList();
}

function setBatch(on: boolean): void {
  state.batch = on;
  if (!on) state.selected.clear();
  const button = $<HTMLElement>('[data-wx-batch]');
  if (button) {
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  renderList();
}

function selectedEntries(): Entry[] {
  return state.entries.filter((entry) => state.selected.has(entry.id));
}

function updateBatchUi(): void {
  const bar = $<HTMLElement>('[data-wx-batchbar]');
  if (bar) bar.hidden = !state.batch;

  const count = $<HTMLElement>('[data-wx-selected-count]');
  if (count) count.textContent = state.selected.size ? `已选 ${state.selected.size} 篇` : '未选择';

  const selectAll = $<HTMLInputElement>('[data-wx-selectall]');
  const list = filteredEntries();
  if (selectAll) {
    selectAll.checked =
      list.length > 0 && list.every((entry) => state.selected.has(entry.id));
    selectAll.indeterminate =
      list.length > 0 && !selectAll.checked && list.some((entry) => state.selected.has(entry.id));
  }
}

function setFilter(filter: FilterKey): void {
  if (state.filter !== filter) state.selected.clear();
  state.filter = filter;
  for (const button of $$<HTMLElement>('[data-wx-filter]')) {
    button.classList.toggle('is-active', button.dataset.wxFilter === filter);
  }
  renderList();
}

/* ============================================================
   打开 / 新建 / 编辑器渲染
   ============================================================ */

async function openEntry(entry: Entry, preloaded?: string): Promise<void> {
  if (!isAuthed()) return;
  if (state.current && !state.current.isNew && state.current.id === entry.id && !state.dirty) {
    return;
  }
  if (
    state.current &&
    state.dirty &&
    !window.confirm('当前文章还有未提交的更改，切换后会丢失本地草稿。继续吗？')
  ) {
    return;
  }

  const token = ++state.loadToken;
  state.loading = true;
  updateSaveState();

  try {
    const text = preloaded ?? (await getFile(entry.path))?.text;
    if (token !== state.loadToken) return;
    if (!text) {
      showToast('仓库里找不到这篇文章（可能已被删除或改名）');
      return;
    }

    const doc = docFromText(entry, text);
    state.current = doc;
    state.dirty = false;
    state.pendingDraft = null;
    state.slugTouched = true;
    state.lastSavedAt = '';
    state.lastLocalAt = 0;

    renderEditor();
    renderList();
    updateUrl(doc.id);
    writePref('wx-last', doc.id);
    checkLocalDraft();
  } catch (error) {
    showToast(error instanceof Error ? error.message : '读取文章失败');
  } finally {
    if (token === state.loadToken) {
      state.loading = false;
      updateSaveState();
    }
  }
}

/** 从 URL / 上次打开的位置恢复 */
async function maybeOpenInitial(): Promise<void> {
  if (!isAuthed() || state.initialOpening) return;
  state.initialOpening = true;

  try {
    const fromUrl = new URLSearchParams(window.location.search).get('slug')?.trim() ?? '';
    let target = fromUrl;
    if (!target) {
      try {
        target = localStorage.getItem('wx-last') ?? '';
      } catch {
        target = '';
      }
    }
    if (!target) return;

    const entry = state.entries.find((item) => item.id === target);
    if (entry) {
      await openEntry(entry);
      return;
    }

    const clean = target.replace(/^\/+|\/+$/g, '');
    let path = clean.startsWith('src/') ? clean : `${POSTS_DIR}/${clean}.md`;
    let file = await getFile(path);
    // 旧链接（尤其是系列介绍页）可能传来 post.id = "stm32" 这种目录名，
    // 实际文件是 stm32/index.md —— 找不到就再按目录页试一次。
    if (!file && !clean.startsWith('src/')) {
      const indexPath = `${POSTS_DIR}/${clean}/index.md`;
      const indexFile = await getFile(indexPath);
      if (indexFile) {
        path = indexPath;
        file = indexFile;
      }
    }
    if (!file) {
      showToast('没有找到这篇文章');
      return;
    }
    const loaded = entryFromText(path, file.text);
    state.entries = sortEntries([...state.entries.filter((item) => item.id !== loaded.id), loaded]);
    await openEntry(loaded, file.text);
  } finally {
    state.initialOpening = false;
  }
}

function createNewDoc(meta: DocMeta): void {
  const doc: Doc = {
    key: '__new',
    id: '',
    path: '',
    originalPath: '',
    isNew: true,
    meta: { ...meta, updated: '', attachments: meta.attachments ?? '' },
    body: '',
    original: {
      slug: meta.slug,
      series: meta.series,
      seriesOrder: meta.seriesOrder,
      path: '',
    },
  };

  state.current = doc;
  state.dirty = true;
  state.pendingDraft = null;
  // 还没保存的新文章：改标题时文件名跟着走（用户手动改过 slug 就停）
  state.slugTouched = false;
  state.mode = 'edit';
  state.lastSavedAt = '';
  state.lastLocalAt = 0;

  renderEditor();
  renderList();
  updateUrl('');
  markDirty();
  closeMobileDrawers();
  focusTitle();
}

function renderEditor(): void {
  const doc = state.current;
  const editor = $<HTMLElement>('[data-wx-editor]');
  const empty = $<HTMLElement>('[data-wx-empty]');
  const titleEl = $<HTMLInputElement>('[data-wx-title]');
  const bodyEl = $<HTMLTextAreaElement>('[data-wx-body]');

  if (!doc) {
    if (editor) editor.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.classList.remove('hidden');
    }
    if (titleEl) titleEl.value = '';
    if (bodyEl) bodyEl.value = '';
    const preview = $<HTMLElement>('[data-wx-preview]');
    if (preview) preview.innerHTML = '';
    renderOutline();
    renderRecovery();
    updateBreadcrumb();
    updateSaveState();
    updateStats();
    return;
  }

  if (editor) editor.hidden = false;
  if (empty) {
    empty.hidden = true;
    empty.classList.add('hidden');
  }

  if (titleEl && titleEl.value !== doc.meta.title) titleEl.value = doc.meta.title;
  if (bodyEl && bodyEl.value !== doc.body) bodyEl.value = doc.body;

  updateChips();
  updateBreadcrumb();
  updateSaveState();
  updateStats();
  updateGutter();
  renderOutline();
  renderRecovery();
  applyViewMode(state.mode, false);

  if (state.mode !== 'edit') renderPreview();
}

function applyViewMode(mode: ViewMode, render = true): void {
  state.mode = mode;
  for (const button of $$<HTMLElement>('[data-wx-mode]')) {
    button.classList.toggle('is-active', button.dataset.wxMode === mode);
    button.setAttribute('aria-pressed', button.dataset.wxMode === mode ? 'true' : 'false');
  }
  const panes = $<HTMLElement>('[data-wx-panes]');
  if (panes) panes.dataset.mode = mode;

  // 收起的编辑 / 预览面板不参与 Tab 焦点（宽度为 0 但节点还在）
  const editPane = $<HTMLElement>('.wx-pane--edit');
  const previewPane = $<HTMLElement>('.wx-pane--preview');
  if (editPane) editPane.toggleAttribute('inert', mode === 'preview');
  if (previewPane) previewPane.toggleAttribute('inert', mode === 'edit');

  if (render && mode !== 'edit') renderPreview();
}

function updateBreadcrumb(): void {
  setText('[data-wx-breadcrumb]', state.current?.meta.title || (state.current ? '未命名文章' : '写作台'));
}

function updateChips(): void {
  const doc = state.current;
  if (!doc) return;
  const meta = doc.meta;

  const dateChip = $<HTMLElement>('[data-wx-chip-date]');
  if (dateChip) {
    dateChip.textContent = meta.date ? formatDate(meta.date, 'YYYY-MM-DD') : '未设置日期';
  }

  const statusChip = $<HTMLElement>('[data-wx-chip-status]');
  if (statusChip) {
    statusChip.textContent = meta.draft ? '草稿' : '已发布';
    statusChip.classList.toggle('wx-chip--draft', meta.draft);
    statusChip.classList.toggle('wx-chip--published', !meta.draft);
  }

  const updatedChip = $<HTMLElement>('[data-wx-chip-updated]');
  if (updatedChip) {
    updatedChip.hidden = !meta.updated;
    updatedChip.textContent = meta.updated ? `更新于 ${meta.updated}` : '';
  }

  const pinChip = $<HTMLElement>('[data-wx-chip-pin]');
  if (pinChip) pinChip.hidden = !meta.badge;

  const seriesChip = $<HTMLElement>('[data-wx-chip-series]');
  if (seriesChip) {
    const show = meta.mode === 'series' && Boolean(meta.series.trim());
    seriesChip.hidden = !show;
    if (show) {
      const series = meta.series.trim();
      const indexEntry = seriesIndexEntry(series);
      const title =
        meta.seriesTitle ||
        indexEntry?.seriesTitle ||
        state.entries.find((entry) => entry.series === series)?.seriesTitle ||
        series;
      const order = Number(meta.seriesOrder);
      const tail = order === 0 ? '说明页' : order > 0 ? `第 ${order} 章` : '章节';
      seriesChip.textContent = `${title} · ${tail}`;
    }
  }

  const cats = $<HTMLElement>('[data-wx-chip-categories]');
  if (cats) {
    cats.replaceChildren();
    for (const category of splitList(meta.categories)) {
      const chip = document.createElement('span');
      chip.className = 'wx-chip wx-chip--category';
      chip.textContent = category;
      cats.append(chip);
    }
  }
}

function updateSaveState(): void {
  const label = $<HTMLElement>('[data-wx-save-state]');
  const dot = $<HTMLElement>('[data-wx-save-dot]');
  const last = $<HTMLElement>('[data-wx-last]');

  let text = '';
  let kind = 'idle';
  if (state.busy) {
    text = '提交中…';
    kind = 'saving';
  } else if (state.loading) {
    text = '读取中…';
    kind = 'saving';
  } else if (state.current) {
    text = state.dirty ? '未保存' : '已保存';
    kind = state.dirty ? 'dirty' : 'saved';
  }

  if (label) label.textContent = text;
  const mobileLabel = $<HTMLElement>('[data-wx-save-state-mobile]');
  if (mobileLabel) mobileLabel.textContent = text;
  if (dot) dot.dataset.state = kind;

  if (last) {
    if (state.dirty && state.lastLocalAt) {
      last.textContent = `本地草稿 ${formatLocalTime(state.lastLocalAt)}`;
    } else if (state.lastSavedAt) {
      last.textContent = `已提交 ${state.lastSavedAt}`;
    } else {
      last.textContent = state.current ? '尚未提交到仓库' : '';
    }
  }
}

function markDirty(): void {
  state.dirty = true;
  updateSaveState();
  scheduleAutosave();
  scheduleOutline();
  schedulePreview();
  updateActiveRow();
}

function updateActiveRow(): void {
  const doc = state.current;
  if (!doc) return;
  setText('[data-wx-breadcrumb]', doc.meta.title || '未命名文章');
  const key = doc.isNew ? '__new' : doc.id;
  const row = document.querySelector<HTMLElement>(`[data-wx-row="${CSS.escape(key)}"]`);
  const title = row?.querySelector<HTMLElement>('.wx-row__title');
  if (title && !row?.classList.contains('wx-row--intro')) {
    title.textContent = doc.meta.title || '未命名文章';
  }
}

/* ---------------- 统计 / 行号 / 大纲 ---------------- */

function updateStats(): void {
  const doc = state.current;
  const bodyEl = $<HTMLTextAreaElement>('[data-wx-body]');
  if (!doc || !bodyEl) return;

  const words = countWords(doc.body);
  const minutes = readingMinutes(doc.body);
  setText('[data-wx-words]', `${words} 字`);
  setText('[data-wx-reading]', `约 ${minutes} 分钟阅读`);

  const caret = bodyEl.selectionStart ?? 0;
  const before = doc.body.slice(0, caret);
  const line = before.split('\n').length;
  const column = caret - before.lastIndexOf('\n');
  setText('[data-wx-cursor]', `第 ${line} 行 · 第 ${column} 列`);

  const warnings = previewWarnings(doc.body);
  const warningEl = $<HTMLElement>('[data-wx-warnings]');
  if (warningEl) {
    warningEl.hidden = warnings.length === 0;
    warningEl.textContent = warnings.length ? `⚠ ${warnings.join('；')}` : '';
  }
}

function updateGutter(): void {
  const gutter = $<HTMLElement>('[data-wx-gutter]');
  const bodyEl = $<HTMLTextAreaElement>('[data-wx-body]');
  if (!gutter || !bodyEl) return;

  const lines = bodyEl.value.split('\n').length;
  if (gutter.childElementCount !== lines) {
    const fragment = document.createDocumentFragment();
    for (let i = 1; i <= lines; i += 1) {
      const span = document.createElement('span');
      span.textContent = String(i);
      fragment.append(span);
    }
    gutter.replaceChildren(fragment);
  }
  gutter.scrollTop = bodyEl.scrollTop;
}

function renderOutline(): void {
  const box = $<HTMLElement>('[data-wx-outline]');
  const empty = $<HTMLElement>('[data-wx-outline-empty]');
  if (!box) return;

  const doc = state.current;
  const headings = doc ? extractHeadings(doc.body) : [];
  box.replaceChildren();

  if (!headings.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  for (const heading of headings) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `wx-outline__item wx-outline__item--h${Math.min(6, heading.level)}`;
    button.textContent = heading.text || '（无标题）';
    button.addEventListener('click', () => jumpToLine(heading.line));
    box.append(button);
  }
}

function jumpToLine(line: number): void {
  const bodyEl = $<HTMLTextAreaElement>('[data-wx-body]');
  if (!bodyEl || !state.current) return;
  const lines = state.current.body.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(line, lines.length); i += 1) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  if (state.mode === 'preview') applyViewMode('split');
  bodyEl.focus();
  bodyEl.setSelectionRange(offset, offset);
}

let outlineTimer = 0;
function scheduleOutline(): void {
  window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    renderOutline();
    updateStats();
    updateGutter();
  }, 260);
}

/* ============================================================
   预览
   ============================================================ */

let previewTimer = 0;
function schedulePreview(): void {
  window.clearTimeout(state.previewTimer);
  if (state.mode === 'edit') return;
  state.previewTimer = window.setTimeout(() => renderPreview(), 220);
}

function renderPreview(): void {
  const doc = state.current;
  const box = $<HTMLElement>('[data-wx-preview]');
  if (!doc || !box || state.mode === 'edit') return;

  if (!doc.body.trim()) {
    box.innerHTML = '<p class="wx-preview-empty">还没有正文</p>';
    return;
  }

  const scrollTop = box.scrollTop;
  box.innerHTML = renderMarkdown(doc.body);
  box.scrollTop = scrollTop;
  initCodeFolds(box);
  initCodeCopy(box);
  initTables(box);
  highlightPreviewCode(box)
    .then((changed) => {
      if (changed) refreshCodeFolds();
    })
    .catch(() => {
      /* 语法高亮失败就保持纯文本 */
    });
}

/* ============================================================
   保存
   ============================================================ */

function focusTitle(): void {
  const titleEl = $<HTMLInputElement>('[data-wx-title]');
  titleEl?.focus();
  titleEl?.select();
}

async function saveDoc(): Promise<void> {
  const doc = state.current;
  if (!doc) {
    showToast('先新建或选择一篇文章');
    return;
  }
  if (!isAuthed()) {
    showToast('请先用 GitHub 授权');
    return;
  }
  if (state.busy) return;

  if (!doc.meta.title.trim()) {
    showToast('标题不能为空');
    focusTitle();
    return;
  }
  if (!doc.meta.slug.trim()) {
    showToast('文件名不能为空');
    return;
  }
  if (doc.meta.mode === 'series' && !doc.meta.series.trim()) {
    showToast('选了「系列」但没填系列标识');
    return;
  }

  const existed = !doc.isNew && Boolean(doc.original.path);
  // 编辑旧文章时没手填更新时间 → 自动记成今天（和旧版一致）
  if (existed && !doc.meta.updated.trim()) doc.meta.updated = today();

  const path = resolvePath(doc);
  if (!path) {
    showToast('文件名 / 系列信息不完整，无法保存');
    return;
  }

  // 新文章 / 改过路径：先确认目标文件是不是已经存在，避免悄悄覆盖别人
  if (!existed || path !== doc.original.path) {
    try {
      const target = await getFile(path);
      if (target && !window.confirm(`仓库里已经有「${path}」，要覆盖它吗？`)) return;
    } catch {
      /* 读不到就交给 commit 阶段报错 */
    }
  }

  state.busy = true;
  updateSaveState();

  try {
    const text = buildMarkdown(docToDraft(doc));
    const changes: FileChange[] = [{ path, text }];
    const oldPath = doc.original.path;

    if (existed && oldPath && oldPath !== path) {
      changes.push({ path: oldPath, remove: true });
    }

    // 系列第一次建章：顺手补一个目录页，否则章节在侧栏里没有入口
    if (doc.meta.mode === 'series' && doc.meta.series.trim()) {
      const series = doc.meta.series.trim();
      const indexPath = seriesIndexPath(series);
      const indexId = idFromPath(indexPath);
      let hasIndex =
        indexPath === path ||
        (oldPath && oldPath === indexPath) ||
        state.entries.some((entry) => entry.id === indexId && entry.path === indexPath);
      if (!hasIndex) {
        // 清单可能是构建期快照 / 还没同步到，再问一次仓库，避免把已有目录页覆盖掉
        hasIndex = Boolean(await getFile(indexPath));
      }
      if (!hasIndex) {
        changes.push({ path: indexPath, text: buildSeriesIndex(series, docToDraft(doc)) });
      }
    }

    const message = existed ? `post: update ${doc.meta.title}` : `post: add ${doc.meta.title}`;
    await commitFiles(changes, message);

    const newId = idFromPath(path);
    doc.isNew = false;
    doc.path = path;
    doc.originalPath = path;
    doc.id = newId;
    doc.key = newId;
    doc.original = {
      slug: doc.meta.slug,
      series: doc.meta.series,
      seriesOrder: doc.meta.seriesOrder,
      path,
    };

    removeLocalDrafts([oldPath, path, 'new']);
    state.dirty = false;
    state.lastSavedAt = nowTime();
    state.lastLocalAt = 0;
    state.pendingDraft = null;

    state.entries = state.entries.filter(
      (entry) => entry.id !== newId && (!oldPath || entry.path !== oldPath),
    );
    state.entries.push(entryFromDoc(doc, path, newId));
    // 新建系列时把目录页也补进清单（如果还没有）
    if (doc.meta.mode === 'series' && doc.meta.series.trim()) {
      const indexPath = seriesIndexPath(doc.meta.series.trim());
      const indexId = idFromPath(indexPath);
      if (!state.entries.some((entry) => entry.id === indexId)) {
        state.entries.push(
          entryFromText(
            indexPath,
            buildSeriesIndex(doc.meta.series.trim(), docToDraft(doc)),
          ),
        );
      }
    }
    state.entries = sortEntries(state.entries);

    renderEditor();
    renderList();
    updateUrl(newId);
    writePref('wx-last', newId);
    showToast(path !== oldPath && existed ? '已保存并重命名文件' : '已提交，约 1 分钟后生效');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败');
  } finally {
    state.busy = false;
    updateSaveState();
  }
}

function updateUrl(id: string): void {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('slug', id);
    else url.searchParams.delete('slug');
    window.history.replaceState({}, '', url);
  } catch {
    /* 忽略 */
  }
}

function clearEditor(): void {
  state.current = null;
  state.dirty = false;
  state.pendingDraft = null;
  state.lastSavedAt = '';
  state.lastLocalAt = 0;
  renderEditor();
  renderList();
  updateUrl('');
}

/* ============================================================
   删除
   ============================================================ */

async function deleteCurrent(): Promise<void> {
  const doc = state.current;
  if (!doc || !isAuthed()) return;
  if (doc.isNew) {
    if (!window.confirm('放弃这篇还没保存的新文章？')) return;
    clearEditor();
    return;
  }

  if (!window.confirm(`删除「${doc.meta.title}」？这个操作不能撤销。`)) return;

  state.busy = true;
  updateSaveState();
  try {
    await commitFiles([{ path: doc.originalPath, remove: true }], `post: delete ${doc.meta.title}`);
    state.entries = state.entries.filter((entry) => entry.path !== doc.originalPath);
    removeLocalDrafts([doc.originalPath]);
    closeDialog();
    clearEditor();
    showToast('已删除，约 1 分钟后生效');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除失败');
  } finally {
    state.busy = false;
    updateSaveState();
  }
}

/* ============================================================
   文章信息 / 新建文章弹窗
   ============================================================ */

function dialog(): HTMLDialogElement | null {
  return $<HTMLDialogElement>('[data-wx-dialog]');
}

/* 弹窗打开期间锁住页面滚动（含滚轮 / 触屏），关窗再恢复 */
let pageScrollLocked = false;
let lockedScrollY = 0;

function lockPageScroll(): void {
  if (pageScrollLocked) return;
  pageScrollLocked = true;
  lockedScrollY = window.scrollY;
  // 去掉滚动条会让内容横跳一下，用等宽的 padding 补回来
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
  document.documentElement.classList.add('wx-dialog-open');
}

function unlockPageScroll(): void {
  if (!pageScrollLocked) return;
  pageScrollLocked = false;
  document.documentElement.classList.remove('wx-dialog-open');
  document.body.style.paddingRight = '';
  // 弹窗期间页面不该动过；万一浏览器把焦点滚动带偏了，这里再对回来
  if (Math.abs(window.scrollY - lockedScrollY) > 1) window.scrollTo(0, lockedScrollY);
}

// 站点有滚轮惯性脚本（smooth-wheel.ts）会直接改 scrollTop，
// 只靠 overflow:hidden 拦不住，所以弹窗打开时在捕获阶段把外层滚轮截掉。
document.addEventListener(
  'wheel',
  (event) => {
    if (!pageScrollLocked) return;
    const target = event.target instanceof Element ? event.target : null;
    const body = target?.closest<HTMLElement>('.wx-dialog__body');
    // 弹窗内容本身能滚就放行；滚到边缘由 overscroll-behavior: contain 拦住
    if (body && body.scrollHeight > body.clientHeight + 1) return;
    event.preventDefault();
    event.stopPropagation();
  },
  { passive: false, capture: true },
);

document.addEventListener(
  'touchmove',
  (event) => {
    if (!pageScrollLocked) return;
    const target = event.target instanceof Element ? event.target : null;
    const body = target?.closest<HTMLElement>('.wx-dialog__body');
    if (body && body.scrollHeight > body.clientHeight + 1) return;
    event.preventDefault();
  },
  { passive: false, capture: true },
);

function dInput(selector: string): HTMLInputElement | null {
  return $<HTMLInputElement>(selector);
}

function dTextarea(selector: string): HTMLTextAreaElement | null {
  return $<HTMLTextAreaElement>(selector);
}

function dSelect(selector: string): HTMLSelectElement | null {
  return $<HTMLSelectElement>(selector);
}

function dialogMode(): 'single' | 'series' {
  const checked = $<HTMLInputElement>('input[name="wx-dmode"]:checked');
  return checked?.value === 'series' ? 'series' : 'single';
}

function setDialogMode(mode: 'single' | 'series'): void {
  for (const radio of $$<HTMLInputElement>('input[name="wx-dmode"]')) {
    radio.checked = radio.value === mode;
  }
  const fields = $<HTMLElement>('[data-wx-d-series-fields]');
  if (fields) {
    fields.hidden = mode !== 'series';
    fields.classList.toggle('hidden', mode !== 'series');
    fields.classList.toggle('grid', mode === 'series');
  }
  const details = $<HTMLDetailsElement>('[data-wx-details]');
  if (details && mode === 'series') details.open = true;
  syncDialogTaxonomy();
}

/**
 * 分类 / 标签只属于系列导读（目录页）。
 * 写作台里选中「系列 + 章节」时把这两个输入藏起来，避免以后又写回章节 frontmatter。
 */
function isDialogSeriesChapter(): boolean {
  if (dialogMode() !== 'series') return false;
  const order = dInput('[data-wx-d-order]')?.value.trim() ?? '';
  const slug = dInput('[data-wx-d-slug]')?.value.trim() ?? '';
  return order !== '0' && slug !== 'index' && !slug.endsWith('/index');
}

/** 系列还没有导读页：首次保存会自动建导读，分类 / 标签得先在这里填。 */
function chapterCreatesSeriesIndex(): boolean {
  if (!isDialogSeriesChapter()) return false;
  const series = dInput('[data-wx-d-series]')?.value.trim() ?? '';
  return Boolean(series) && !seriesIndexEntry(series);
}

function syncDialogTaxonomy(): void {
  const isChapter = isDialogSeriesChapter();
  const createsIndex = isChapter && chapterCreatesSeriesIndex();
  const showTaxonomy = !isChapter || createsIndex;
  const taxonomy = $<HTMLElement>('[data-wx-d-taxonomy]');
  const note = $<HTMLElement>('[data-wx-d-taxonomy-note]');
  if (taxonomy) {
    taxonomy.hidden = !showTaxonomy;
    taxonomy.classList.toggle('hidden', !showTaxonomy);
  }
  if (note) {
    note.hidden = !isChapter;
    if (isChapter) {
      note.textContent = createsIndex
        ? '这个系列还没有导读。首次保存会自动创建导读，分类和标签会写进导读，不会写进本章。'
        : '分类和标签由系列导读统一管理，章节不再单独填写。';
    }
  }
}

function seriesTitles(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of state.entries) {
    if (!entry.series) continue;
    const current = map.get(entry.series);
    // 章节通常不写 seriesTitle，优先用介绍页 / 任一带标题的成员
    if (!current || (entry.seriesTitle && current === entry.series)) {
      map.set(entry.series, entry.seriesTitle || current || entry.series);
    }
  }
  return map;
}

function populateSeriesSelect(selected: string): void {
  const select = dSelect('[data-wx-d-series-select]');
  if (!select) return;

  const map = seriesTitles();
  select.replaceChildren();
  select.append(new Option('新建系列…', '__new'));
  for (const [key, title] of map) select.append(new Option(title || key, key));

  if (selected && !map.has(selected)) select.append(new Option(selected, selected));
  select.value = selected || '__new';
}

function nextSeriesOrder(series: string): string {
  const key = series.trim();
  if (!key) return '1';
  let max = 0;
  for (const entry of state.entries) {
    if (entry.series !== key) continue;
    const order = entry.seriesOrder ?? 0;
    if (order > max) max = order;
  }
  return String(max + 1);
}

function readDialogMeta(): DocMeta {
  const order = dInput('[data-wx-d-order]')?.value.trim() ?? '';
  return {
    mode: dialogMode(),
    title: dInput('[data-wx-d-title]')?.value.trim() ?? '',
    slug: dInput('[data-wx-d-slug]')?.value.trim() ?? '',
    date: dInput('[data-wx-d-date]')?.value || today(),
    updated: dInput('[data-wx-d-updated]')?.value || '',
    description: dTextarea('[data-wx-d-description]')?.value.trim() ?? '',
    categories: dInput('[data-wx-d-categories]')?.value.trim() ?? '',
    tags: dInput('[data-wx-d-tags]')?.value.trim() ?? '',
    image: dInput('[data-wx-d-image]')?.value.trim() ?? '',
    attachments: dTextarea('[data-wx-d-attachments]')?.value.trim() ?? '',
    badge: dInput('[data-wx-d-badge]')?.checked ?? false,
    draft: dInput('[data-wx-d-draft]')?.checked ?? false,
    tocDepth: dInput('[data-wx-d-toc-depth]')?.value.trim() ?? '',
    series: dInput('[data-wx-d-series]')?.value.trim() ?? '',
    seriesOrder: order,
    seriesTitle: dInput('[data-wx-d-series-title]')?.value.trim() ?? '',
  };
}

function fillDialog(meta: DocMeta | null): void {
  const isEdit = Boolean(meta);
  setText('[data-wx-dialog-title]', isEdit ? '文章信息' : '新建文章');
  setText('[data-wx-dialog-submit]', isEdit ? '应用修改' : '进入编辑');

  dInput('[data-wx-d-title]')!.value = meta?.title ?? '';
  dInput('[data-wx-d-slug]')!.value = meta?.slug ?? '';
  dInput('[data-wx-d-date]')!.value = meta?.date || today();
  dInput('[data-wx-d-updated]')!.value = meta?.updated ?? '';
  dTextarea('[data-wx-d-description]')!.value = meta?.description ?? '';
  dInput('[data-wx-d-categories]')!.value = meta?.categories ?? '';
  dInput('[data-wx-d-tags]')!.value = meta?.tags ?? '';
  dInput('[data-wx-d-image]')!.value = meta?.image ?? '';
  dTextarea('[data-wx-d-attachments]')!.value = meta?.attachments ?? '';
  dInput('[data-wx-d-badge]')!.checked = meta?.badge ?? false;
  dInput('[data-wx-d-draft]')!.checked = meta?.draft ?? false;
  dInput('[data-wx-d-toc-depth]')!.value = meta?.tocDepth ?? '';

  setDialogMode(meta?.mode ?? 'single');
  populateSeriesSelect(meta?.series ?? '');
  dInput('[data-wx-d-series]')!.value = meta?.series ?? '';
  dInput('[data-wx-d-series-title]')!.value = meta?.seriesTitle ?? '';
  dInput('[data-wx-d-order]')!.value = meta?.seriesOrder ?? '';

  const slugEl = dInput('[data-wx-d-slug]');
  if (slugEl) slugEl.dataset.touched = meta && !state.current?.isNew ? '1' : '';
  const danger = $<HTMLElement>('[data-wx-d-danger]');
  if (danger) danger.hidden = !isEdit || Boolean(state.current?.isNew);

  updateCoverThumb();
  syncDialogTaxonomy();
}

function updateCoverThumb(): void {
  const thumb = $<HTMLImageElement>('[data-wx-d-cover-thumb]');
  const value = dInput('[data-wx-d-image]')?.value.trim() ?? '';
  if (!thumb) return;
  thumb.hidden = !value;
  if (value) thumb.src = value;
}

function openDialog(mode: DialogMode): void {
  if (!isAuthed()) {
    showToast('请先用 GitHub 授权');
    return;
  }
  const el = dialog();
  if (!el) return;

  state.dialogMode = mode;
  if (mode === 'create') {
    fillDialog(null);
    state.slugTouched = false;
  } else {
    if (!state.current) {
      state.dialogMode = 'create';
      fillDialog(null);
    } else {
      fillDialog(state.current.meta);
      state.slugTouched = !state.current.isNew;
    }
  }

  if (!el.open) {
    lockPageScroll();
    el.showModal();
  }
  window.setTimeout(() => {
    const title = dInput('[data-wx-d-title]');
    title?.focus({ preventScroll: true });
    title?.select();
  }, 30);
}

function closeDialog(): void {
  const el = dialog();
  if (el?.open) el.close();
  unlockPageScroll();
  const tip = document.getElementById('wx-tooltip');
  if (tip) tip.hidden = true;
}

function applyDialogMeta(): void {
  let meta = readDialogMeta();

  if (!meta.title) {
    showToast('标题不能为空');
    dInput('[data-wx-d-title]')?.focus();
    return;
  }
  if (!meta.slug) {
    meta.slug = autoSlug(meta);
    if (!meta.slug) {
      showToast('文件名不能为空');
      return;
    }
  }
  if (!meta.date) meta.date = today();

  if (meta.mode === 'series') {
    meta.series = meta.series.trim().replace(/^\/+|\/+$/g, '');
    if (!meta.series) {
      showToast('请填写系列标识（英文目录名）');
      dInput('[data-wx-d-series]')?.focus();
      return;
    }
    if (!meta.seriesOrder.trim()) meta.seriesOrder = nextSeriesOrder(meta.series);
    if (!meta.seriesTitle) {
      const existingTitle = seriesTitles().get(meta.series);
      // 已有系列：章节没必要重复写 seriesTitle；只有新建系列时才用章节标题兜底
      if (state.dialogMode === 'create' || !existingTitle) {
        meta.seriesTitle = existingTitle || meta.title;
      }
    }
  } else {
    // 从系列改回单篇：清掉系列字段，保存时才会真的移出系列目录
    meta.series = '';
    meta.seriesOrder = '';
    meta.seriesTitle = '';
  }

  // 章节自己的分类/标签已经不再使用；但如果这个系列还没有导读，
  // 首次保存会拿这份草稿自动建导读，所以先留着，让导读继承分类 / 标签。
  const chapter = meta.mode === 'series' && meta.seriesOrder.trim() !== '0' && meta.slug !== 'index' && !meta.slug.endsWith('/index');
  const hasIndex = Boolean(meta.series.trim() && seriesIndexEntry(meta.series.trim()));
  if (chapter && hasIndex) {
    meta.categories = '';
    meta.tags = '';
  }

  if (state.dialogMode === 'create') {
    closeDialog();
    createNewDoc(meta);
    showToast('新文章草稿已创建，写完点保存');
    return;
  }

  const doc = state.current;
  if (!doc) return;
  doc.meta = meta;
  closeDialog();
  state.dirty = true;
  renderEditor();
  markDirty();
  showToast('文章信息已更新，保存后生效');
}

function bindDialog(): void {
  const el = dialog();
  if (!el) return;

  for (const button of $$('[data-wx-dialog-close]')) {
    button.addEventListener('click', () => closeDialog());
  }

  const form = $<HTMLFormElement>('[data-wx-dialog-form]');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    applyDialogMeta();
  });

  for (const radio of $$<HTMLInputElement>('input[name="wx-dmode"]')) {
    radio.addEventListener('change', () => {
      setDialogMode(dialogMode());
      const slugEl = dInput('[data-wx-d-slug]');
      if (slugEl && slugEl.dataset.touched !== '1') {
        slugEl.value = autoSlug(readDialogMeta());
      }
      syncDialogTaxonomy();
      const fields = $<HTMLElement>('[data-wx-d-series-fields]');
      if (fields && dialogMode() === 'series' && !dInput('[data-wx-d-series]')?.value) {
        dInput('[data-wx-d-series]')?.focus();
      }
    });
  }

  dSelect('[data-wx-d-series-select]')?.addEventListener('change', () => {
    const value = dSelect('[data-wx-d-series-select]')?.value ?? '';
    const seriesInput = dInput('[data-wx-d-series]');
    const titleInput = dInput('[data-wx-d-series-title]');
    const orderInput = dInput('[data-wx-d-order]');
    if (!seriesInput) return;

    if (value === '__new') {
      seriesInput.value = '';
      if (titleInput) titleInput.value = '';
      if (orderInput) orderInput.value = '';
      seriesInput.focus();
      return;
    }

    seriesInput.value = value;
    if (titleInput) titleInput.value = seriesTitles().get(value) ?? '';
    if (orderInput && state.dialogMode === 'create') orderInput.value = nextSeriesOrder(value);
    syncDialogTaxonomy();
  });

  dInput('[data-wx-d-title]')?.addEventListener('input', () => {
    const slugEl = dInput('[data-wx-d-slug]');
    if (!slugEl || slugEl.dataset.touched === '1') return;
    const meta = readDialogMeta();
    slugEl.value = autoSlug(meta);
  });

  dInput('[data-wx-d-slug]')?.addEventListener('input', () => {
    const slugEl = dInput('[data-wx-d-slug]');
    if (slugEl) slugEl.dataset.touched = '1';
    syncDialogTaxonomy();
  });

  dInput('[data-wx-d-order]')?.addEventListener('input', syncDialogTaxonomy);

  dInput('[data-wx-d-date]')?.addEventListener('input', () => {
    const slugEl = dInput('[data-wx-d-slug]');
    if (!slugEl || slugEl.dataset.touched === '1') return;
    const meta = readDialogMeta();
    slugEl.value = autoSlug(meta);
  });

  dInput('[data-wx-d-image]')?.addEventListener('input', updateCoverThumb);
  $('[data-wx-d-cover-pick]')?.addEventListener('click', async () => {
    if (!isAuthed()) {
      showToast('请先用 GitHub 授权');
      return;
    }
    const picked = await openMediaDialog({ mode: 'pick', folder: 'covers', hint: '选一张封面' });
    if (!picked) return;
    const imageEl = dInput('[data-wx-d-image]');
    if (imageEl) imageEl.value = picked.url;
    updateCoverThumb();
  });
  $('[data-wx-d-cover-clear]')?.addEventListener('click', () => {
    const imageEl = dInput('[data-wx-d-image]');
    if (imageEl) imageEl.value = '';
    updateCoverThumb();
  });

  $('[data-wx-d-danger]')?.addEventListener('click', () => void deleteCurrent());

  el.addEventListener('click', (event) => {
    if (event.target === el) el.close();
  });
  el.addEventListener('close', () => {
    unlockPageScroll();
    const tip = document.getElementById('wx-tooltip');
    if (tip) tip.hidden = true;
  });
}

/* ============================================================
   智能快捷操作（右栏）
   ============================================================ */

function ensureEditable(): HTMLTextAreaElement | null {
  const editor = getEditor();
  if (!editor || !state.current) {
    showToast('先新建或选择一篇文章');
    return null;
  }
  return editor;
}

async function pickAndInsert(folder: 'posts' | 'files'): Promise<void> {
  if (!isAuthed()) {
    showToast('请先用 GitHub 授权');
    return;
  }
  const editor = ensureEditable();
  if (!editor) return;

  const picked = await openMediaDialog({
    mode: 'insert',
    folder,
    hint: folder === 'posts' ? '选图插入正文' : '选附件插入正文',
  });
  if (!picked) return;

  insertBlock(editor, picked.files.map((file) => mediaToMarkdown(file)).join('\n\n'));
}

/** 窄屏下（手机底部面板 / 平板侧抽屉）点完动作就收起，把编辑区让出来 */
function closeToolsOnNarrow(): void {
  if (window.innerWidth >= 1024 || !state.rightOpen) return;
  state.rightOpen = false;
  writePref('wx-right-open', '0');
  applyPanelState();
}

function handleTool(button: HTMLElement): void {
  const editor = ensureEditable();
  if (!editor) return;
  const tool = button.dataset.wxTool ?? '';

  switch (tool) {
    case 'heading': {
      const level = Number(button.dataset.level ?? '1');
      prefixLines(editor, `${'#'.repeat(Math.min(6, Math.max(1, level)))} `, { toggle: true });
      break;
    }
    case 'bold':
      surround(editor, '**', '**', '加粗文字');
      break;
    case 'italic':
      surround(editor, '*', '*', '斜体文字');
      break;
    case 'strike':
      surround(editor, '~~', '~~', '删除线');
      break;
    case 'incline':
      surround(editor, '`', '`', '行内代码');
      break;
    case 'link':
      insertLink(editor);
      break;
    case 'footnote':
      insertFootnote(editor, '');
      break;
    case 'ul':
      prefixLines(editor, '- ');
      break;
    case 'ol':
      prefixLines(editor, '1. ');
      break;
    case 'task':
      prefixLines(editor, '- [ ] ');
      break;
    case 'quote':
      prefixLines(editor, '> ');
      break;
    case 'hr':
      insertBlock(editor, '---');
      break;
    case 'codeblock': {
      const lang = dSelect('[data-wx-lang]')?.value ?? '';
      insertCodeBlock(editor, lang);
      break;
    }
    case 'date':
      insertInline(editor, formatDate(new Date(), 'YYYY-MM-DD'));
      break;
    case 'image':
      void pickAndInsert('posts');
      break;
    case 'attach':
      void pickAndInsert('files');
      break;
    case 'table':
      openTablePicker(button);
      break;
    default:
      break;
  }

  closeToolsOnNarrow();
}

/* ---------------- 表格选择器 ---------------- */

function openTablePicker(anchor: HTMLElement): void {
  const picker = $<HTMLElement>('[data-wx-tablepicker]');
  const grid = $<HTMLElement>('[data-wx-tablegrid]');
  const label = $<HTMLElement>('[data-wx-tabledim]');
  if (!picker || !grid || !label) return;

  let hoverCol = 0;
  let hoverRow = 0;
  grid.replaceChildren();

  for (let row = 1; row <= 5; row += 1) {
    for (let col = 1; col <= 6; col += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'wx-tablepicker__cell';
      cell.dataset.col = String(col);
      cell.dataset.row = String(row);
      cell.setAttribute('aria-label', `${col} 列 ${row} 行`);
      cell.addEventListener('pointerenter', () => {
        hoverCol = col;
        hoverRow = row;
        paint();
      });
      cell.addEventListener('click', () => {
        const editor = ensureEditable();
        if (editor) insertTable(editor, hoverCol || col, hoverRow || row);
        hide();
      });
      grid.append(cell);
    }
  }

  const paint = (): void => {
    for (const cell of grid.querySelectorAll<HTMLElement>('.wx-tablepicker__cell')) {
      const col = Number(cell.dataset.col);
      const row = Number(cell.dataset.row);
      cell.classList.toggle('is-on', col <= hoverCol && row <= hoverRow);
    }
    label.textContent =
      hoverCol && hoverRow ? `${hoverCol} 列 × ${hoverRow} 行` : '移动鼠标选择表格大小';
  };

  const hide = (): void => {
    picker.hidden = true;
    document.removeEventListener('pointerdown', onOutside, true);
  };

  const onOutside = (event: PointerEvent): void => {
    if (picker.contains(event.target as Node)) return;
    hide();
  };

  paint();
  picker.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const width = picker.offsetWidth || 210;
  const height = picker.offsetHeight || 190;
  let left = rect.right - width;
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;

  window.setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}

/* ============================================================
   编辑器输入 / 键盘
   ============================================================ */

function bindEditor(): void {
  const titleEl = $<HTMLInputElement>('[data-wx-title]');
  const bodyEl = $<HTMLTextAreaElement>('[data-wx-body]');

  titleEl?.addEventListener('input', () => {
    const doc = state.current;
    if (!doc) return;
    doc.meta.title = titleEl.value;
    if (!state.slugTouched) doc.meta.slug = autoSlug(doc.meta);
    updateChips();
    updateSaveState();
    markDirty();
  });

  bodyEl?.addEventListener('input', () => {
    const doc = state.current;
    if (!doc) return;
    doc.body = bodyEl.value;
    updateStats();
    updateGutter();
    markDirty();
  });

  bodyEl?.addEventListener('click', updateStats);
  bodyEl?.addEventListener('keyup', updateStats);
  bodyEl?.addEventListener('scroll', () => {
    const gutter = $<HTMLElement>('[data-wx-gutter]');
    if (gutter && bodyEl) gutter.scrollTop = bodyEl.scrollTop;
  });

  bodyEl?.addEventListener('keydown', (event) => {
    if (!state.current) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && key === 's') {
      event.preventDefault();
      void saveDoc();
      return;
    }
    if (mod && key === 'b') {
      event.preventDefault();
      surround(bodyEl, '**', '**', '加粗文字');
      return;
    }
    if (mod && key === 'i') {
      event.preventDefault();
      surround(bodyEl, '*', '*', '斜体文字');
      return;
    }
    if (mod && key === 'k') {
      event.preventDefault();
      insertLink(bodyEl);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const value = bodyEl.value;
      const start = bodyEl.selectionStart ?? 0;
      const end = bodyEl.selectionEnd ?? start;
      const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const nextBreak = value.indexOf('\n', end);
      const lineEnd = nextBreak === -1 ? value.length : nextBreak;

      if (event.shiftKey) {
        const block = value.slice(lineStart, lineEnd);
        const next = block.replace(/^ {1,2}/gm, '');
        bodyEl.setRangeText(next, lineStart, lineEnd, 'select');
      } else if (start !== end || value.slice(lineStart, start).trim() === '') {
        const block = value.slice(lineStart, lineEnd);
        const next = block
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n');
        bodyEl.setRangeText(next, lineStart, lineEnd, 'select');
      } else {
        bodyEl.setRangeText('  ', start, end, 'end');
      }
      bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (event.key === 'Enter') {
      const value = bodyEl.value;
      const start = bodyEl.selectionStart ?? 0;
      const end = bodyEl.selectionEnd ?? start;
      const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const lineEnd = value.indexOf('\n', start) === -1 ? value.length : value.indexOf('\n', start);
      const line = value.slice(lineStart, lineEnd);
      const match = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
      if (!match) return;

      const content = `${match[4] ?? ''}${value.slice(start, lineEnd)}`;
      event.preventDefault();

      if (!content.trim() && start === end) {
        bodyEl.setRangeText('', lineStart, lineEnd, 'end');
      } else {
        let marker = match[2] ?? '-';
        if (/^\d/.test(marker)) {
          marker = `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`;
        }
        const task = match[3] ? '[ ] ' : '';
        bodyEl.setRangeText(`\n${match[1] ?? ''}${marker} ${task}`, start, end, 'end');
      }
      bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  bodyEl?.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    void uploadFiles(files);
  });
}

/* ============================================================
   上传（拖拽 / 粘贴）
   ============================================================ */

async function uploadDroppedFile(file: File): Promise<MediaFile | null> {
  const { uploadImage, uploadFile } = await import('../../utils/media');

  if (file.type.startsWith('image/')) {
    const result = await uploadImage(file, { folder: 'posts' });
    return {
      key: result.key,
      name: result.key.split('/').pop() ?? result.key,
      url: result.url,
      size: result.size,
      uploaded: new Date().toISOString(),
      type: result.type,
    };
  }

  const result = await uploadFile(file, { folder: 'files' });
  return {
    key: result.key,
    name: result.key.split('/').pop() ?? result.key,
    url: result.url,
    size: result.size,
    uploaded: new Date().toISOString(),
    type: result.type,
  };
}

async function uploadFiles(files: File[]): Promise<void> {
  if (!isAuthed()) {
    showToast('请先用 GitHub 授权');
    return;
  }
  const editor = ensureEditable();
  if (!editor) return;

  const uploaded: MediaFile[] = [];
  let done = 0;
  for (const file of files) {
    done += 1;
    showToast(`上传 ${done}/${files.length}：${file.name}`);
    try {
      const media = await uploadDroppedFile(file);
      if (media) uploaded.push(media);
    } catch (error) {
      showToast(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`);
    }
  }

  if (!uploaded.length) return;
  insertBlock(editor, uploaded.map((file) => mediaToMarkdown(file)).join('\n\n'));
  showToast(`已上传并插入 ${uploaded.length} 个文件`);
}

function bindDropZone(): void {
  const app = $<HTMLElement>('[data-wx-app]');
  const veil = $<HTMLElement>('[data-wx-drop]');
  if (!app) return;

  let depth = 0;
  const show = (): void => {
    depth += 1;
    if (veil) {
      veil.hidden = false;
      veil.classList.add('is-visible');
    }
  };
  const hide = (): void => {
    depth = 0;
    if (veil) {
      veil.hidden = true;
      veil.classList.remove('is-visible');
    }
  };

  app.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    show();
  });
  app.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  app.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });
  app.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    hide();
    const mdFiles = files.filter((file) => /\.(md|markdown|mdx|txt)$/i.test(file.name));
    if (mdFiles.length) void importMarkdownFiles(mdFiles);
    else void uploadFiles(files);
  });
}

/* ============================================================
   导入 .md
   ============================================================ */

function slugFromFilename(name: string): string {
  return name
    .replace(/\.(md|markdown|mdx|txt)$/i, '')
    .trim()
    .replace(/['"’]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function draftFromFile(name: string, text: string): PostDraft {
  const { data, body } = parseMarkdown(text);
  const fallbackTitle = slugFromFilename(name) || '未命名文章';
  const series = unquote(data.series ?? '').trim();
  const rawOrder = unquote(String(data.seriesOrder ?? '')).trim();
  const rawTocDepth = unquote(data.tocDepth ?? '').trim();

  return {
    mode: series ? 'series' : 'single',
    title: unquote(data.title ?? '').trim() || fallbackTitle,
    slug: slugFromFilename(name) || slugify(unquote(data.title ?? '')) || 'post',
    date: (unquote(data.date ?? '').trim() || today()).slice(0, 10),
    updated: (unquote(data.updated ?? '').trim() || '').slice(0, 10),
    description: unquote(data.description ?? ''),
    categories: parseList(data.categories ?? '').join(', '),
    tags: parseList(data.tags ?? '').join(', '),
    image: unquote(data.image ?? ''),
    attachments: parseList(data.attachments ?? '').join('\n'),
    badge: unquote(data.badge ?? '') === 'Pin',
    draft: unquote(data.draft ?? '').toLowerCase() === 'true',
    tocDepth: /^[1-6]$/.test(rawTocDepth) ? rawTocDepth : '',
    body: body.replace(/^\s+/, ''),
    series,
    seriesOrder: rawOrder,
    seriesTitle: unquote(data.seriesTitle ?? ''),
  };
}

function uniqueSlug(slug: string, used: Set<string>): string {
  let candidate = slug;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${slug}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

async function importMarkdownFiles(files: File[]): Promise<void> {
  const markdownFiles = files.filter((file) => /\.(md|markdown|mdx|txt)$/i.test(file.name));
  if (!markdownFiles.length) {
    showToast('只支持 .md / .markdown / .txt 文件');
    return;
  }
  if (!isAuthed()) {
    showToast('请先用 GitHub 授权');
    return;
  }

  if (markdownFiles.length === 1) {
    const file = markdownFiles[0] as File;
    if (
      state.current &&
      state.dirty &&
      !window.confirm('当前文章还有未提交的更改，导入会覆盖编辑区。继续吗？')
    ) {
      return;
    }
    const text = await file.text();
    const draft = draftFromFile(file.name, text);
    const current = state.current;
    // 和旧版一致：正在写某个系列时导入一个没有 series 字段的章节，
    // 就把它接在这个系列里，而不是退回单篇。
    if (
      draft.mode === 'single' &&
      current?.meta.mode === 'series' &&
      current.meta.series.trim()
    ) {
      draft.mode = 'series';
      draft.series = current.meta.series.trim();
      draft.seriesTitle = current.meta.seriesTitle || '';
    }
    if (draft.mode === 'series' && !draft.seriesOrder) {
      draft.seriesOrder = nextSeriesOrder(draft.series);
    }
    const doc = docFromDraft(draft, true);
    state.current = doc;
    state.dirty = true;
    state.slugTouched = true;
    state.pendingDraft = null;
    state.lastSavedAt = '';
    state.lastLocalAt = 0;
    state.mode = 'edit';
    renderEditor();
    renderList();
    updateUrl('');
    markDirty();
    closeMobileDrawers();
    showToast(`已导入「${file.name}」，检查后点保存`);
    return;
  }

  const current = state.current;
  const seriesMode =
    current?.meta.mode === 'series' && Boolean(current.meta.series.trim())
      ? current.meta.series.trim()
      : '';
  const useSeries = Boolean(seriesMode);

  if (
    !window.confirm(
      useSeries
        ? `把这 ${markdownFiles.length} 个文件作为「${seriesMode}」的章节提交（按文件名顺序编号）？`
        : `把这 ${markdownFiles.length} 个文件当作独立文章提交？`,
    )
  ) {
    return;
  }

  state.busy = true;
  updateSaveState();

  try {
    const sorted = useSeries
      ? [...markdownFiles].sort((a, b) =>
          a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
        )
      : markdownFiles;
    const used = new Set<string>();
    const changes: FileChange[] = [];
    let order = useSeries ? Number(nextSeriesOrder(seriesMode)) : 1;

    for (const file of sorted) {
      const text = await file.text();
      const draft = draftFromFile(file.name, text);
      draft.slug = uniqueSlug(draft.slug, used);

      if (useSeries) {
        draft.mode = 'series';
        draft.series = seriesMode;
        draft.seriesOrder = String(order);
        if (!draft.seriesTitle) draft.seriesTitle = current?.meta.seriesTitle ?? '';
        changes.push({
          path: `${POSTS_DIR}/${seriesMode}/${padOrder(order)}-${draft.slug}.md`,
          text: buildMarkdown(draft),
        });
        order += 1;
      } else {
        changes.push({ path: `${POSTS_DIR}/${draft.slug}.md`, text: buildMarkdown(draft) });
      }
    }

    if (useSeries) {
      const indexPath = seriesIndexPath(seriesMode);
      const indexId = idFromPath(indexPath);
      if (!state.entries.some((entry) => entry.id === indexId)) {
        changes.push({
          path: indexPath,
          text: buildSeriesIndex(seriesMode, {
            ...draftFromFile('index.md', ''),
            title: current?.meta.seriesTitle || seriesMode,
            mode: 'series',
            series: seriesMode,
            seriesTitle: current?.meta.seriesTitle || seriesMode,
            seriesOrder: '0',
          }),
        });
      }
    }

    await commitFiles(
      changes,
      useSeries
        ? `post: 批量导入「${seriesMode}」系列 ${markdownFiles.length} 章`
        : `post: 批量导入 ${markdownFiles.length} 篇文章`,
    );

    await syncEntries({ silent: true });
    showToast(`已导入 ${markdownFiles.length} 篇，约 1 分钟后生效`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '批量导入失败');
  } finally {
    state.busy = false;
    updateSaveState();
  }
}

/* ============================================================
   批量管理
   ============================================================ */

async function batchSetDraft(draft: boolean): Promise<void> {
  const list = selectedEntries();
  if (!list.length) {
    showToast('先选择要操作的文章');
    return;
  }
  if (!isAuthed()) return;

  const currentAffected =
    state.current && !state.current.isNew && list.some((entry) => entry.id === state.current?.id);
  if (currentAffected && state.dirty) {
    showToast('当前文章有未保存的更改，先保存再批量操作');
    return;
  }
  if (!window.confirm(`把选中的 ${list.length} 篇设为${draft ? '草稿' : '已发布'}？`)) return;

  state.busy = true;
  updateSaveState();

  try {
    const changes: FileChange[] = [];
    const updatedIds = new Set<string>();
    for (const entry of list) {
      const file = await getFile(entry.path);
      if (!file) continue;
      changes.push({ path: entry.path, text: patchFrontmatter(file.text, { draft }) });
      updatedIds.add(entry.id);
    }
    if (!changes.length) throw new Error('没有可更新的文件');

    await commitFiles(
      changes,
      `post: 批量${draft ? '转为草稿' : '发布'} ${changes.length} 篇`,
    );

    for (const entry of state.entries) {
      if (updatedIds.has(entry.id)) entry.draft = draft;
    }
    if (currentAffected && state.current) {
      state.current.meta.draft = draft;
      updateChips();
      updateSaveState();
    }

    state.selected.clear();
    setBatch(false);
    renderList();
    showToast(`已更新 ${changes.length} 篇，约 1 分钟后生效`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '批量更新失败');
  } finally {
    state.busy = false;
    updateSaveState();
  }
}

async function batchDelete(): Promise<void> {
  const list = selectedEntries();
  if (!list.length) {
    showToast('先选择要删除的文章');
    return;
  }
  if (!isAuthed()) return;
  if (!window.confirm(`删除选中的 ${list.length} 篇文章？这个操作不能撤销。`)) return;

  state.busy = true;
  updateSaveState();

  try {
    const changes: FileChange[] = list.map((entry) => ({ path: entry.path, remove: true }));
    await commitFiles(changes, `post: 批量删除 ${list.length} 篇`);

    const removed = new Set(list.map((entry) => entry.id));
    state.entries = state.entries.filter((entry) => !removed.has(entry.id));
    if (state.current && !state.current.isNew && removed.has(state.current.id)) {
      state.current = null;
      state.dirty = false;
      updateUrl('');
    }

    state.selected.clear();
    setBatch(false);
    renderEditor();
    renderList();
    showToast(`已删除 ${list.length} 篇，约 1 分钟后生效`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '批量删除失败');
  } finally {
    state.busy = false;
    updateSaveState();
  }
}

async function batchExport(): Promise<void> {
  const list = selectedEntries();
  if (!list.length) {
    showToast('先选择要导出的文章');
    return;
  }

  let done = 0;
  for (const entry of list) {
    try {
      const file = await getFile(entry.path);
      if (!file) continue;
      downloadText(`${entry.id.replace(/[/\\]/g, '-')}.md`, file.text);
      done += 1;
    } catch {
      /* 单篇失败继续 */
    }
  }
  showToast(done ? `已导出 ${done} 个 .md 文件` : '导出失败');
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   面板 / 视图
   ============================================================ */

function applyPanelState(): void {
  const app = $<HTMLElement>('[data-wx-app]');
  if (app) {
    app.dataset.left = state.leftOpen ? '1' : '0';
    app.dataset.right = state.rightOpen ? '1' : '0';
  }
  for (const button of $$<HTMLElement>('[data-wx-toggle-left]')) {
    button.setAttribute('aria-expanded', state.leftOpen ? 'true' : 'false');
  }
  for (const button of $$<HTMLElement>('[data-wx-toggle-right]')) {
    button.setAttribute('aria-expanded', state.rightOpen ? 'true' : 'false');
  }

  // 窄屏抽屉打开时压一层遮罩，点遮罩收回两侧栏
  const scrim = $<HTMLElement>('[data-wx-scrim]');
  if (scrim) {
    const show = window.innerWidth < 1024 && (state.leftOpen || state.rightOpen);
    scrim.hidden = !show;
  }
}

function closeMobileDrawers(): void {
  if (window.innerWidth >= 1024) return;
  if (!state.leftOpen && !state.rightOpen) return;
  state.leftOpen = false;
  state.rightOpen = false;
  writePref('wx-left-open', '0');
  writePref('wx-right-open', '0');
  applyPanelState();
}

function toggleLeft(): void {
  state.leftOpen = !state.leftOpen;
  if (state.leftOpen && window.innerWidth < 1024) state.rightOpen = false;
  writePref('wx-left-open', state.leftOpen ? '1' : '0');
  writePref('wx-right-open', state.rightOpen ? '1' : '0');
  applyPanelState();
}

function toggleRight(): void {
  state.rightOpen = !state.rightOpen;
  if (state.rightOpen && window.innerWidth < 1024) state.leftOpen = false;
  writePref('wx-right-open', state.rightOpen ? '1' : '0');
  writePref('wx-left-open', state.leftOpen ? '1' : '0');
  applyPanelState();
}

function setRightTab(tab: RightTab): void {
  state.rightTab = tab;
  for (const button of $$<HTMLElement>('[data-wx-tab]')) {
    button.classList.toggle('is-active', button.dataset.wxTab === tab);
  }
  for (const panel of $$<HTMLElement>('[data-wx-panel]')) {
    panel.hidden = panel.dataset.wxPanel !== tab;
  }
}

/* ============================================================
   绑定
   ============================================================ */

function bindDom(): void {
  $$('[data-wx-new]').forEach((button) => {
    button.addEventListener('click', () => openDialog('create'));
  });

  $('[data-wx-save]')?.addEventListener('click', () => void saveDoc());
  $$('[data-wx-toggle-left]').forEach((button) => {
    button.addEventListener('click', toggleLeft);
  });
  $$('[data-wx-toggle-right]').forEach((button) => {
    button.addEventListener('click', toggleRight);
  });
  $$('[data-wx-settings]').forEach((button) => {
    button.addEventListener('click', () => openDialog(state.current ? 'edit' : 'create'));
  });

  for (const button of $$<HTMLElement>('[data-wx-mode]')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.wxMode as ViewMode;
      applyViewMode(mode);
      writePref('wx-mode', mode);
    });
  }

  for (const button of $$<HTMLElement>('[data-wx-filter]')) {
    button.addEventListener('click', () => setFilter(button.dataset.wxFilter as FilterKey));
  }

  const search = $<HTMLInputElement>('[data-wx-search]');
  search?.addEventListener('input', () => {
    state.query = search.value;
    state.selected.clear();
    renderList();
  });

  const sort = $<HTMLSelectElement>('[data-wx-sort]');
  sort?.addEventListener('change', () => {
    state.sort = sort.value as SortKey;
    renderList();
  });

  $('[data-wx-batch]')?.addEventListener('click', () => setBatch(!state.batch));

  const selectAll = $<HTMLInputElement>('[data-wx-selectall]');
  selectAll?.addEventListener('change', () => {
    const list = filteredEntries();
    if (selectAll.checked) for (const entry of list) state.selected.add(entry.id);
    else state.selected.clear();
    renderList();
  });

  $('[data-wx-batch-publish]')?.addEventListener('click', () => void batchSetDraft(false));
  $('[data-wx-batch-draft]')?.addEventListener('click', () => void batchSetDraft(true));
  $('[data-wx-batch-delete]')?.addEventListener('click', () => void batchDelete());
  $('[data-wx-batch-export]')?.addEventListener('click', () => void batchExport());

  const fileInput = $<HTMLInputElement>('[data-wx-import-input]');
  $$('[data-wx-import]').forEach((button) => {
    button.addEventListener('click', () => fileInput?.click());
  });
  fileInput?.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void importMarkdownFiles(files);
  });

  $('[data-wx-sync]')?.addEventListener('click', () => void syncEntries());

  $$('[data-wx-tool]').forEach((button) => {
    button.addEventListener('click', () => handleTool(button));
  });

  for (const button of $$<HTMLElement>('[data-wx-tab]')) {
    button.addEventListener('click', () => setRightTab(button.dataset.wxTab as RightTab));
  }

  $('[data-wx-recover]')?.addEventListener('click', restoreLocalDraft);
  $('[data-wx-discard]')?.addEventListener('click', discardLocalDraft);

  // 窄屏抽屉：点遮罩 / 正文区域把两侧栏收回去
  $('[data-wx-scrim]')?.addEventListener('click', closeMobileDrawers);
  $('.wx-main')?.addEventListener('pointerdown', closeMobileDrawers);

  $('[data-edit-login]')?.addEventListener('click', async () => {
    try {
      await openEditLogin();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '授权失败');
    }
  });
  $('[data-edit-logout]')?.addEventListener('click', () => {
    clearEditSession();
    showToast('已退出写作授权');
  });

  $('[data-wx-title]')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const body = $<HTMLTextAreaElement>('[data-wx-body]');
    body?.focus();
    if (body && state.current) {
      const pos = body.value.length;
      body.setSelectionRange(pos, pos);
    }
  });

  bindDialog();
  bindEditor();
  bindDropZone();
}

/* ============================================================
   初始化
   ============================================================ */

function initWriteApp(): void {
  const root = $<HTMLElement>('[data-write-root]');
  if (!root) return;
  if (state.root === root) return; // 同一份 DOM 不重复初始化

  state.root = root;
  unlockPageScroll();
  state.entries = readManifest();
  state.current = null;
  state.dirty = false;
  state.pendingDraft = null;
  state.lastSavedAt = '';
  state.lastLocalAt = 0;
  state.selected.clear();
  state.batch = false;
  state.collapsedSeries = readCollapsedSeries();
  state.loading = false;
  state.busy = false;
  state.syncing = false;
  state.leftOpen = readBoolPref('wx-left-open', true);
  state.rightOpen = readBoolPref('wx-right-open', true);
  if (window.innerWidth < 1024) {
    // 手机 / 窄屏：默认只看正文，左右两栏都收成抽屉
    state.leftOpen = false;
    state.rightOpen = false;
  }
  state.mode = (readPrefMode() as ViewMode) || 'edit';
  if (state.mode !== 'edit' && state.mode !== 'split' && state.mode !== 'preview') {
    state.mode = 'edit';
  }

  bindTooltips();
  bindDom();
  renderGate();
  renderList();
  setRightTab(state.rightTab);
  applyPanelState();
  applyViewMode(state.mode);
  updateSaveState();
  setFilter(state.filter);
}

function readPrefMode(): string {
  try {
    return localStorage.getItem('wx-mode') ?? '';
  } catch {
    return '';
  }
}

onPageLoad(() => {
  initWriteApp();
});

// 窗口尺寸变化：窄屏 / 桌面之间切换时，遮罩跟着抽屉状态走
window.addEventListener('resize', () => {
  if (!state.root) return;
  // 从桌面缩到窄屏时两侧栏不会同时盖在正文上
  if (window.innerWidth < 1024 && state.leftOpen && state.rightOpen) {
    state.rightOpen = false;
  }
  applyPanelState();
});

// 有未提交更改时，关标签页 / 刷新给个提示
window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

// ClientRouter 站内换页不触发 beforeunload，这里补一次确认
document.addEventListener('astro:before-swap', (event) => {
  if (!state.dirty) return;
  if (!window.confirm('当前文章还有未提交的更改，离开会丢失本地草稿。继续吗？')) {
    event.preventDefault();
  }
});

// 授权状态变化（登录 / 退出）—— 模块级只注册一次
onEditAuthChange(() => {
  renderGate();
  if (isAuthed()) {
    void maybeOpenInitial();
    void syncEntries({ silent: true });
  } else {
    state.current = null;
    state.dirty = false;
    state.pendingDraft = null;
    renderEditor();
    renderList();
  }
});
