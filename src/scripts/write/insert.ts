/**
 * 写作台：把 Markdown 片段插到光标处
 * ============================================================
 * 所有操作都直接改 textarea 的 value，然后派发一次 input 事件 ——
 * 主程序靠这个事件统一做「变脏 / 预览重绘 / 大纲刷新 / 字数统计」。
 *
 * 几条排版约定：
 *   · 块级元素（代码块 / 表格 / 图片 / 分隔线）前后留空行，
 *     否则会被 Markdown 解析成上一段的内容；
 *   · 有选中文字时，行内语法包住选中内容；没选中时插入占位文字并选中它，
 *     这样接着敲字就是替换占位，不用先删一遍。
 * ============================================================
 */

export function getEditor(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-wx-body]');
}

/** 改完 value 后让主程序知道内容变了 */
function fire(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 把 [start, end) 换成 text，并按需选中替换后的某一段 */
function replaceRange(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  select?: [number, number],
): void {
  el.value = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
  const from = select ? start + select[0] : start + text.length;
  const to = select ? start + select[1] : from;
  el.focus();
  el.setSelectionRange(from, to);
  fire(el);
}

/** 在光标处插入一小段行内文字（日期之类），不动前后空行 */
export function insertInline(el: HTMLTextAreaElement | null, text: string): void {
  if (!el || !text) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(text, start, end, 'end');
  el.focus();
  fire(el);
}

/** 在光标处插入块级内容：前后各补空行，插完把光标放到内容之后 */
export function insertBlock(el: HTMLTextAreaElement | null, text: string): void {
  if (!el || !text) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);

  const padBefore = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const padAfter = !after || after.startsWith('\n') ? '\n' : '\n\n';
  const chunk = `${padBefore}${text}${padAfter}`;

  el.value = `${before}${chunk}${after}`;
  const caret = before.length + chunk.length;
  el.focus();
  el.setSelectionRange(caret, caret);
  fire(el);
}

/** 行内语法：包住选中内容；没选中就插占位并选中占位 */
export function surround(
  el: HTMLTextAreaElement | null,
  before: string,
  after: string,
  placeholder: string,
): void {
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const selected = el.value.slice(start, end);
  const inner = selected || placeholder;
  const text = `${before}${inner}${after}`;

  // 选中文字时保留选区，方便继续加粗/斜体叠加；没选中时选中占位文字
  replaceRange(el, start, end, text, [before.length, before.length + inner.length]);
}

