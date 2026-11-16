/**
 * 写作台：Markdown 文章的前台数据模型
 * ============================================================
 * 只做纯文本处理，不碰 DOM / 网络：
 *   · 解析 / 生成 frontmatter（和 src/content.config.ts 的 schema 对齐）
 *   · 文章落盘路径（单篇 / 系列章节 / 系列目录页）
 *   · 批量改 draft / badge 时的「只动一行、不重建整个 frontmatter」
 *   · 从正文里抽标题（右侧大纲用）
 *
 * 约定（和 src/utils/series.ts 一致）：
 *   src/content/posts/<文件名>.md                单篇
 *   src/content/posts/<系列>/index.md            系列目录页
 *   src/content/posts/<系列>/03-xxx.md           第 3 章
 * ============================================================
 */

export const POSTS_DIR = 'src/content/posts';

export interface PostDraft {
  /** single = 普通单篇；series = 系列里的一章 / 目录页 */
  mode: 'single' | 'series';
  title: string;
  /** 文件名（不含目录和 .md）；系列章节不包含前面的序号 */
  slug: string;
  date: string;
  updated: string;
  description: string;
  /** 逗号分隔（表单里就是一行文字） */
  categories: string;
  /** 逗号分隔 */
  tags: string;
  image: string;
  /** 每行一个 */
  attachments: string;
  badge: boolean;
  draft: boolean;
  body: string;
  /** 系列标识 = src/content/posts 下的子目录名 */
  series: string;
  /** 章节序号：'' / '0' = 目录页，1 起 = 章节 */
  seriesOrder: string;
  /** 系列标题（第一次建系列时写进目录页） */
  seriesTitle: string;
}

export interface HeadingItem {
  level: number;
  text: string;
  /** 在正文里的行号（0 起） */
  line: number;
}

