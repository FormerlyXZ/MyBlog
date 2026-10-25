/**
 * /write 页面逻辑
 * ============================================================
 * · 没授权 → 只显示授权空壳
 * · 授权后 → 显示表单；?slug=xxx 会读回文章回填
 * · 上传 .md → 选 1 个：解析后填进表单；选多个：按文件名批量提交
 * · 保存 → 拼 YAML frontmatter + 正文，一次 commit 写进 src/content/posts/
 * · 封面图 → 上传到 public/images/ 后把路径填进表单
 *
 * 令牌只在 localStorage['melodyxz-edit']，退出即清除。
 */

import { onPageLoad } from './pageload';
import {
  clearEditSession,
  getEditSession,
  onEditAuthChange,
  openEditLogin,
  showToast,
} from '../utils/site';
import { commitFiles, getFile, putBinary, putFile } from '../utils/github';
import { formatDate } from '../utils/date';
import { SITE } from '../site.config';
import { countWords, escapeHtml, previewWarnings, readingMinutes, renderMarkdown } from './markdown';
import { initCodeFolds, refreshCodeFolds } from './code-fold';
import { initTables } from './table-scroll';
import { highlightPreviewCode } from './highlight';

const POSTS_DIR = 'src/content/posts';

interface PostDraft {
  /** single = 普通单篇文章；series = 系列（多文件长文）里的一章 */
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
  body: string;
  /** 系列标识（= src/content/posts 下的子目录名） */
  series: string;
  /** 本章序号（1 起） */
  seriesOrder: string;
  /** 系列标题（只在首次创建系列目录页时用到） */
  seriesTitle: string;
}

const field = <T extends HTMLElement>(name: string): T | null =>
  document.querySelector<T>(`[data-field="${name}"]`);

const input = (name: string): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(`[data-field="${name}"]`);

const textarea = (name: string): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(`[data-field="${name}"]`);

/** 今天，YYYY-MM-DD */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 标题 → 文件名：保留中英文数字，其余折成连字符 */
export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/['"’]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function setStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-write-status]');
  if (el) el.textContent = text;
}

function readForm(): PostDraft {
  const modeEl = document.querySelector<HTMLInputElement>('input[data-field="mode"]:checked');
  return {
    mode: modeEl?.value === 'series' ? 'series' : 'single',
    title: input('title')?.value.trim() ?? '',
    slug: input('slug')?.value.trim() ?? '',
    date: input('date')?.value || today(),
    updated: input('updated')?.value.trim() ?? '',
    description: textarea('description')?.value.trim() ?? '',
    categories: input('categories')?.value.trim() ?? '',
    tags: input('tags')?.value.trim() ?? '',
    image: input('image')?.value.trim() ?? '',
    attachments: input('attachments')?.value.trim() ?? '',
    badge: input('badge')?.checked ?? false,
    draft: input('draft')?.checked ?? false,
    body: textarea('body')?.value ?? '',
    series: input('series')?.value.trim() ?? '',
    seriesOrder: input('seriesOrder')?.value.trim() ?? '',
    seriesTitle: input('seriesTitle')?.value.trim() ?? '',
  };
}

const splitList = (value: string): string[] =>
  value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

const yamlString = (value: string): string => JSON.stringify(value);
const yamlList = (list: string[]): string => `[${list.map((item) => JSON.stringify(item)).join(', ')}]`;

