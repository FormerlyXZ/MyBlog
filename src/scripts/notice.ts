/**
 * 首页站点公告：胶囊 / 竖屏图标 + 公告弹窗 + 站长编辑
 * ============================================================
 * 这一份脚本管三件事：
 *
 * ① 入口
 *    · 桌面（≥1024px）：侧栏最上面那枚胶囊，图标 + 单行滚动播报 + 未读红点
 *    · 竖屏（<1024px）：个人卡右上角的小喇叭图标，只有图标和红点，不滚动
 *    两种形态都用 [data-notice-open] 标记，点开都是同一个 <dialog>。
 *
 * ② 弹窗
 *    「站点公告 / 更新日志」两个标签页，列表**由脚本渲染**：
 *    内联在 <dialog data-notice-book> 里的 JSON 是唯一数据源，
 *    站长提交后立刻能用同一份模板重画，不用等站点重建（约 1 分钟）。
 *
 * ③ 站长编辑（只有本人看得到入口）
 *    新建 / 编辑 / 删除 = 一次 GitHub 提交（config/notices.json），
 *    提交后自动触发重新构建部署。令牌来自写作会话
 *    （localStorage['melodyxz-edit']，scope=repo），不经过任何第三方。
 *
 * 未读的判断：localStorage['melodyxz-notice-seen'] 里存一个时间戳，
 * 比它新的条目就算未读。打开弹窗即视为已读（两个列表一起），
 * 弹窗里的两个标签页各自还会点亮小圆点，告诉你「新的在哪个页」。
 * ============================================================
 */

import { onPageLoad, onBeforeSwap } from './pageload';
import { ADMIN_OWNERS } from '../consts';
import {
  ApiError,
  getEditSession,
  getSession,
  onAuthChange,
  onEditAuthChange,
  openEditLogin,
  showToast,
} from '../utils/site';
import { getFile, putFile } from '../utils/github';
import {
  NOTICE_KINDS,
  NOTICE_LIST_LIMIT,
  NOTICE_TICKER_LIMIT,
  isSafeNoticeHref,
  newestNoticeTimestamp,
  normalizeNoticeBook,
  noticeDateLabel,
  noticeHeadline,
  noticeIso,
  noticeLevelLabel,
  noticeKindLabel,
  noticeKindShort,
  noticeTimestamp,
  sortNotices,
  type NoticeBook,
  type NoticeItem,
  type NoticeKind,
  type NoticeLevel,
} from '../utils/notice-meta';

/** 公告数据文件（新建 / 编辑 / 删除都是改这一个文件） */
const NOTICES_PATH = 'config/notices.json';
/** 读到哪儿了（毫秒时间戳）：比它新的条目算未读 */
const SEEN_KEY = 'melodyxz-notice-seen';
/** 上次看的标签页，下次打开还在那一页 */
const TAB_KEY = 'melodyxz-notice-tab';
/** 胶囊里一句停留多久（毫秒） */
const ROTATE_MS = 6200;

/* ============================================================
   状态
   ============================================================ */

let book: NoticeBook = { announcements: [], changelog: [] };
let activeKind: NoticeKind = 'announcements';
/** 打开弹窗那一刻算出来的「哪几个列表有新的」，用来点亮标签页的小圆点 */
let pendingKinds: NoticeKind[] = [];
/** 正在编辑的那条（null = 新建） */
let editing: { kind: NoticeKind; id: string | null } | null = null;
/** 提交中（防止连点两次提交两份） */
let busy = false;
/** 胶囊轮播的定时器，换页前要清掉 */
let tickers: Array<{ timer?: number }> = [];
let resizeTimer: number | undefined;

/* ============================================================
   小工具
   ============================================================ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function noticeDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('[data-notice-dialog]');
}

function listOf(dialog: HTMLElement, kind: NoticeKind): HTMLElement | null {
  return dialog.querySelector<HTMLElement>(`[data-notice-list="${kind}"]`);
}

function fieldEl(name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  const dialog = noticeDialog();
  return (
    dialog?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-notice-field="${name}"]`,
    ) ?? null
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地时间：2026-10-29 21:10 */
function nowText(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 8 位随机 id（和动态、相册用的同一套写法） */
function newNoticeId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '提交失败，请稍后重试';
}