/** 行首前缀（标题 / 列表 / 引用）：有选区就整段处理，没选区就处理当前行 */
export function prefixLines(
  el: HTMLTextAreaElement | null,
  prefix: string,
  options: { toggle?: boolean; placeholder?: string } = {},
): void {
  if (!el) return;
  const value = el.value;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;

  // 把选区扩到整行
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextBreak = value.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;

  // 空行上点「一级标题 / 列表」：直接在光标处放前缀，光标留在后面
  if (!value.slice(lineStart, lineEnd).trim() && start === end) {
    replaceRange(el, start, start, prefix);
    return;
  }

  const block = value.slice(lineStart, lineEnd) || (options.placeholder ?? '');
  const lines = block.length ? block.split('\n') : [''];

  const headingMatch = prefix.match(/^(#{1,6})\s$/);
  const cleaned = lines.map((line) => {
    if (headingMatch) return line.replace(/^\s{0,3}#{1,6}\s+/, '');
    if (prefix === '> ') return line.replace(/^\s{0,3}>\s?/, '');
    if (prefix === '- ' || prefix === '* ' || prefix === '+ ') {
      return line.replace(/^\s{0,3}([-*+]|\d{1,9}[.)])\s+/, '');
    }
    if (prefix === '1. ') return line.replace(/^\s{0,3}([-*+]|\d{1,9}[.)])\s+/, '');
    if (prefix === '- [ ] ') {
      return line.replace(/^\s{0,3}([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/, '');
    }
    return line;
  });

  const allPrefixed = lines.every((line) => line.trim() && line.startsWith(prefix));
  const shouldPrefix = options.toggle === false ? true : !allPrefixed;
  const next = cleaned
    .map((line, index) => {
      if (!shouldPrefix) return line;
      if (!line.trim()) return line;
      if (prefix === '1. ') return `1. ${line}`;
      return `${prefix}${line}`;
    })
    .join('\n');

  replaceRange(el, lineStart, lineEnd, next, [0, next.length]);
}

/** 插入表格：rows 包含表头行（最小 2 行 = 表头 + 一行数据） */
export function insertTable(el: HTMLTextAreaElement | null, cols: number, rows: number): void {
  if (!el) return;
  const columnCount = Math.min(8, Math.max(1, cols));
  const rowCount = Math.max(2, rows);
  const header = Array.from({ length: columnCount }, (_, i) => `列 ${i + 1}`);
  const divider = Array.from({ length: columnCount }, () => '---');
  const bodyRow = Array.from({ length: columnCount }, () => '');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...Array.from({ length: rowCount - 1 }, () => `| ${bodyRow.join(' | ')} |`),
  ];

  const start = el.selectionStart ?? el.value.length;
  insertBlock(el, lines.join('\n'));

  // 选中第一列表头「列 1」，接着敲字就是改列名
  const now = el.value;
  const first = now.indexOf('列 1', start);
  if (first !== -1) {
    el.focus();
    el.setSelectionRange(first, first + '列 1'.length);
  }
}

/** 插入围栏代码块；有选中文字就把它包进代码块 */
export function insertCodeBlock(el: HTMLTextAreaElement | null, lang = ''): void {
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const selected = el.value.slice(start, end);
  const fence = '```';
  const inner = selected || (lang ? '' : '');
  const text = `${fence}${lang}\n${inner}\n${fence}`;
  insertBlock(el, text);

  // 光标放到代码块里第一行行首，方便直接敲代码
  const now = el.value;
  const caret = el.selectionStart ?? now.length;
  const pos = now.lastIndexOf(`${fence}${lang}\n`, caret);
  if (pos !== -1) {
    const target = pos + `${fence}${lang}\n`.length;
    el.focus();
    el.setSelectionRange(target, target);
  }
}

/** 链接：有选中文字就拿它当文字，否则占位 */
export function insertLink(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const selected = el.value.slice(start, end);
  const label = selected || '链接文字';
  const text = `[${label}](https://)`;
  replaceRange(el, start, end, text, selected ? [1, 1 + label.length] : [1, 1 + label.length]);
}

/** 脚注：先插引用，再把定义追加到文末（已存在同名定义就不重复追加） */
export function insertFootnote(el: HTMLTextAreaElement | null, note: string): void {
  if (!el) return;
  const text = el.value;
  let index = 1;
  while (text.includes(`[^${index}]`)) index += 1;
  const ref = `[^${index}]`;

  const start = el.selectionStart ?? text.length;
  const end = el.selectionEnd ?? start;
  const selected = el.value.slice(start, end);
  replaceRange(el, start, end, `${ref}${selected}`);

  if (!text.includes(`[^${index}]:`)) {
    const definition = `\n\n[^${index}]: ${note || '脚注说明'}`;
    const pos = el.value.length;
    el.value += definition;
    el.focus();
    el.setSelectionRange(pos + definition.length, el.value.length);
    el.scrollTop = el.scrollHeight;
    fire(el);
  }
}

/** 插图 / 附件：图片用 ![]()，其它用普通链接 */
export function mediaToMarkdown(file: {
  name: string;
  url: string;
  type?: string;
}): string {
  const isImage =
    (file.type || '').startsWith('image/') ||
    /\.(webp|jpe?g|png|gif|avif|svg|bmp)$/i.test(file.name);
  const alt = file.name.replace(/\.[^.]+$/, '');
  return isImage ? `![${alt}](${file.url})` : `[${file.name}](${file.url})`;
}