/** 拼出完整的 .md 内容 */
function buildMarkdown(draft: PostDraft): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlString(draft.title)}`);
  if (draft.description) lines.push(`description: ${yamlString(draft.description)}`);
  lines.push(`date: ${draft.date}`);
  if (draft.updated) lines.push(`updated: ${draft.updated}`);
  if (draft.image) lines.push(`image: ${yamlString(draft.image)}`);

  const categories = splitList(draft.categories);
  if (categories.length) lines.push(`categories: ${yamlList(categories)}`);

  const tags = splitList(draft.tags);
  if (tags.length) lines.push(`tags: ${yamlList(tags)}`);

  if (draft.badge) lines.push('badge: Pin');
  if (draft.draft) lines.push('draft: true');

  const attachments = draft.attachments
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (attachments.length) lines.push(`attachments: ${yamlList(attachments)}`);

  // 系列（多文件长文）：目录页 seriesOrder 写 0，章节从 1 开始
  if (isSeriesDraft(draft)) {
    lines.push(`series: ${yamlString(draft.series)}`);
    if (draft.seriesTitle) lines.push(`seriesTitle: ${yamlString(draft.seriesTitle)}`);
    lines.push(`seriesOrder: ${seriesOrderNumber(draft)}`);
  }

  lines.push('---', '', draft.body.trim(), '');
  return lines.join('\n');
}

/* ============================================================
   系列（多文件长文）
   ------------------------------------------------------------
   约定（和 src/utils/series.ts 一致）：
     src/content/posts/<系列>/index.md         系列目录页（seriesOrder: 0）
     src/content/posts/<系列>/03-xxx.md        第 3 章（seriesOrder: 3）
   ============================================================ */

/** 是否按系列章节保存（选了系列且填了系列标识） */
function isSeriesDraft(draft: PostDraft): boolean {
  return draft.mode === 'series' && Boolean(draft.series.trim());
}

/** 章节序号：没填就当 1 */
function seriesOrderNumber(draft: PostDraft): number {
  const value = Number.parseInt(draft.seriesOrder, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** 序号补零成两位，文件名排序和侧栏顺序一致 */
function padOrder(order: number): string {
  return String(order).padStart(2, '0');
}

/**
 * 表单 → 仓库里的文件路径。
 * · 文件名里已经带 /（从「编辑本篇」带过来的完整 id）→ 直接用，避免重复拼目录
 * · 系列章节 → posts/<系列>/<NN>-<文件名>.md
 * · 普通文章 → posts/<文件名>.md
 */
function postPath(draft: PostDraft): string {
  const slug = draft.slug.trim().replace(/^\/+|\/+$/g, '');
  if (slug.includes('/')) return `${POSTS_DIR}/${slug}.md`;
  if (isSeriesDraft(draft)) {
    return `${POSTS_DIR}/${draft.series.trim()}/${padOrder(seriesOrderNumber(draft))}-${slug}.md`;
  }
  return `${POSTS_DIR}/${slug}.md`;
}

/** 系列目录页路径 */
function seriesIndexPath(series: string): string {
  return `${POSTS_DIR}/${series}/index.md`;
}

/** 首次建系列时自动生成的目录页（说明页；章节列表由页面组件自动渲染） */
function buildSeriesIndex(series: string, draft: PostDraft): string {
  const title = draft.seriesTitle || draft.title || series;
  const body = [
    `这里收录「${title}」的完整内容，按章组织。`,
    '',
    '## 怎么读',
    '',
    '- 左侧可以切换章节，右侧是本章目录；',
    '- 按顺序读，或者当工具书按需跳转。',
    '',
  ].join('\n');

  const indexDraft: PostDraft = {
    ...draft,
    title,
    slug: `${series}/index`,
    description: draft.description || `${title}：多篇正文组成的长文系列。`,
    mode: 'series',
    seriesTitle: title,
    seriesOrder: '0',
    body,
  };

  return buildMarkdown(indexDraft);
}

/**
 * 从 .md 文本里拆出 frontmatter 与正文。
 * 兼容几种常见写法（自己导出的、Typora / Obsidian / Hugo 导出的都能读）：
 *   key: "值"                普通标量
 *   key: [a, b]              流式数组
 *   key:
 *     - a
 *     - b                    块状数组
 *   key: |                   多行文本（folded 标量）
 *     line 1
 *     line 2
 * 块状数组在这里统一折成 JSON 数组字符串，后面交给 parseList 处理。
 */
function parseMarkdown(text: string): { data: Record<string, string>; body: string } {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const folded: Record<string, string[]> = {};
  let mode: { kind: 'list'; key: string } | { kind: 'fold'; key: string } | null = null;

  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;

    // 数组项：- 值
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && mode?.kind === 'list') {
      (lists[mode.key] ??= []).push(unquote((listItem[1] ?? '').trim()));
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      // 多行文本的后续行
      if (mode?.kind === 'fold' && line.trim()) {
        (folded[mode.key] ??= []).push(line.trim());
      }
      continue;
    }

    const [, key, rawValue] = pair;
    if (!key) continue;
    const value = (rawValue ?? '').trim();

    if (!value) {
      // 值在下面的块里
      mode = { kind: 'list', key };
      lists[key] ??= [];
      continue;
    }

    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      mode = { kind: 'fold', key };
      folded[key] ??= [];
      continue;
    }

    mode = null;
    data[key] = value;
  }

  for (const [key, items] of Object.entries(lists)) {
    if (items.length) data[key] = JSON.stringify(items);
    else if (!(key in data)) data[key] = '';
  }

  for (const [key, lines] of Object.entries(folded)) {
    if (lines.length) data[key] = lines.join('\n');
  }

  return { data, body: match[2] ?? '' };
}

/** YAML 标量 → 字符串（我们写的是 JSON 双引号风格） */
function unquote(value: string): string {
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** YAML 流式数组 → 字符串数组 */
function parseList(value: string): string[] {
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      /* 落到下面的逗号分隔 */
    }
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function fillForm(data: Record<string, string>, body: string): void {
  if (input('title')) input('title')!.value = unquote(data.title ?? '');
  if (input('date')) input('date')!.value = (data.date ?? today()).slice(0, 10);
  // 注意：这里刻意不回填 updated。编辑旧文章时留空即可，
  // 保存时会自动记成今天（想手动指定就自己选日期）。
  if (textarea('description')) textarea('description')!.value = unquote(data.description ?? '');
  if (input('image')) input('image')!.value = unquote(data.image ?? '');
  if (input('categories')) input('categories')!.value = parseList(data.categories ?? '').join(', ');
  if (input('tags')) input('tags')!.value = parseList(data.tags ?? '').join(', ');
  if (input('attachments')) input('attachments')!.value = parseList(data.attachments ?? '').join('\n');
  if (input('badge')) input('badge')!.checked = (data.badge ?? '') === 'Pin';
  if (input('draft')) input('draft')!.checked = (data.draft ?? '') === 'true';
  if (textarea('body')) textarea('body')!.value = body.replace(/^\s+/, '');

  // 系列字段
  const series = unquote(data.series ?? '').trim();
  if (input('series')) input('series')!.value = series;
  if (input('seriesTitle')) input('seriesTitle')!.value = unquote(data.seriesTitle ?? '');
  const order = unquote(data.seriesOrder ?? '').trim();
  if (input('seriesOrder')) input('seriesOrder')!.value = order === '0' ? '' : order;
  if (series) setMode('series');
}

/** 切换「单篇 / 系列」，并显示或隐藏系列字段 */
function setMode(mode: 'single' | 'series'): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[data-field="mode"]')) {
    radio.checked = radio.value === mode;
  }
  const fields = document.querySelector<HTMLElement>('[data-series-fields]');
  if (fields) {
    fields.hidden = mode !== 'series';
    fields.classList.toggle('hidden', mode !== 'series');
    fields.classList.toggle('grid', mode === 'series');
  }
}

function clearForm(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-field]')) {
    if (el.type === 'checkbox') el.checked = false;
    else if (el.type !== 'file' && el.type !== 'radio') el.value = '';
  }
  setMode('single');
  const dateEl = input('date');
  if (dateEl) dateEl.value = today();
  const root = document.querySelector<HTMLElement>('[data-write-root]');
  if (root) root.dataset.editing = '';
  setStatus('');
  mdStatus('');
}

/* ============================================================
   上传 .md 文件
   ------------------------------------------------------------
   两种用法：
     · 选 1 个 → 解析 frontmatter + 正文，填进下面的表单（人工检查后发布）
     · 选多个 → 按文件名生成 slug，一次性 commit 进 src/content/posts/
   ============================================================ */

interface ImportedDraft {
  draft: PostDraft;
  slug: string;
}

function mdStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-md-status]');
  if (el) el.textContent = text;
}

/** 文件名 → 文章 slug：去掉扩展名，其余脏字符折成连字符 */
function slugFromFilename(name: string): string {
  return name
    .replace(/\.(md|markdown|mdx|txt)$/i, '')
    .trim()
    .replace(/['"’]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** 一份 .md 文本 → 表单草稿（frontmatter 缺什么就用文件名 / 今天兜底） */
function draftFromFile(name: string, text: string): ImportedDraft {
  const { data, body } = parseMarkdown(text);
  const fallbackTitle = slugFromFilename(name);
  const title = unquote(data.title ?? '').trim() || fallbackTitle;
  const series = unquote(data.series ?? '').trim();

  const postDraft: PostDraft = {
    mode: series ? 'series' : 'single',
    title,
    slug: '',
    date: (unquote(data.date ?? '').trim() || today()).slice(0, 10),
    updated: (unquote(data.updated ?? '').trim()).slice(0, 10),
    description: unquote(data.description ?? ''),
    categories: parseList(data.categories ?? '').join(', '),
    tags: parseList(data.tags ?? '').join(', '),
    image: unquote(data.image ?? ''),
    attachments: parseList(data.attachments ?? '').join('\n'),
    badge: unquote(data.badge ?? '') === 'Pin',
    draft: unquote(data.draft ?? '') === 'true',
    body: body.replace(/^\s+/, ''),
    series,
    seriesOrder: unquote(data.seriesOrder ?? '').trim().replace(/^0$/, ''),
    seriesTitle: unquote(data.seriesTitle ?? ''),
  };

  const slug = fallbackTitle || slugify(title) || `post-${Date.now()}`;
  postDraft.slug = slug;
  return { draft: postDraft, slug };
}

/** 把导入的草稿写回表单 */
function applyDraft({ draft, slug }: ImportedDraft): void {
  if (input('title')) input('title')!.value = draft.title;
  if (input('date')) input('date')!.value = draft.date || today();
  if (input('updated')) input('updated')!.value = draft.updated || '';
  if (textarea('description')) textarea('description')!.value = draft.description;
  if (input('categories')) input('categories')!.value = draft.categories;
  if (input('tags')) input('tags')!.value = draft.tags;
  if (input('image')) input('image')!.value = draft.image;
  if (input('attachments')) input('attachments')!.value = draft.attachments;
  if (input('badge')) input('badge')!.checked = draft.badge;
  if (input('draft')) input('draft')!.checked = draft.draft;
  if (textarea('body')) textarea('body')!.value = draft.body;
  if (input('series')) input('series')!.value = draft.series;
  if (input('seriesOrder')) input('seriesOrder')!.value = draft.seriesOrder;
  if (input('seriesTitle')) input('seriesTitle')!.value = draft.seriesTitle;
  setMode(draft.mode);

  const slugEl = input('slug');
  if (slugEl) {
    slugEl.value = slug;
    slugEl.dataset.touched = '1';
  }

  const root = document.querySelector<HTMLElement>('[data-write-root]');
  if (root) root.dataset.editing = slug;
}

/** 批量导入：重名 slug 自动加 -2 / -3，避免互相覆盖 */
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

/** 处理用户选择 / 拖进来的文件 */
async function handleMdFiles(files: File[]): Promise<void> {
  const markdownFiles = files.filter((file) => /\.(md|markdown|mdx|txt)$/i.test(file.name));
  if (!markdownFiles.length) {
    mdStatus('只支持 .md / .markdown / .txt 文件');
    showToast('只支持 .md 文件');
    return;
  }
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }

  // 单个：填进表单，让人先看一眼
  if (markdownFiles.length === 1) {
    const file = markdownFiles[0] as File;
    setStatus('读取文件中…');
    try {
      const text = await file.text();
      const imported = draftFromFile(file.name, text);
      // 表单里已经选了「系列」但文件本身没有 series 字段时，
      // 保留用户选的系列和序号，不要被打回「单篇」
      const current = readForm();
      if (current.mode === 'series' && !imported.draft.series) {
        imported.draft.mode = 'series';
        imported.draft.series = current.series;
        imported.draft.seriesTitle = current.seriesTitle;
        if (!imported.draft.seriesOrder) imported.draft.seriesOrder = current.seriesOrder;
      }
      applyDraft(imported);
      setStatus('已导入，检查后点「保存并发布」');
      mdStatus(`已导入「${file.name}」，下面表单已填好，确认标题 / 日期 / 分类后发布即可。`);
      showToast('已导入 .md，检查后发布');
    } catch (error) {
      setStatus('');
      mdStatus('');
      showToast(error instanceof Error ? error.message : '读取失败');
    }
    return;
  }

  // 多个：确认后一次 commit 全部提交
  const seriesMode = readForm();
  const wantsSeries = seriesMode.mode === 'series';
  const useSeries = wantsSeries && Boolean(seriesMode.series.trim());

  // 选了「系列」却没填系列标识：这里必须拦下来。
  // 否则会静默退化成「一堆单篇」，和用户的预期完全不一样。
  if (wantsSeries && !useSeries) {
    mdStatus('选了「系列」但没填系列标识（英文目录名），无法给章节编号');
    showToast('请先填写系列标识');
    input('series')?.focus();
    return;
  }

  const names = markdownFiles.map((file) => file.name).join('、');
  const scene = useSeries
    ? `把这些文件作为「${seriesMode.series}」系列的章节提交（按文件名顺序自动编号）`
    : '把每个文件当成一篇独立文章提交';
  if (!window.confirm(`将${scene}：\n${names}\n\n继续吗？`)) {
    return;
  }

  setStatus(`批量导入中… 0 / ${markdownFiles.length}`);
  mdStatus('');

  try {
    const used = new Set<string>();
    const changes: { path: string; text: string }[] = [];
    // 系列模式：按文件名自然排序，序号从 1 开始连续编号
    const files = useSeries
      ? [...markdownFiles].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
      : markdownFiles;

    let order = 1;
    for (const file of files) {
      const text = await file.text();
      const imported = draftFromFile(file.name, text);
      const slug = uniqueSlug(imported.slug, used);
      imported.draft.slug = slug;

      if (useSeries) {
        imported.draft.mode = 'series';
        imported.draft.series = seriesMode.series.trim();
        imported.draft.seriesOrder = String(order);
        if (!imported.draft.seriesTitle) imported.draft.seriesTitle = seriesMode.seriesTitle;
        changes.push({
          path: `${POSTS_DIR}/${imported.draft.series}/${padOrder(order)}-${slug}.md`,
          text: buildMarkdown(imported.draft),
        });
        order += 1;
      } else {
        changes.push({ path: `${POSTS_DIR}/${slug}.md`, text: buildMarkdown(imported.draft) });
      }
    }

    // 系列模式：目录页不存在就顺手建一个，否则这批章节在侧栏里没有入口
    if (useSeries) {
      const indexPath = seriesIndexPath(seriesMode.series.trim());
      const existingIndex = await getFile(indexPath);
      if (!existingIndex) {
        changes.push({
          path: indexPath,
          text: buildSeriesIndex(seriesMode.series.trim(), seriesMode),
        });
      }
    }

    const message = useSeries
      ? `post: 批量导入「${seriesMode.series}」系列 ${files.length} 章${changes.length > files.length ? '（含目录页）' : ''}`
      : `post: 批量导入 ${changes.length} 篇文章`;
    await commitFiles(changes, message);

    setStatus('已提交，等自动部署完成后生效');
    mdStatus(
      useSeries
        ? `已把 ${files.length} 个文件导入「${seriesMode.series}」系列：${names}`
        : `已批量导入 ${changes.length} 篇：${names}`,
    );
    showToast(`已导入 ${files.length} 篇，约 1 分钟后生效`);
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '批量导入失败');
  }
}

function bindMdImport(): void {
  const pick = document.querySelector<HTMLElement>('[data-md-pick]');
  const fileInput = document.querySelector<HTMLInputElement>('[data-md-input]');
  const drop = document.querySelector<HTMLElement>('[data-md-drop]');

  if (pick && fileInput && pick.dataset.bound !== '1') {
    pick.dataset.bound = '1';
    pick.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = '';
      void handleMdFiles(files);
    });
  }

  if (drop && drop.dataset.bound !== '1') {
    drop.dataset.bound = '1';

    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('is-drop');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-drop'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-drop');
      void handleMdFiles(Array.from(event.dataTransfer?.files ?? []));
    });
  }
}

/**
 * 「单篇 / 系列」切换：显示或隐藏系列字段。
 * 用容器上的 data-bound 做幂等，走 ClientRouter 回来也不会挂两遍。
 */
function bindSeriesMode(): void {
  const fields = document.querySelector<HTMLElement>('[data-series-fields]');
  if (!fields) return;

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[data-field="mode"]')) {
    if (radio.dataset.bound === '1') continue;
    radio.dataset.bound = '1';
    radio.addEventListener('change', () => {
      setMode(radio.value === 'series' ? 'series' : 'single');
      if (radio.value === 'series') input('series')?.focus();
    });
  }

  setMode(readForm().mode);
}

/** 未授权 / 已授权 两种界面的切换 */
function renderGate(): void {
  const gate = document.querySelector<HTMLElement>('[data-write-gate]');
  const form = document.querySelector<HTMLElement>('[data-write-form]');
  const logoutBtn = document.querySelector<HTMLElement>('[data-edit-logout]');
  const authed = Boolean(getEditSession());

  if (gate) gate.hidden = authed;
  if (form) {
    form.hidden = !authed;
    form.classList.toggle('hidden', !authed);
    form.classList.toggle('flex', authed);
  }
  if (logoutBtn) logoutBtn.hidden = !authed;
}

/* ============================================================
   预览弹窗
   ------------------------------------------------------------
   点「预览」时把当前表单内容按「保存后」的样子渲染出来：
   封面 / 标题 / meta / 正文（正文直接套文章页的 .prose-blog，
   所以排版和最终文章页一致）。只读表单、不提交任何东西，
   关掉弹窗继续编辑。
   ============================================================ */

/** 预览里的 meta 行：日期 / 更新时间 / 字数与时长 / 分类 / 标签 */
function buildPreviewMeta(draft: PostDraft): string {
  const parts: string[] = [];
  if (draft.date) parts.push(formatDate(draft.date, SITE.dateFormat));
  if (draft.updated) parts.push(`更新于 ${formatDate(draft.updated, SITE.dateFormat)}`);
  parts.push(`${countWords(draft.body)} 字 · 约 ${readingMinutes(draft.body)} 分钟`);

  const pills = [
    ...splitList(draft.categories).map((item) => `<span class="pill-category">${escapeHtml(item)}</span>`),
    ...splitList(draft.tags).map((item) => `<span class="pill-tag">#${escapeHtml(item)}</span>`),
  ].join('');

  return (
    `<span>${parts.map((part) => escapeHtml(part)).join(' · ')}</span>` +
    (pills ? `<span class="inline-flex flex-wrap items-center gap-1.5">${pills}</span>` : '')
  );
}