/* ============================================================
   会话：谁能编辑
   ============================================================ */

function isOwnerLogin(): boolean {
  const session = getSession();
  return Boolean(session && ADMIN_OWNERS.includes(session.login));
}

/** 有写作授权（repo）或者是站长登录过 → 显示编辑入口 */
function canManage(): boolean {
  return Boolean(getEditSession()) || isOwnerLogin();
}

/* ============================================================
   读 / 写已读状态
   ============================================================ */

function readSeenAt(): number {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') as { at?: number };
    return Number(parsed?.at) || 0;
  } catch {
    return 0;
  }
}

function writeSeenAt(at: number): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ at }));
  } catch {
    /* 隐私模式写不进去，忽略；红点会一直亮，不影响阅读 */
  }
}

/** 整个数据里最新一条的时间戳 */
function newestTimestamp(): number {
  return Math.max(newestNoticeTimestamp(book.announcements), newestNoticeTimestamp(book.changelog));
}

/** 哪些列表有比「上次读到的地方」更新的条目 */
function unreadKinds(): NoticeKind[] {
  const seen = readSeenAt();
  return NOTICE_KINDS.map((kind) => kind.key).filter(
    (kind) => newestNoticeTimestamp(book[kind]) > seen,
  );
}

/* ============================================================
   红点
   ============================================================ */

/** 胶囊 / 竖屏图标上的红点（两个入口一起亮一起灭） */
function paintEntryDots(show: boolean): void {
  for (const dot of document.querySelectorAll<HTMLElement>('[data-notice-dot]')) {
    dot.hidden = !show;
  }
}

/** 弹窗里两个标签页各自的小圆点 */
function paintTabDots(): void {
  for (const kind of NOTICE_KINDS) {
    const dot = document.querySelector<HTMLElement>(`[data-notice-tab-dot="${kind.key}"]`);
    if (dot) dot.hidden = !pendingKinds.includes(kind.key);
  }
}

/** 按当前数据和已读记录重新算一遍红点 */
function refreshUnread(): void {
  pendingKinds = unreadKinds();
  paintEntryDots(pendingKinds.length > 0);
  paintTabDots();
}

/* ============================================================
   渲染列表
   ============================================================ */

function renderEmpty(kind: NoticeKind): HTMLElement {
  const wrapper = el('div', 'notice-empty');
  const text = el('p', 'notice-empty__text');
  const meta = NOTICE_KINDS.find((item) => item.key === kind);
  text.textContent = meta?.empty ?? '还没有内容';
  wrapper.append(text);

  const hint = el('p', 'notice-empty__hint');
  hint.textContent = canManage()
    ? '点右上角「新建」写第一条；提交后约 1 分钟自动部署生效。'
    : '等站长更新吧～';
  wrapper.append(hint);
  return wrapper;
}

