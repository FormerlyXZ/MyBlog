/**
 * 轻量 Markdown → HTML 渲染器（只用于「写文章 / 编辑文章」页的预览弹窗）
 * ============================================================
 * 为什么不引 marked / markdown-it：
 *   写作页的脚本会随站点 JS 一起打包，为了站长看一次预览就给所有访客
 *   多塞 40KB+ 的库不划算。这里按站点构建时的输出结构（remark-gfm +
 *   rehype-raw 生成的 HTML 形态）手写一套「够用」的实现，覆盖：
 *
 *   块级：ATX / setext 标题、段落、围栏代码块、引用（可嵌套）、
 *         无序 / 有序 / 嵌套列表、任务列表、表格（含对齐）、分隔线、
 *         原始 HTML 块、脚注定义
 *   行内：加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 图片 / 自动链接 /
 *         裸链接 / 脚注引用 / 反斜杠转义 / 原始 HTML 标签
 *
 * 生成的 HTML 结构和文章页一致（prose-blog 同一套样式），所以弹窗里的
 * 样子 ≈ 保存后的文章页。
 *
 * 唯一的「配色」是代码块里的注释：正式文章页由 shiki 主题上色，
 * 这里用一个小扫描器把注释包成 <span class="md-cmt">（见 highlightComments），
 * 让预览里的注释和正式页一样是绿的。
 * ============================================================
 */

interface Footnote {
  id: string;
  text: string;
}

interface InlineContext {
  footnotes: Footnote[];
  used: string[];
}

/* ---------------- 转义与安全 ---------------- */

const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** 正文文本转义（属性值里引号单独处理） */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => ENTITY[char] ?? char);
}

export function escapeAttr(value: string): string {
  return value.replace(/[&"<>]/g, (char) => (char === '"' ? '&quot;' : ENTITY[char] ?? char));
}

/** 拦掉 javascript: / data: 这类危险链接 */
function safeUrl(url: string): string {
  const trimmed = url.trim();
  return /^(javascript|data|vbscript):/i.test(trimmed) ? '#' : trimmed;
}

/** 单个原始 HTML 标签：去掉事件属性和 javascript: 协议 */
function sanitizeTag(tag: string): string {
  return tag.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '#');
}

/** 原始 HTML 块：直接去掉 script / style，避免预览窗口被脚本干扰 */
function sanitizeBlock(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '#');
}

/* ---------------- 行内渲染 ---------------- */

/**
 * 行内语法。
 * 顺序很重要：先用占位符「扣下」不能当普通文本处理的片段
 * （转义字符、行内代码、链接、图片、自动链接、原始 HTML 标签），
 * 剩下的纯文本转义后再做强调标记，最后把占位符还原成 HTML。
 */