/** 读表单 → 渲染预览（弹窗已打开时等于「重新渲染」） */
function openPreview(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-preview-dialog]');
  if (!dialog) return;

  const draft = readForm();

  const titleEl = dialog.querySelector<HTMLElement>('[data-preview-title]');
  if (titleEl) titleEl.textContent = draft.title || '（未填写标题）';

  const firstChar = dialog.querySelector<HTMLElement>('[data-preview-first-char]');
  if (firstChar) firstChar.textContent = draft.title.trim().charAt(0) || '文';

  const coverImg = dialog.querySelector<HTMLImageElement>('[data-preview-cover-img]');
  if (coverImg) {
    const hasCover = Boolean(draft.image.trim());
    coverImg.hidden = !hasCover;
    if (hasCover) coverImg.src = draft.image.trim();
  }

  const meta = dialog.querySelector<HTMLElement>('[data-preview-meta]');
  if (meta) meta.innerHTML = buildPreviewMeta(draft);

  const bodyEl = dialog.querySelector<HTMLElement>('[data-preview-body]');
  if (bodyEl) bodyEl.innerHTML = renderMarkdown(draft.body);

  const empty = dialog.querySelector<HTMLElement>('[data-preview-empty]');
  if (empty) empty.hidden = Boolean(draft.body.trim());

  const hint = dialog.querySelector<HTMLElement>('[data-preview-hint]');
  if (hint) {
    const warnings = previewWarnings(draft.body);
    hint.textContent = warnings.length ? `⚠ ${warnings.join('；')}` : '保存前确认排版与 Markdown 语法';
    hint.classList.toggle('text-error', warnings.length > 0);
  }

  if (!dialog.open) dialog.showModal();

  // 折叠要量高度，得等弹窗真的显示出来（显示之前 scrollHeight 是 0）
  if (bodyEl) initCodeFolds(bodyEl);
  // 表格外框同样要等显示之后量（量的是 clientWidth / scrollWidth）
  if (bodyEl) initTables(bodyEl);

  // 语法高亮是懒加载的（shiki 只在预览时拉），先显示「纯文本 + 绿注释」，
  // 拉回来再替换 token；内容换过之后行高会变，让折叠重新量一次
  if (bodyEl) {
    highlightPreviewCode(bodyEl)
      .then((changed) => {
        if (changed) refreshCodeFolds();
      })
      .catch(() => {
        /* 高亮是锦上添花，失败就保持纯文本 */
      });
  }
}