function renderItem(kind: NoticeKind, item: NoticeItem, manageable: boolean): HTMLElement {
  const article = el('article', `notice-item${item.pinned ? ' is-pinned' : ''}`);
  article.dataset.noticeItem = item.id;
  article.dataset.noticeKind = kind;
  article.dataset.noticeTs = String(noticeTimestamp(item.time));
  if (manageable) article.classList.add('notice-item--owned');

  const head = el('header', 'notice-item__head');

  const title = el('h3', 'notice-item__title');
  title.textContent = item.title || '未命名';
  head.append(title);

  if (kind === 'changelog' && item.version) {
    const version = el('span', 'notice-item__version');
    version.textContent = item.version;
    head.append(version);
  }

  if (kind === 'announcements' && item.level && item.level !== 'info') {
    const level = el('span', `notice-item__level notice-item__level--${item.level}`);
    level.textContent = noticeLevelLabel(item.level);
    head.append(level);
  }

  if (item.pinned) {
    const pin = el('span', 'notice-item__pin');
    pin.textContent = '置顶';
    head.append(pin);
  }

  const time = el('time', 'notice-item__time');
  time.dateTime = noticeIso(item.time);
  time.textContent = noticeDateLabel(item.time);
  head.append(time);

  article.append(head);

  if (item.content) {
    const text = el('p', 'notice-item__text');
    text.textContent = item.content;
    article.append(text);
  }

  if (item.items?.length) {
    const points = el('ul', 'notice-item__points');
    for (const point of item.items) {
      const li = el('li');
      li.textContent = point;
      points.append(li);
    }
    article.append(points);
  }

  if (item.link && isSafeNoticeHref(item.link.href)) {
    const link = el('a', 'notice-item__link');
    link.href = item.link.href;
    link.textContent = item.link.text || '查看详情';
    if (/^https?:/i.test(item.link.href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    article.append(link);
  }

  if (manageable) {
    const ops = el('div', 'notice-item__ops');
    const edit = el('button', 'notice-op');
    edit.type = 'button';
    edit.dataset.noticeEdit = item.id;
    edit.dataset.noticeOpKind = kind;
    edit.textContent = '编辑';
    const remove = el('button', 'notice-op notice-op--danger');
    remove.type = 'button';
    remove.dataset.noticeRemove = item.id;
    remove.dataset.noticeOpKind = kind;
    remove.textContent = '删除';
    ops.append(edit, remove);
    article.append(ops);
  }

  return article;
}

function renderLists(): void {
  const dialog = noticeDialog();
  if (!dialog) return;

  const manageable = canManage();

  for (const kind of NOTICE_KINDS) {
    const list = listOf(dialog, kind.key);
    const count = dialog.querySelector<HTMLElement>(`[data-notice-tab-count="${kind.key}"]`);
    if (count) count.textContent = String(book[kind.key].length);
    if (!list) continue;

    list.textContent = '';
    const items = book[kind.key].slice(0, NOTICE_LIST_LIMIT);
    if (!items.length) {
      list.append(renderEmpty(kind.key));
      continue;
    }
    for (const item of items) list.append(renderItem(kind.key, item, manageable));
  }
}

/* ============================================================
   胶囊里的滚动播报
   ============================================================ */

function stopTickers(): void {
  for (const ticker of tickers) {
    if (ticker.timer !== undefined) window.clearInterval(ticker.timer);
  }
  tickers = [];
}

/**
 * 量一下这句放不放得下，放不下就左右来回滚。
 * 文字宽度用 scrollWidth（不滚动状态下就是真实字宽），
 * 可见宽度取 line 的 clientWidth —— line 是 absolute inset:0，宽度等于胶囊可视宽度。
 */
function fitLine(line: HTMLElement): void {
  const text = line.querySelector<HTMLElement>('[data-notice-text]');
  if (!text) return;

  text.classList.remove('is-scrolling');
  text.style.removeProperty('--notice-shift');
  text.style.removeProperty('--notice-dur');
  // 强制回流：让上面两行先真的生效，量到的才是「不滚动」时的宽度
  void text.offsetWidth;

  const visible = line.clientWidth;
  const natural = text.scrollWidth;
  if (visible <= 0 || natural <= visible + 8) return;

  const shift = natural - visible + 14;
  const duration = Math.min(28, Math.max(9, Math.round(shift / 24)));
  text.style.setProperty('--notice-shift', `-${shift}px`);
  text.style.setProperty('--notice-dur', `${duration}s`);
  text.classList.add('is-scrolling');
}

function startTickers(): void {
  stopTickers();
  const reduce = prefersReducedMotion();

  for (const pill of document.querySelectorAll<HTMLElement>('[data-notice-open]')) {
    const lines = Array.from(pill.querySelectorAll<HTMLElement>('[data-notice-line]'));
    // 竖屏那个只有图标，没有滚动行 —— 跳过
    if (!lines.length) continue;

    let index = 0;
    let timer: number | undefined;

    const paint = () => {
      lines.forEach((line, i) => {
        const current = i === index;
        line.classList.toggle('is-current', current);
        line.setAttribute('aria-hidden', current ? 'false' : 'true');
        if (current) fitLine(line);
      });
    };

    paint();

    // 只有一条、或系统开了「减少动态效果」：就静静停在那儿，不轮播
    if (lines.length > 1 && !reduce) {
      timer = window.setInterval(() => {
        index = (index + 1) % lines.length;
        paint();
      }, ROTATE_MS);
    }

    tickers.push({ timer });
  }
}

/** 用最新数据重画所有胶囊里的那几行字 */
function renderTickers(): void {
  const headlines = sortNotices(book.announcements)
    .map((item) => noticeHeadline(item))
    .filter(Boolean)
    .slice(0, NOTICE_TICKER_LIMIT);
  const lines = headlines.length ? headlines : ['站点公告与更新日志，点这里看看'];

  for (const viewport of document.querySelectorAll<HTMLElement>('[data-notice-viewport]')) {
    viewport.textContent = '';
    const wrap = el('span', 'notice-pill__lines');
    lines.forEach((line, index) => {
      const row = el('span', `notice-pill__line${index === 0 ? ' is-current' : ''}`);
      row.dataset.noticeLine = '';
      row.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');
      const text = el('span', 'notice-pill__text');
      text.dataset.noticeText = '';
      text.textContent = line;
      row.append(text);
      wrap.append(row);
    });
    viewport.append(wrap);
  }

  startTickers();
}

/* ============================================================
   标签页 / 表单的显示切换
   ============================================================ */

function updateManageLabel(): void {
  const label = document.querySelector<HTMLElement>('[data-notice-manage-label]');
  if (label) label.textContent = `新建${noticeKindShort(activeKind)}`;
}

function hideForm(): void {
  const dialog = noticeDialog();
  if (!dialog) return;
  editing = null;
  dialog.classList.remove('is-editing');
  const form = dialog.querySelector<HTMLElement>('[data-notice-form]');
  const gate = dialog.querySelector<HTMLElement>('[data-notice-gate]');
  if (form) form.hidden = true;
  if (gate) gate.hidden = true;
  setStatus('');
  for (const panel of dialog.querySelectorAll<HTMLElement>('[data-notice-panel]')) {
    panel.hidden = panel.dataset.noticePanel !== activeKind;
  }
}

function showTab(kind: NoticeKind): void {
  const dialog = noticeDialog();
  if (!dialog) return;

  activeKind = kind;

  for (const tab of dialog.querySelectorAll<HTMLElement>('[data-notice-tab]')) {
    const active = tab.dataset.noticeTab === kind;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  // 切到哪一页，就把哪一页的小圆点点掉
  pendingKinds = pendingKinds.filter((entry) => entry !== kind);
  paintTabDots();

  hideForm();
  updateManageLabel();

  try {
    localStorage.setItem(TAB_KEY, kind);
  } catch {
    /* 忽略 */
  }
}

/* ============================================================
   表单：新建 / 编辑
   ============================================================ */

function setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  const status = document.querySelector<HTMLElement>('[data-notice-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', tone === 'error');
}

function writeField(name: string, value: string): void {
  const field = fieldEl(name);
  if (field) field.value = value;
}

function readField(name: string): string {
  const field = fieldEl(name);
  return field ? String(field.value ?? '') : '';
}

function toggleFieldWrap(name: string, show: boolean): void {
  const wrap = document.querySelector<HTMLElement>(`[data-notice-field-wrap="${name}"]`);
  if (wrap) wrap.hidden = !show;
}

function readPoints(): string[] | undefined {
  const points = readField('items')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return points.length ? points : undefined;
}

function showForm(kind: NoticeKind, item?: NoticeItem): void {
  const dialog = noticeDialog();
  if (!dialog) return;

  editing = { kind, id: item?.id ?? null };

  const titleEl = dialog.querySelector<HTMLElement>('[data-notice-form-title]');
  if (titleEl) titleEl.textContent = `${item ? '编辑' : '发布'}${noticeKindLabel(kind)}`;
  const submitLabel = dialog.querySelector<HTMLElement>('[data-notice-submit-label]');
  if (submitLabel) submitLabel.textContent = item ? '保存修改' : '提交发布';

  writeField('title', item?.title ?? '');
  writeField('content', item?.content ?? '');
  writeField('items', (item?.items ?? []).join('\n'));
  writeField('time', item?.time ?? nowText());
  writeField('version', item?.version ?? '');
  writeField('level', item?.level ?? 'info');
  writeField('linkText', item?.link?.text ?? '');
  writeField('linkHref', item?.link?.href ?? '');

  const pinned = dialog.querySelector<HTMLInputElement>('[data-notice-field="pinned"]');
  if (pinned) pinned.checked = Boolean(item?.pinned);

  // 版本号只有更新日志有，样式只有公告有
  toggleFieldWrap('version', kind === 'changelog');
  toggleFieldWrap('level', kind === 'announcements');

  setStatus('');

  for (const panel of dialog.querySelectorAll<HTMLElement>('[data-notice-panel]')) {
    panel.hidden = true;
  }
  const gate = dialog.querySelector<HTMLElement>('[data-notice-gate]');
  if (gate) gate.hidden = true;
  const form = dialog.querySelector<HTMLElement>('[data-notice-form]');
  if (form) form.hidden = false;
  dialog.classList.add('is-editing');

  fieldEl('title')?.focus();
}

/**
 * 没写作授权时：先让站长授权（repo 权限），授权完直接回到表单。
 * 要编辑哪一条（kind / id）记在 dialog 的 data 属性上，授权回来再取。
 */
function showGate(kind: NoticeKind, item?: NoticeItem): void {
  const dialog = noticeDialog();
  if (!dialog) return;

  for (const panel of dialog.querySelectorAll<HTMLElement>('[data-notice-panel]')) {
    panel.hidden = true;
  }
  const form = dialog.querySelector<HTMLElement>('[data-notice-form]');
  if (form) form.hidden = true;
  const gate = dialog.querySelector<HTMLElement>('[data-notice-gate]');
  if (gate) gate.hidden = false;

  dialog.classList.add('is-editing');
  dialog.dataset.noticeGateKind = kind;
  if (item) dialog.dataset.noticeGateId = item.id;
  else delete dialog.dataset.noticeGateId;
}

/* ============================================================
   提交到 GitHub
   ============================================================ */

function safeParse(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('config/notices.json 不是合法的 JSON，先把文件修好再发布');
  }
}

/** 读仓库里最新的那份 notices.json（避免覆盖别处刚提交的改动） */
async function readRemoteBook(): Promise<{ book: NoticeBook; sha?: string }> {
  const file = await getFile(NOTICES_PATH);
  const parsed = safeParse(file?.text);
  return { book: normalizeNoticeBook(parsed), sha: file?.sha };
}

async function writeRemoteBook(next: NoticeBook, message: string, sha?: string): Promise<void> {
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await putFile(NOTICES_PATH, text, message, sha);
}

async function persistItem(kind: NoticeKind, item: NoticeItem, editingId: string | null): Promise<void> {
  const remote = await readRemoteBook();
  const list = remote.book[kind];

  if (editingId) {
    const index = list.findIndex((entry) => entry.id === editingId);
    if (index >= 0) list[index] = item;
    else list.unshift(item);
  } else {
    list.unshift(item);
  }
  remote.book[kind] = sortNotices(list);

  const action = editingId ? '更新' : '发布';
  await writeRemoteBook(remote.book, `notice: ${action}${noticeKindLabel(kind)} ${item.id}`, remote.sha);

  book = remote.book;
  commitLocalRender();
}

async function removeItem(kind: NoticeKind, id: string): Promise<void> {
  const target = book[kind].find((entry) => entry.id === id);
  if (!target) return;

  const name = target.title || '这条内容';
  if (!window.confirm(`确定删除「${name}」？\n会提交一次 git 记录，删掉后无法从页面恢复。`)) return;

  try {
    const remote = await readRemoteBook();
    remote.book[kind] = sortNotices(remote.book[kind].filter((entry) => entry.id !== id));
    await writeRemoteBook(
      remote.book,
      `notice: 删除${noticeKindLabel(kind)} ${id}`,
      remote.sha,
    );

    book = remote.book;
    // 删掉的正是最后一条新的：顺手把已读位置顶到最新，免得红点一直亮
    writeSeenAt(newestTimestamp());
    pendingKinds = [];
    commitLocalRender();
    showToast('已删除，约 1 分钟后生效');
  } catch (error) {
    showToast(errorText(error));
  }
}

/** 数据变了：列表、胶囊、红点一起重画 */
function commitLocalRender(): void {
  renderLists();
  renderTickers();
  paintEntryDots(false);
  paintTabDots();
}

async function submitForm(event: Event): Promise<void> {
  event.preventDefault();
  if (!editing || busy) return;

  const { kind, id } = editing;
  const title = readField('title').trim();
  const content = readField('content').trim();

  if (!title && !content) {
    setStatus('标题和正文至少写一个吧', 'error');
    fieldEl('title')?.focus();
    return;
  }

  const time = readField('time').trim() || nowText();
  const version = readField('version').trim();
  const level = readField('level') as NoticeLevel | undefined;
  const linkText = readField('linkText').trim();
  const linkHref = readField('linkHref').trim();

  const item: NoticeItem = {
    id: id ?? newNoticeId(),
    time,
    title: title || content.split('\n')[0].slice(0, 60),
    content: content || undefined,
    items: readPoints(),
    level: kind === 'announcements' && level && level !== 'info' ? level : undefined,
    version: kind === 'changelog' && version ? version : undefined,
    pinned: Boolean(
      noticeDialog()?.querySelector<HTMLInputElement>('[data-notice-field="pinned"]')?.checked,
    )
      ? true
      : undefined,
    link: isSafeNoticeHref(linkHref)
      ? { text: linkText || '查看详情', href: linkHref }
      : undefined,
  };

  busy = true;
  const submit = noticeDialog()?.querySelector<HTMLButtonElement>('[data-notice-submit]');
  if (submit) submit.disabled = true;
  setStatus(id ? '正在保存到 GitHub…' : '正在提交到 GitHub…');

  try {
    await persistItem(kind, item, id);
    // 自己刚发的，就算已读——别再给自己亮红点
    writeSeenAt(newestTimestamp());
    pendingKinds = [];
    paintEntryDots(false);
    paintTabDots();
    hideForm();
    showToast('已提交，约 1 分钟后自动部署生效');
  } catch (error) {
    setStatus(errorText(error), 'error');
  } finally {
    busy = false;
    if (submit) submit.disabled = false;
  }
}

/* ============================================================
   弹窗交互
   ============================================================ */

function openDialog(kind?: NoticeKind): void {
  const dialog = noticeDialog();
  if (!dialog) return;

  if (!dialog.open) {
    // 打开前先记下「哪几个列表有新的」，标签页上的小圆点靠它
    pendingKinds = unreadKinds();
    // 打开即视为已读：胶囊红点立刻灭掉
    writeSeenAt(newestTimestamp());
    paintEntryDots(false);
  }

  showTab(kind ?? activeKind);
  if (!dialog.open) dialog.showModal();
}

function bindDialog(dialog: HTMLDialogElement): void {
  if (dialog.dataset.noticeBound === '1') return;
  dialog.dataset.noticeBound = '1';

  dialog.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // 点遮罩空白处关闭（内容区在 .notice-dialog__inner 里，不会命中这一条）
    if (target === dialog) {
      dialog.close();
      return;
    }

    if (target.closest('[data-notice-close]')) {
      dialog.close();
      return;
    }

    const tab = target.closest<HTMLElement>('[data-notice-tab]');
    if (tab?.dataset.noticeTab && !dialog.classList.contains('is-editing')) {
      showTab(tab.dataset.noticeTab as NoticeKind);
      return;
    }

    if (target.closest('[data-notice-manage]')) {
      const editingSession = getEditSession();
      if (!editingSession) showGate(activeKind);
      else showForm(activeKind);
      return;
    }

    const editBtn = target.closest<HTMLElement>('[data-notice-edit]');
    if (editBtn?.dataset.noticeEdit) {
      const kind = (editBtn.dataset.noticeOpKind as NoticeKind) ?? activeKind;
      const item = book[kind].find((entry) => entry.id === editBtn.dataset.noticeEdit);
      if (!item) return;
      if (!getEditSession()) showGate(kind, item);
      else showForm(kind, item);
      return;
    }

    const removeBtn = target.closest<HTMLElement>('[data-notice-remove]');
    if (removeBtn?.dataset.noticeRemove) {
      if (!getEditSession()) {
        showGate((removeBtn.dataset.noticeOpKind as NoticeKind) ?? activeKind);
        return;
      }
      void removeItem(
        (removeBtn.dataset.noticeOpKind as NoticeKind) ?? activeKind,
        removeBtn.dataset.noticeRemove,
      );
      return;
    }

    if (target.closest('[data-notice-cancel]')) {
      hideForm();
      return;
    }

    if (target.closest('[data-notice-login]')) {
      const kind = (dialog.dataset.noticeGateKind as NoticeKind) || activeKind;
      const id = dialog.dataset.noticeGateId;
      const item = id ? book[kind].find((entry) => entry.id === id) : undefined;
      openEditLogin()
        .then(() => {
          renderLists();
          showForm(kind, item);
        })
        .catch((error) => setStatus(errorText(error), 'error'));
      return;
    }
  });

  const form = dialog.querySelector<HTMLFormElement>('[data-notice-form]');
  form?.addEventListener('submit', (event) => {
    void submitForm(event);
  });

  // 点弹窗外（ESC / 关闭按钮之外）也要把编辑态收掉，下次打开是干净的列表
  dialog.addEventListener('close', () => {
    hideForm();
  });
}

