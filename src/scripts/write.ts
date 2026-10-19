/**
 * /write 页面逻辑
 * ============================================================
 * · 没授权 → 只显示授权空壳
 * · 授权后 → 显示表单；?slug=xxx 会读回文章回填
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
import { getFile, putBinary, putFile } from '../utils/github';

const POSTS_DIR = 'src/content/posts';

interface PostDraft {
  title: string;
  slug: string;
  date: string;
  description: string;
  categories: string;
  tags: string;
  image: string;
  attachments: string;
  badge: boolean;
  draft: boolean;
  body: string;
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
  return {
    title: input('title')?.value.trim() ?? '',
    slug: input('slug')?.value.trim() ?? '',
    date: input('date')?.value || today(),
    description: textarea('description')?.value.trim() ?? '',
    categories: input('categories')?.value.trim() ?? '',
    tags: input('tags')?.value.trim() ?? '',
    image: input('image')?.value.trim() ?? '',
    attachments: input('attachments')?.value.trim() ?? '',
    badge: input('badge')?.checked ?? false,
    draft: input('draft')?.checked ?? false,
    body: textarea('body')?.value ?? '',
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

  lines.push('---', '', draft.body.trim(), '');
  return lines.join('\n');
}

/** 从 .md 文本里拆出 frontmatter 与正文（只认我们写出去的格式） */
function parseMarkdown(text: string): { data: Record<string, string>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const found = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!found) continue;
    const [, key, rawValue] = found;
    if (!key) continue;
    data[key] = (rawValue ?? '').trim();
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
  if (textarea('description')) textarea('description')!.value = unquote(data.description ?? '');
  if (input('image')) input('image')!.value = unquote(data.image ?? '');
  if (input('categories')) input('categories')!.value = parseList(data.categories ?? '').join(', ');
  if (input('tags')) input('tags')!.value = parseList(data.tags ?? '').join(', ');
  if (input('attachments')) input('attachments')!.value = parseList(data.attachments ?? '').join('\n');
  if (input('badge')) input('badge')!.checked = (data.badge ?? '') === 'Pin';
  if (input('draft')) input('draft')!.checked = (data.draft ?? '') === 'true';
  if (textarea('body')) textarea('body')!.value = body.replace(/^\s+/, '');
}

function clearForm(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-field]')) {
    if (el.type === 'checkbox') el.checked = false;
    else if (el.type !== 'file') el.value = '';
  }
  const dateEl = input('date');
  if (dateEl) dateEl.value = today();
  const root = document.querySelector<HTMLElement>('[data-write-root]');
  if (root) root.dataset.editing = '';
  setStatus('');
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

let initialized = false;

async function initWrite(): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-write-root]');
  if (!root) return;

  renderGate();

  // 日期默认今天（用户改过就不动）
  const dateEl = input('date');
  if (dateEl && !dateEl.value) dateEl.value = today();

  if (!initialized) {
    initialized = true;

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
        setStatus('封面已上传');
        showToast('封面已上传');
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

      setStatus('提交中…');
      try {
        const path = `${POSTS_DIR}/${draft.slug}.md`;
        const existing = await getFile(path);
        const content = buildMarkdown(draft);
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

/** 带 ?slug= 时读回文章并回填 */
async function maybeLoadExisting(root: HTMLElement): Promise<void> {
  const slug = root.dataset.slug;
  if (!slug || root.dataset.loaded === '1') return;
  if (!getEditSession()) return;

  root.dataset.loaded = '1';
  setStatus('读取文章中…');
  try {
    const file = await getFile(`${POSTS_DIR}/${slug}.md`);
    if (!file) {
      setStatus('没有找到这篇文章，可以当作新文章继续写');
      return;
    }
    const { data, body } = parseMarkdown(file.text);
    fillForm(data, body);
    const slugEl = input('slug');
    if (slugEl) {
      slugEl.value = slug;
      slugEl.dataset.touched = '1';
    }
    root.dataset.editing = slug;
    setStatus('已读取现有文章');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '读取失败');
  }
}

onPageLoad(() => {
  void initWrite();
});