/** 绑预览按钮与弹窗交互（Esc / 点遮罩关闭是 <dialog> 自带的行为） */
function bindPreview(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-preview-dialog]');
  if (!dialog || dialog.dataset.bound === '1') return;
  dialog.dataset.bound = '1';

  document.querySelector('[data-write-preview]')?.addEventListener('click', openPreview);
  dialog.querySelector('[data-preview-refresh]')?.addEventListener('click', openPreview);
  dialog.querySelector('[data-preview-close]')?.addEventListener('click', () => dialog.close());

  // 点遮罩空白处关闭
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function initWrite(): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-write-root]');
  if (!root) return;

  renderGate();

  // 日期默认今天（用户改过就不动）
  const dateEl = input('date');
  if (dateEl && !dateEl.value) dateEl.value = today();

  // 上传 .md（选择 / 拖拽）—— 每次进页面都重新绑一遍新 DOM
  bindMdImport();

  // 「单篇 / 系列」切换
  bindSeriesMode();

  // 预览弹窗 —— 同上，每次进页面都重新绑
  bindPreview();

  // 换页（ClientRouter）回来时 DOM 是一套新的，root 上的标记也没了，
  // 所以用 root.dataset.bound 判断，而不是一个模块级变量（否则回来就失效）
  if (root.dataset.bound !== '1') {
    root.dataset.bound = '1';

    // 授权
    document.querySelector('[data-edit-login]')?.addEventListener('click', async () => {
      try {
        await openEditLogin();
        showToast('写作授权成功');
        renderGate();
        await maybeLoadExisting(root);
      } catch (error) {
        showToast(error instanceof Error ? error.message : '授权失败');
      }
    });

    // 退出
    document.querySelector('[data-edit-logout]')?.addEventListener('click', () => {
      clearEditSession();
      renderGate();
      showToast('已退出写作授权');
    });

    // 标题 → 自动生成文件名（用户手动改过就不再覆盖）
    input('title')?.addEventListener('input', () => {
      const slugEl = input('slug');
      if (!slugEl || slugEl.dataset.touched === '1') return;
      const dateEl = input('date');
      const date = dateEl?.value || today();
      const slug = slugify(input('title')?.value ?? '');
      slugEl.value = slug ? `${date}-${slug}` : '';
    });

    input('slug')?.addEventListener('input', () => {
      const slugEl = input('slug');
      if (slugEl) slugEl.dataset.touched = '1';
    });

    // 封面图上传
    document.querySelector<HTMLInputElement>('[data-cover-input]')?.addEventListener('change', async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (!getEditSession()) {
        showToast('请先授权');
        return;
      }
      setStatus('封面上传中…');
      try {
        const buffer = await file.arrayBuffer();
        const safeName = file.name.replace(/[^\w.-]+/g, '-');
        const path = `public/images/${Date.now()}-${safeName}`;
        await putBinary(path, buffer, `upload: ${file.name}`);
        const imageEl = input('image');
        if (imageEl) imageEl.value = `/${path.replace(/^public\//, '')}`;
        setStatus('封面已上传，点「保存并发布」后生效');
        showToast('封面已上传，记得点「保存并发布」');
      } catch (error) {
        setStatus('');
        showToast(error instanceof Error ? error.message : '上传失败');
      }
    });

    // 保存
    document.querySelector('[data-write-save]')?.addEventListener('click', async () => {
      if (!getEditSession()) {
        showToast('请先授权');
        return;
      }

      const draft = readForm();
      if (!draft.title) {
        showToast('标题不能为空');
        input('title')?.focus();
        return;
      }
      if (!draft.slug) {
        showToast('文件名不能为空');
        input('slug')?.focus();
        return;
      }
      if (!draft.body.trim()) {
        showToast('正文不能为空');
        textarea('body')?.focus();
        return;
      }
      if (draft.mode === 'series' && !draft.series.trim()) {
        showToast('选了「系列」但没填系列标识');
        input('series')?.focus();
        return;
      }

      setStatus('提交中…');
      try {
        const path = postPath(draft);
        const existing = await getFile(path);
        // 编辑旧文章时：没手填「更新时间」就自动记成今天，
        // 这样文章页能显示「更新于 …」，也方便判断内容是不是新改过的。
        if (existing && !draft.updated) draft.updated = today();
        const content = buildMarkdown(draft);

        // 系列：这个系列还没有目录页时，和本章一起提交，避免章节「没有入口」
        if (!existing && isSeriesDraft(draft)) {
          const series = draft.series.trim();
          const indexPath = seriesIndexPath(series);
          const indexExisting = await getFile(indexPath);
          if (!indexExisting) {
            await commitFiles(
              [
                { path: indexPath, text: buildSeriesIndex(series, draft) },
                { path, text: content },
              ],
              `post: 新建系列「${series}」并加入第 ${seriesOrderNumber(draft)} 章`,
            );
            setStatus('已提交，等自动部署完成后生效');
            showToast('已新建系列并发布本章，约 1 分钟后生效');
            root.dataset.editing = draft.slug;
            return;
          }
        }

        await putFile(
          path,
          content,
          existing ? `post: update ${draft.title}` : `post: add ${draft.title}`,
          existing?.sha,
        );
        setStatus('已提交，等自动部署完成后生效');
        showToast(existing ? '已更新，约 1 分钟后生效' : '已发布，约 1 分钟后生效');
        root.dataset.editing = draft.slug;
      } catch (error) {
        setStatus('');
        showToast(error instanceof Error ? error.message : '保存失败');
      }
    });

    // 新建
    document.querySelector('[data-write-clear]')?.addEventListener('click', () => {
      clearForm();
      const dateEl = input('date');
      if (dateEl) dateEl.value = today();
      const slugEl = input('slug');
      if (slugEl) slugEl.dataset.touched = '';
      input('title')?.focus();
    });

    onEditAuthChange(() => {
      renderGate();
      void maybeLoadExisting(root);
    });
  }

  if (getEditSession()) await maybeLoadExisting(root);
}