/** 今天，YYYY-MM-DD */
export function today(): string {
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

/** 逗号分隔（中英文逗号都行）→ 数组 */
export function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 序号补零成两位，文件名排序和侧栏顺序一致 */
export function padOrder(order: number): string {
  return String(order).padStart(2, '0');
}

/* ---------------- YAML 读写（只覆盖本站用到的写法） ---------------- */

const yamlString = (value: string): string => JSON.stringify(value);
const yamlList = (list: string[]): string =>
  `[${list.map((item) => JSON.stringify(item)).join(', ')}]`;

/** 拼出完整的 .md 内容 */
export function buildMarkdown(draft: PostDraft): string {
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

  // 系列：目录页 seriesOrder 写 0，章节从 1 开始
  if (isSeriesDraft(draft)) {
    lines.push(`series: ${yamlString(draft.series.trim())}`);
    if (draft.seriesTitle) lines.push(`seriesTitle: ${yamlString(draft.seriesTitle)}`);
    lines.push(`seriesOrder: ${seriesOrderNumber(draft)}`);
  }

  lines.push('---', '', draft.body.trim(), '');
  return lines.join('\n');
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
 * 块状数组统一折成 JSON 数组字符串，后面交给 parseList 处理。
 */
export function parseMarkdown(text: string): { data: Record<string, string>; body: string } {
  const match = text
    .replace(/^\uFEFF/, '')
    .match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const folded: Record<string, string[]> = {};
  let mode: { kind: 'list'; key: string } | { kind: 'fold'; key: string } | null = null;

  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && mode?.kind === 'list') {
      (lists[mode.key] ??= []).push(unquote((listItem[1] ?? '').trim()));
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      if (mode?.kind === 'fold' && line.trim()) {
        (folded[mode.key] ??= []).push(line.trim());
      }
      continue;
    }

    const [, key, rawValue] = pair;
    if (!key) continue;
    const value = (rawValue ?? '').trim();

    if (!value) {
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
export function unquote(value: string): string {
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

/** YAML 流式数组 / 逗号分隔 → 字符串数组 */
export function parseList(value: string): string[] {
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
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 批量操作专用：只改 frontmatter 里的某几行，正文和其他字段原样保留。
 * 没有 frontmatter 时原样返回（宁可不动，也不要重建出一个丢字段的文件）。
 */
export function patchFrontmatter(
  text: string,
  patch: { draft?: boolean; badge?: boolean },
): string {
  const normalized = text.replace(/^\uFEFF/, '');
  const match = normalized.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n?)([\s\S]*)$/);
  if (!match) return text;

  const open = match[1] ?? '---\n';
  const raw = match[2] ?? '';
  const close = match[3] ?? '\n---';
  const gap = match[4] ?? '\n';
  const rest = match[5] ?? '';
  const eol = open.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const apply = (key: string, on: boolean, value: string): void => {
    const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
    if (on) {
      if (index === -1) lines.push(`${key}: ${value}`);
      else lines[index] = `${key}: ${value}`;
    } else if (index !== -1) {
      lines.splice(index, 1);
    }
  };

  if (patch.draft !== undefined) apply('draft', patch.draft, 'true');
  if (patch.badge !== undefined) apply('badge', patch.badge, 'Pin');

  return `${open}${lines.join(eol)}${close}${gap}${rest}`;
}

/* ---------------- 路径 ---------------- */

/** 是否按系列章节保存（选了系列且填了系列标识） */
export function isSeriesDraft(draft: PostDraft): boolean {
  return draft.mode === 'series' && Boolean(draft.series.trim());
}

/** 章节序号：没填就当 1 */
export function seriesOrderNumber(draft: PostDraft): number {
  const value = Number.parseInt(draft.seriesOrder, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** 系列目录页路径 */
export function seriesIndexPath(series: string): string {
  return `${POSTS_DIR}/${series.trim().replace(/^\/+|\/+$/g, '')}/index.md`;
}

/**
 * 表单 → 仓库里的文件路径。
 * · slug 里已经带 /（从「编辑本篇」带过来的完整 id）→ 直接用
 * · 系列目录页（序号 0 / slug=index）→ posts/<系列>/index.md
 * · 系列章节 → posts/<系列>/<NN>-<文件名>.md
 * · 普通文章 → posts/<文件名>.md
 */
export function postPath(draft: PostDraft): string {
  const slug = draft.slug.trim().replace(/^\/+|\/+$/g, '');
  if (!slug) return '';
  if (slug.includes('/')) return `${POSTS_DIR}/${slug}.md`;

  if (isSeriesDraft(draft)) {
    const series = draft.series.trim().replace(/^\/+|\/+$/g, '');
    if (!series) return '';
    if (draft.seriesOrder.trim() === '0' || slug === 'index') {
      return `${POSTS_DIR}/${series}/index.md`;
    }
    return `${POSTS_DIR}/${series}/${padOrder(seriesOrderNumber(draft))}-${slug}.md`;
  }

  return `${POSTS_DIR}/${slug}.md`;
}

/** 首次建系列时自动生成的目录页（章节列表由页面组件自动渲染） */
export function buildSeriesIndex(series: string, draft: PostDraft): string {
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
    slug: 'index',
    description: draft.description || `${title}：多篇正文组成的长文系列。`,
    mode: 'series',
    series,
    seriesTitle: title,
    seriesOrder: '0',
    body,
  };

  return buildMarkdown(indexDraft);
}

/** 文件路径 → 文章 id（post.id）：去掉 src/content/posts/ 前缀和 .md 后缀 */
export function idFromPath(path: string): string {
  return path
    .replace(new RegExp(`^${POSTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
    .replace(/\.md$/i, '');
}

/** 从正文抽标题（跳过代码块），给右侧「大纲」用 */
export function extractHeadings(body: string): HeadingItem[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: HeadingItem[] = [];
  let fence: string | null = null;

  lines.forEach((line, lineIndex) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? '')[0] ?? '`';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push({
        level: (heading[1] ?? '#').length,
        text: (heading[2] ?? '').trim(),
        line: lineIndex,
      });
    }
  });

  return out;
}