/* ============================================================
   初始化
   ============================================================ */

function readBookFromDom(): NoticeBook {
  const dialog = noticeDialog();
  if (!dialog) return { announcements: [], changelog: [] };
  try {
    return normalizeNoticeBook(JSON.parse(dialog.dataset.noticeBook || '{}'));
  } catch {
    return { announcements: [], changelog: [] };
  }
}

function readActiveKind(): NoticeKind {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    if (stored === 'changelog' || stored === 'announcements') return stored;
  } catch {
    /* 忽略 */
  }
  return 'announcements';
}

function init(): void {
  const dialog = noticeDialog();
  if (!dialog) return;

  book = readBookFromDom();
  activeKind = readActiveKind();

  bindDialog(dialog);
  showTab(activeKind);
  renderLists();
  renderTickers();
  refreshUnread();
}

/* ---------------- 全局绑定（模块只执行一次） ---------------- */

// 两个入口（侧栏胶囊 / 竖屏图标）都用 document 级委托，换页后不用重新绑
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const trigger = target?.closest<HTMLElement>('[data-notice-open]');
  if (!trigger) return;
  event.preventDefault();
  openDialog();
});

// 换页前收尾：轮播定时器、打开着的弹窗
onBeforeSwap(() => {
  stopTickers();
  window.clearTimeout(resizeTimer);
  const dialog = noticeDialog();
  if (dialog?.open) dialog.close();
});

// 窗口变宽变窄：重新量一次当前那句放不放得下
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    for (const line of document.querySelectorAll<HTMLElement>('.notice-pill__line.is-current')) {
      fitLine(line);
    }
  }, 160);
});

// 登录 / 授权状态变了：编辑入口要跟着出现或消失
onAuthChange(() => renderLists());
onEditAuthChange(() => renderLists());

onPageLoad(init);