function renderInline(text: string, ctx: InlineContext): string {
  if (!text) return '';

  const slots: string[] = [];
  const put = (html: string): string => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let s = text;

  // 1) 反斜杠转义：\* 这类原样输出
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~>|])/g, (_m, char: string) => put(escapeHtml(char)));

  // 2) 行内代码（``code`` 也支持）
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks: string, code: string) => put(`<code>${escapeHtml(code.trim())}</code>`));

  // 3) 图片、链接
  s = s.replace(
    /!\[([^\]]*)\]\(\s*([^()\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g,
    (_m, alt: string, url: string, title?: string) =>
      put(`<img src="${escapeAttr(safeUrl(url))}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`),
  );
  s = s.replace(
    /\[([^\]]+)\]\(\s*([^()\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g,
    (_m, label: string, url: string, title?: string) =>
      put(`<a href="${escapeAttr(safeUrl(url))}"${title ? ` title="${escapeAttr(title)}"` : ''}>${renderInline(label, ctx)}</a>`),
  );

  // 4) 脚注引用 [^id]（没有定义就原样保留文字）
  s = s.replace(/\[\^([^\]\s]+)\]/g, (_m, id: string) => {
    const index = ctx.footnotes.findIndex((item) => item.id === id);
    if (index === -1) return put(`[^${escapeHtml(id)}]`);
    if (!ctx.used.includes(id)) ctx.used.push(id);
    return put(
      `<sup><a href="#fn-${escapeAttr(id)}" id="fnref-${escapeAttr(id)}" data-footnote-ref>${index + 1}</a></sup>`,
    );
  });

  // 5) 自动链接 <https://…>
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (_m, url: string) =>
    put(`<a href="${escapeAttr(safeUrl(url))}">${escapeHtml(url)}</a>`),
  );

  // 6) 裸链接（前面是行首 / 空白 / 左括号）
  s = s.replace(/(^|[\s(（])((?:https?:\/\/)[^\s<>()（）]+)/g, (_m, prefix: string, url: string) =>
    prefix + put(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`),
  );

  // 7) 原始 HTML 标签（占位，避免被转义）
  s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, (tag: string) => put(sanitizeTag(tag)));

  // 8) 剩余文本转义
  s = s.replace(/[&<>]/g, (char: string) => ENTITY[char] ?? char);

  // 9) 强调 / 删除线（先处理 ** 和 __，再处理单个 * 和 _）
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // 下划线强调不允许出现在单词中间（和构建用的 micromark 规则一致）
  s = s.replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '<em>$1</em>');

  // 10) 还原占位符
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => slots[Number(n)] ?? '');
}

/* ---------------- 块级渲染 ---------------- */

type Lines = string[];

const LIST_RE = /^(\s{0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TASK_RE = /^\[( |x|X)\]\s+(.*)$/;

/** 标题锚点 id（每次渲染重置，重复标题自动加后缀） */
let headingIds = new Set<string>();

function headingId(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const id = base || 'section';
  let unique = id;
  let index = 2;
  while (headingIds.has(unique)) {
    unique = `${id}-${index}`;
    index += 1;
  }
  headingIds.add(unique);
  return unique;
}

function renderHeading(level: number, text: string, ctx: InlineContext): string {
  const tag = `h${level}`;
  return `<${tag} id="${escapeAttr(headingId(text))}">${renderInline(text, ctx)}</${tag}>`;
}

function renderCodeBlock(code: string, lang: string): string {
  const label = lang ? ` data-language="${escapeAttr(lang)}"` : '';
  return (
    `<pre class="md-code"${label} style="background: oklch(var(--b2)); border: 1px solid oklch(var(--bc) / 12%); ` +
    `white-space: pre-wrap; word-break: break-word;"><code>${highlightComments(code, lang)}</code></pre>`
  );
}

/* ---------------- 代码块里的注释上色 ----------------
   预览不做语法高亮（那要引整套 shiki，不值当），但「注释是绿的」这条
   读者一眼就认得，所以这里用一个很小的扫描器，只给注释包一层
   <span class="md-cmt">，颜色由 prose.css 给（和 shiki-themes.mjs 的注释色一致）。

   扫描的三条原则：
     ① 先吃掉字符串（"…" '…' `…`，带反斜杠转义），字符串里的 // # 不算注释；
     ② 行注释到行尾为止；块注释 /* … *\/ 和 <!-- … --> 可以跨行，靠状态吃完；
     ③ 什么算注释看语言：# 只在 shell / python / yaml 这类语言里算，
        C 的 #include 不能被染绿；// 前面紧贴 : 的是 http:// 这种网址，跳过。
   ---------------------------------------------------- */

/** # 是注释的语言 */
const HASH_LANGS = new Set([
  'sh', 'bash', 'shell', 'zsh', 'console', 'shellsession', 'shellscript', 'fish',
  'py', 'python', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'properties',
  'dockerfile', 'docker', 'makefile', 'make', 'r', 'ruby', 'rb', 'perl', 'pl',
  'nginx', 'crontab', 'dotenv', 'env', 'gitignore',
]);

/** -- 是注释的语言 */
const DASH_LANGS = new Set(['sql', 'lua', 'haskell', 'hs', 'ada']);

/** // 在这里不是注释（正文/链接/纯文本），免得把网址染绿 */
const NO_SLASH_LANGS = new Set(['text', 'txt', 'plain', 'plaintext', 'md', 'markdown', 'http', 'url']);

/** 把代码里的注释包成 <span class="md-cmt">，其余原样转义 */
function highlightComments(code: string, lang: string): string {
  const name = lang.trim().toLowerCase().split(/[\s:]/)[0] ?? '';
  const hash = HASH_LANGS.has(name);
  const dash = DASH_LANGS.has(name);
  const slash = !NO_SLASH_LANGS.has(name);

  const out: string[] = [];
  let plain = '';
  let index = 0;

  const flush = (): void => {
    if (plain) {
      out.push(escapeHtml(plain));
      plain = '';
    }
  };

  /** 从 start 开始找 token，找不到就吃到这里 */
  const take = (start: number, token: string): number => {
    const found = code.indexOf(token, start);
    return found === -1 ? code.length : found + token.length;
  };

  while (index < code.length) {
    const char = code[index] ?? '';
    const next = code[index + 1] ?? '';
    const prev = index > 0 ? code[index - 1] ?? '' : '';

    // ① 字符串：整段当普通文本，里面出现的 // # 都不算注释
    if (char === '"' || char === "'" || char === '`') {
      let end = index + 1;
      while (end < code.length) {
        const current = code[end] ?? '';
        if (current === '\\') {
          end += 2;
          continue;
        }
        if (current === char) {
          end += 1;
          break;
        }
        // 单引号 / 双引号不跨行（跟 C、JS 一样），换行就当字符串没闭合
        if (current === '\n' && char !== '`') break;
        end += 1;
      }
      plain += code.slice(index, end);
      index = end;
      continue;
    }

    // ② 块注释：/* … */、<!-- … -->
    if (char === '/' && next === '*') {
      const end = take(index + 2, '*/');
      flush();
      out.push(`<span class="md-cmt">${escapeHtml(code.slice(index, end))}</span>`);
      index = end;
      continue;
    }

    if (char === '<' && code.startsWith('<!--', index)) {
      const end = take(index + 4, '-->');
      flush();
      out.push(`<span class="md-cmt">${escapeHtml(code.slice(index, end))}</span>`);
      index = end;
      continue;
    }

    // ③ 行注释：// （网址里的 :// 不算）
    if (slash && char === '/' && next === '/' && prev !== ':') {
      const lineEnd = code.indexOf('\n', index);
      const end = lineEnd === -1 ? code.length : lineEnd;
      flush();
      out.push(`<span class="md-cmt">${escapeHtml(code.slice(index, end))}</span>`);
      index = end;
      continue;
    }

    // ④ 行注释：-- xx
    if (dash && char === '-' && next === '-') {
      const lineEnd = code.indexOf('\n', index);
      const end = lineEnd === -1 ? code.length : lineEnd;
      flush();
      out.push(`<span class="md-cmt">${escapeHtml(code.slice(index, end))}</span>`);
      index = end;
      continue;
    }

    // ⑤ 行注释：# xx（前面得是行首或空白，`a#b` 这种不算）
    if (hash && char === '#' && (!prev || /\s/.test(prev))) {
      const lineEnd = code.indexOf('\n', index);
      const end = lineEnd === -1 ? code.length : lineEnd;
      flush();
      out.push(`<span class="md-cmt">${escapeHtml(code.slice(index, end))}</span>`);
      index = end;
      continue;
    }

    plain += char;
    index += 1;
  }

  flush();
  return out.join('');
}

function renderFootnotes(footnotes: Footnote[], used: string[]): string {
  const items = footnotes
    .filter((item) => used.includes(item.id))
    .map(
      (item, index) =>
        `<li id="fn-${escapeAttr(item.id)}">\n<p>${renderInline(item.text, { footnotes: [], used: [] })} ` +
        `<a href="#fnref-${escapeAttr(item.id)}" data-footnote-backref aria-label="返回正文">${index + 1}↩</a></p>\n</li>`,
    )
    .join('\n');

  return `\n<section data-footnotes class="footnotes">\n<h2 class="sr-only" id="footnote-label">脚注</h2>\n<ol>\n${items}\n</ol>\n</section>`;
}

/** 段落是否会被块级语法打断 */
function isBlockStart(line: string): boolean {
  if (!line.trim()) return true;
  if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s{0,3}[-*+]\s+/.test(line)) return true;
  if (/^\s{0,3}\d{1,9}[.)]\s+/.test(line)) return true;
  if (/^\s*<(?!\/)(?:[a-zA-Z]|!)/.test(line)) return true;
  return false;
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|');
}

/** 表格：表头行 + 对齐分隔行 + 数据行 */
function parseTable(lines: Lines, start: number, out: string[], ctx: InlineContext): number {
  const header = splitCells(lines[start] ?? '');
  const align = splitCells(lines[start + 1] ?? '').map((cell) => {
    const value = cell.trim();
    if (/^:-+:$/.test(value)) return 'center';
    if (/^:-+$/.test(value)) return 'left';
    if (/^-+:$/.test(value)) return 'right';
    return '';
  });

  let index = start + 2;
  const rows: string[][] = [];
  while (index < lines.length && (lines[index] ?? '').trim() && (lines[index] ?? '').includes('|')) {
    rows.push(splitCells(lines[index] ?? ''));
    index += 1;
  }

  const cell = (tag: 'th' | 'td', value: string, column: number): string => {
    const style = align[column] ? ` style="text-align: ${align[column]}"` : '';
    return `<${tag}${style}>${renderInline(value.trim(), ctx)}</${tag}>`;
  };

  const thead = `<tr>${header.map((value, column) => cell('th', value, column)).join('')}</tr>`;
  const tbody = rows
    .map(
      (row) =>
        `<tr>${header
          .map((_value, column) => cell('td', row[column] ?? '', column))
          .join('')}</tr>`,
    )
    .join('\n');

  out.push(`<table>\n<thead>\n${thead}\n</thead>\n<tbody>\n${tbody}\n</tbody>\n</table>`);
  return index;
}

interface ListItem {
  content: string[];
  task: boolean;
  checked: boolean;
}

/** 列表（含嵌套与任务列表） */
function parseListBlock(lines: Lines, start: number, out: string[], ctx: InlineContext): number {
  const first = (lines[start] ?? '').match(LIST_RE)!;
  const ordered = /\d/.test(first[2] ?? '');
  const baseIndent = (first[1] ?? '').length;
  const contentIndent = baseIndent + (first[2] ?? '').length + 1;

  const items: ListItem[] = [];
  let loose = false;
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const item = line.match(LIST_RE);

    if (item && (item[1] ?? '').length === baseIndent && /\d/.test(item[2] ?? '') === ordered) {
      const text = (item[3] ?? '').trimEnd();
      const task = TASK_RE.exec(text);
      items.push(
        task
          ? { content: [task[2] ?? ''], task: true, checked: task[1] === 'x' || task[1] === 'X' }
          : { content: [text], task: false, checked: false },
      );
      index += 1;
      continue;
    }

    if (item) {
      const indent = (item[1] ?? '').length;
      if (indent > baseIndent) {
        // 更深一层：属于当前条目的嵌套列表
        const current = items[items.length - 1];
        if (current) {
          current.content.push(line.slice(Math.min(indent, contentIndent)));
          index += 1;
          continue;
        }
      }
      break;
    }

    if (!line.trim()) {
      // 空行：后面还是同级列表项就是松散列表（条目内容包 <p>），否则列表结束
      let look = index;
      while (look < lines.length && !(lines[look] ?? '').trim()) look += 1;
      const next = look < lines.length ? (lines[look] ?? '').match(LIST_RE) : null;
      if (next && (next[1] ?? '').length === baseIndent && /\d/.test(next[2] ?? '') === ordered) {
        loose = true;
        index = look;
        continue;
      }
      break;
    }

    // 缩进的续行：属于当前条目
    const current = items[items.length - 1];
    const indent = (line.match(/^\s*/)?.[0] ?? '').length;
    if (current && indent >= baseIndent + 2) {
      current.content.push(line.slice(Math.min(indent, contentIndent)));
      index += 1;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const taskList = !ordered && items.some((item) => item.task);
  const open = taskList ? `<ul class="contains-task-list">` : `<${tag}>`;

  const body = items
    .map((item) => {
      const checkbox = item.task ? `<input type="checkbox"${item.checked ? ' checked' : ''} disabled> ` : '';
      let html = item.content.length ? parseBlocks(item.content, ctx).trim() : '';
      // 紧凑列表：条目内容最外层的 <p> 去掉（和 GFM 的 tight list 输出一致），
      // 后面还可能跟着嵌套列表，所以只剥第一段。
      if (!loose && html.startsWith('<p>')) {
        const close = html.indexOf('</p>');
        if (close !== -1) html = html.slice(3, close) + html.slice(close + 4);
      }
      return `<li${item.task ? ' class="task-list-item"' : ''}>${checkbox}${html}</li>`;
    })
    .join('\n');

  out.push(`${open}\n${body}\n</${ordered ? 'ol' : 'ul'}>`);
  return index;
}

function parseBlocks(lines: Lines, ctx: InlineContext): string {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // 围栏代码块（没闭合就吃到文末，和构建行为一致）
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/);
    if (fence) {
      const marker = (fence[1] ?? '[^`]')[0] ?? '`';
      const lang = (fence[2] ?? '').toLowerCase();
      const code: string[] = [];
      index += 1;
      while (index < lines.length) {
        if (new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{3,}\\s*$`).test(lines[index] ?? '')) {
          index += 1;
          break;
        }
        code.push(lines[index] ?? '');
        index += 1;
      }
      out.push(renderCodeBlock(code.join('\n'), lang));
      continue;
    }

    // ATX 标题
    const heading = line.match(/^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/);
    if (heading) {
      out.push(renderHeading((heading[1] ?? '#').length, (heading[2] ?? '').trim(), ctx));
      index += 1;
      continue;
    }

    // 分隔线
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    // 引用块（可嵌套）
    if (/^\s{0,3}>/.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? '')) {
        inner.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      out.push(`<blockquote>\n${parseBlocks(inner, ctx)}\n</blockquote>`);
      continue;
    }

    // 表格
    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1] ?? '')
    ) {
      index = parseTable(lines, index, out, ctx);
      continue;
    }

    // 列表
    if (LIST_RE.test(line)) {
      index = parseListBlock(lines, index, out, ctx);
      continue;
    }

    // 原始 HTML 块（到空行为止）
    if (/^\s*<(?!\/)(?:[a-zA-Z]|!)/.test(line)) {
      const block: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim()) {
        block.push(lines[index] ?? '');
        index += 1;
      }
      out.push(sanitizeBlock(block.join('\n')));
      continue;
    }

    // 段落（顺带识别 setext 标题：下一行是 === 或 ---）
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (!current.trim()) break;

      const setext = current.match(/^\s{0,3}(=+|-+)\s*$/);
      if (setext && paragraph.length) {
        out.push(renderHeading(current.includes('=') ? 1 : 2, paragraph.join(' ').trim(), ctx));
        paragraph.length = 0;
        index += 1;
        break;
      }

      if (isBlockStart(current) && paragraph.length) break;
      paragraph.push(current);
      index += 1;
    }

    if (paragraph.length) out.push(`<p>${renderInline(paragraph.join('\n'), ctx)}</p>`);
  }

  return out.join('\n');
}

/* ---------------- 汇总入口 ---------------- */

/** 正文 → HTML（不做完整文档包装，直接塞进 .prose-blog 容器用） */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  // 先抽出脚注定义（[^id]: 内容）
  const footnotes: Footnote[] = [];
  const body: string[] = [];
  for (const line of lines) {
    const def = line.match(/^\[\^([^\]\s]+)\]:\s*(.*)$/);
    if (def) {
      footnotes.push({ id: def[1] ?? '', text: def[2] ?? '' });
      continue;
    }
    body.push(line);
  }

  headingIds = new Set<string>();
  const ctx: InlineContext = { footnotes, used: [] };
  const html = parseBlocks(body, ctx);
  return ctx.used.length ? `${html}${renderFootnotes(footnotes, ctx.used)}` : html;
}

/* ---------------- 预览用的统计与检查 ---------------- */

/** 正文字数（中文按字、英文按词），和文章页「约 X 字」同一套算法 */
export function countWords(body: string): number {
  if (!body) return 0;
  const cjk = (body.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = body
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + words;
}

/** 阅读时长（分钟），和文章页「约 X 分钟」同一套算法（代码块不计入） */
export function readingMinutes(body: string): number {
  if (!body) return 1;
  const text = body.replace(/```[\s\S]*?```/g, ' ');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = text
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

/**
 * 预览前的语法提醒。
 * 目前查最常见的一类：``` 代码块数是奇数（有围栏没闭合）。
 * 返回空数组 = 没发现问题。
 */
export function previewWarnings(body: string): string[] {
  const warnings: string[] = [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');

  let open: string | null = null;
  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!fence) continue;
    const marker = (fence[1] ?? '')[0] ?? '`';
    if (open === null) {
      open = marker;
    } else if (open === marker) {
      open = null;
    }
  }
  if (open !== null) warnings.push('有 ``` 代码块没有闭合');

  return warnings;
}