/**
 * 当前要编辑的文章 slug。
 *
 * 注意：/write/?slug=xxx 是纯静态页面，Astro.url.searchParams 在**构建时**
 * 永远是空的（构建时没有查询串），所以 HTML 里的 data-slug 属性没有值。
 * 必须在浏览器里读 location.search，否则「编辑本篇」打开后什么都不会回填。
 */
function currentSlug(root: HTMLElement): string {
  const fromUrl = new URLSearchParams(window.location.search).get('slug');
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  // 兜底：万一以后改成 SSR / 带静态参数预渲染，data-slug 也能用
  return (root.dataset.slug ?? '').trim();
}

/** 带 ?slug= 时读回文章并回填 */
async function maybeLoadExisting(root: HTMLElement): Promise<void> {
  const slug = currentSlug(root);
  if (!slug || root.dataset.loaded === '1') return;
  if (!getEditSession()) return;

  root.dataset.loaded = '1';
  setStatus('读取文章中…');
  try {
    const file = await getFile(`${POSTS_DIR}/${slug}.md`);
    if (!file) {
      root.dataset.loaded = '';
      setStatus('没有找到这篇文章，可以当作新文章继续写');
      return;
    }
    const { data, body } = parseMarkdown(file.text);
    fillForm(data, body);

    // 系列章节：文件 id 形如 stm32/04-i2c。表单里只填「章节文件名」，
    // 目录和序号交给系列字段，保存时再拼回 <系列>/<NN>-<文件名>.md
    const series = unquote(data.series ?? '').trim();
    const fileName = series && slug.includes('/') ? slug.split('/').pop()! : slug;
    const chapterSlug = series ? fileName.replace(/^\d+-/, '') : fileName;

    const slugEl = input('slug');
    if (slugEl) {
      slugEl.value = chapterSlug;
      slugEl.dataset.touched = '1';
    }
    root.dataset.editing = slug;
    const note = data.updated ? `（上次更新 ${data.updated.slice(0, 10)}）` : '';
    setStatus(`已读取现有文章${note}`);
  } catch (error) {
    root.dataset.loaded = '';
    setStatus('');
    showToast(error instanceof Error ? error.message : '读取失败');
  }
}

onPageLoad(() => {
  void initWrite();
});
