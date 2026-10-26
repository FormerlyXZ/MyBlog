/**
 * About Me 编辑页（config/about.json）
 * ============================================================
 * 可视化编辑器：一句 JSON 都不用手写。
 *
 *   个人简介   intro[]                 一段一个输入框，能加 / 删 / 上下挪
 *   关于本站   aboutSite.title
 *              aboutSite.description
 *   功能清单   aboutSite.sections[]    每组 = 分组名 + 若干条 { title, text }
 *   页尾致谢   credit
 *   进阶       JSON 源码              和 /config 一样：整份直接改，带格式化与校验
 *
 * 数据流和 /config（scripts/config.ts）是同一套：
 *   读取 getFile → 内存里的 config 对象 ←→ 控件 → 整理后 putFile（一次 commit）。
 *
 * 与 /config 的两点不同：
 *   ① 这里全是「数组套对象」，行由脚本渲染（静态的标题 / 说明写在 about/edit.astro 里）；
 *   ② 没有 site.title 那种「必须有」的硬约束，提交前只做整理：
 *      空段落、空条目自动丢掉，分组名兜底成「关于本站」。
 *
 * 所有 data-ab-* 前缀都是这份编辑器专用的 —— 不跟 /config 的 data-config-* 混用，
 * 换页后两份脚本同时挂在 document 上也不会互相抢事件。
 */

import { onPageLoad } from './pageload';
import { clearEditSession, getEditSession, openEditLogin, showToast } from '../utils/site';
import { getFile, putFile } from '../utils/github';

type Json = Record<string, unknown>;

const PATH_DEFAULT = 'config/about.json';

/* ============================================================
   1. 内存状态
   ============================================================ */

/** 编辑器手里的 about.json（未知字段原样保留，不做裁剪） */
let config: Json = blank();
/** 最近一次读到的文件 sha（提交时要用） */
let fileSha: string | undefined;
/** JSON 源码板块里有没有还没并回表单的改动 */
let jsonDirty = false;
/** 有没有没保存的改动（重新读取前会问一句） */
let dirty = false;
/** 仓库里那份有没有真的读下来（没读下来时不做「没改动就不提交」的判断） */
let loadedOk = false;

/** 一份空的 about.json */
function blank(): Json {
  return {
    intro: [],
    aboutSite: { title: '关于本站', description: '', sections: [] },
    credit: '',
  };
}

/* ============================================================
   2. 路径读写 / 类型小工具
   ============================================================ */

function isObj(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getAt(source: Json, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (isObj(current) && key in current) current = current[key];
    else return undefined;
  }
  return current;
}

function setAt(target: Json, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Json = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i] as string;
    if (!isObj(current[key])) current[key] = {};
    current = current[key] as Json;
  }
  current[keys[keys.length - 1] as string] = value;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* ============================================================
   3. 结构：intro / aboutSite / sections / items
   ============================================================ */

/** aboutSite 这一层（缺字段就补上） */
function siteObj(): Json {
  if (!isObj(config.aboutSite)) {
    config.aboutSite = { title: '关于本站', description: '', sections: [] };
  }
  return config.aboutSite;
}

/** 功能清单的分组数组 */
function sectionList(): Json[] {
  const site = siteObj();
  if (!Array.isArray(site.sections)) site.sections = [];
  const list = site.sections as unknown[];
  list.forEach((raw, index) => {
    if (!isObj(raw)) list[index] = { title: asString(raw), items: [] };
  });
  return list as Json[];
}

/** 某个分组下面的条目数组 */
function itemList(section: Json): Json[] {
  if (!Array.isArray(section.items)) section.items = [];
  const list = section.items as unknown[];
  list.forEach((raw, index) => {
    if (!isObj(raw)) list[index] = { title: asString(raw), text: '' };
  });
  return list as Json[];
}

/** 自我介绍段落（一个字符串一段） */
function introList(): string[] {
  const list = asArray(config.intro).map((raw) => asString(raw));
  config.intro = list;
  return list;
}

/**
 * 把仓库里读到的 JSON 规整成编辑器认识的形状。
 * 手写 JSON 时可能只写了一个字符串、少写 items 之类，这里统一兜住；
 * 多余的字段（将来加的）原样保留。
 */
function normalize(raw: Json): Json {
  const site = isObj(raw.aboutSite) ? raw.aboutSite : {};

  const sections = asArray(site.sections).map((section) => {
    const box = isObj(section) ? section : {};
    return {
      ...box,
      title: asString(box.title),
      items: asArray(box.items).map((item) =>
        isObj(item)
          ? { ...item, title: asString(item.title), text: asString(item.text) }
          : { title: asString(item), text: '' },
      ),
    };
  });

  return {
    ...raw,
    intro: asArray(raw.intro).map((raw2) => asString(raw2)),
    aboutSite: {
      ...site,
      title: asString(site.title, '关于本站'),
      description: asString(site.description),
      sections,
    },
    credit: asString(raw.credit),
  };
}

/** 提交前整理：空段落 / 空条目丢掉，分组名兜底 */
function cleanForSave(): Json {
  const site = siteObj();

  const sections = sectionList()
    .map((section) => ({
      title: asString(section.title).trim(),
      items: itemList(section)
        .map((item) => ({
          title: asString(item.title).trim(),
          text: asString(item.text).trim(),
        }))
        .filter((item) => item.title || item.text),
    }))
    .filter((section) => section.title || section.items.length);

  return {
    ...config,
    intro: introList()
      .map((text) => text.trim())
      .filter(Boolean),
    aboutSite: {
      ...site,
      title: asString(site.title).trim() || '关于本站',
      description: asString(site.description).trim(),
      sections,
    },
    credit: asString(config.credit).trim(),
  };
}

/* ============================================================
   4. 界面开关 / 状态文字
   ============================================================ */

function rootEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-ab-root]');
}

function aboutPath(): string {
  return rootEl()?.dataset.abPath ?? PATH_DEFAULT;
}

function setStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-ab-status]');
  if (el) el.textContent = text;
}

function markDirty(): void {
  dirty = true;
  setStatus('有未保存的改动，记得点「保存并提交」');
}

function renderGate(): void {
  const authed = Boolean(getEditSession());
  const gate = document.querySelector<HTMLElement>('[data-ab-gate]');
  const form = document.querySelector<HTMLElement>('[data-ab-form]');
  const logoutBtn = document.querySelector<HTMLElement>('[data-ab-logout]');

  if (gate) gate.hidden = authed;
  if (form) {
    form.hidden = !authed;
    form.classList.toggle('hidden', !authed);
    form.classList.toggle('flex', authed);
  }
  if (logoutBtn) logoutBtn.hidden = !authed;
}

/* ============================================================
   5. 造控件的小工具
   ============================================================ */

function makeInput(placeholder: string, value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.className = 'input-pill';
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function makeArea(placeholder: string, value: string, rows: number): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.className = 'input-pill config-field__area';
  area.rows = rows;
  area.placeholder = placeholder;
  area.spellcheck = false;
  area.value = value;
  return area;
}

function makeIconBtn(glyph: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'config-icon-btn';
  btn.textContent = glyph;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  return btn;
}

function makeEmpty(hint: string): HTMLParagraphElement {
  const empty = document.createElement('p');
  empty.className = 'config-empty';
  empty.textContent = hint;
  return empty;
}

/** 上移 / 下移 / 删除 三个小圆钮 */
function rowActions(opts: {
  up: () => void;
  down: () => void;
  remove: () => void;
  canUp: boolean;
  canDown: boolean;
  removeLabel: string;
}): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'config-row-actions';

  const up = makeIconBtn('↑', '上移');
  up.disabled = !opts.canUp;
  up.addEventListener('click', opts.up);

  const down = makeIconBtn('↓', '下移');
  down.disabled = !opts.canDown;
  down.addEventListener('click', opts.down);

  const remove = makeIconBtn('✕', opts.removeLabel);
  remove.addEventListener('click', opts.remove);

  box.append(up, down, remove);
  return box;
}

/** 移动数组元素（上移 / 下移） */
function moveItem(list: unknown[], index: number, delta: number): boolean {
  const target = index + delta;
  if (target < 0 || target >= list.length) return false;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
  return true;
}

/* ============================================================
   6. 渲染：静态字段 / 简介段落 / 功能清单
   ============================================================ */

/** 静态字段（关于本站的小标题、开头一段、页尾致谢） */
function bindFields(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-ab-field]')) {
    if (el.dataset.abBound === '1') continue;
    el.dataset.abBound = '1';
    const path = el.dataset.abField as string;
    el.addEventListener('input', () => {
      setAt(config, path, (el as HTMLInputElement | HTMLTextAreaElement).value);
      markDirty();
    });
  }
}

function renderFields(): void {
  const root = rootEl();
  if (!root) return;
  for (const el of root.querySelectorAll<HTMLElement>('[data-ab-field]')) {
    const value = asString(getAt(config, el.dataset.abField as string));
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = value;
  }
}

/** 自我介绍：一段一行 */
function renderIntro(): void {
  const box = document.querySelector<HTMLElement>('[data-ab-intro]');
  if (!box) return;

  const list = introList();
  box.textContent = '';

  if (!list.length) {
    box.append(makeEmpty('还没有自我介绍，点下面「新增一段」加一行。'));
    return;
  }

  list.forEach((text, index) => {
    const row = document.createElement('div');
    row.className = 'ab-row';

    const order = document.createElement('span');
    order.className = 'ab-row__index';
    order.textContent = String(index + 1);
    order.title = `第 ${index + 1} 段`;

    const area = makeArea('一段自我介绍；想分段就拆到下一段', text, 3);
    area.classList.add('ab-row__area');
    area.setAttribute('aria-label', `第 ${index + 1} 段自我介绍`);
    area.addEventListener('input', () => {
      list[index] = area.value;
      markDirty();
    });

    const actions = rowActions({
      up: () => {
        if (moveItem(list, index, -1)) {
          markDirty();
          renderIntro();
        }
      },
      down: () => {
        if (moveItem(list, index, 1)) {
          markDirty();
          renderIntro();
        }
      },
      remove: () => {
        list.splice(index, 1);
        markDirty();
        renderIntro();
      },
      canUp: index > 0,
      canDown: index < list.length - 1,
      removeLabel: '删除这一段',
    });

    row.append(order, area, actions);
    box.append(row);
  });
}

/** 功能清单：分组 → 条目 */
function renderSections(): void {
  const box = document.querySelector<HTMLElement>('[data-ab-sections]');
  if (!box) return;

  const sections = sectionList();
  box.textContent = '';

  if (!sections.length) {
    box.append(makeEmpty('还没有分组，点下面「新增分组」开始（例如「核心特色」「功能亮点」）。'));
    return;
  }

  sections.forEach((section, sIndex) => {
    const card = document.createElement('div');
    card.className = 'ab-card';

    /* ---- 分组标题行 ---- */
    const head = document.createElement('div');
    head.className = 'ab-card__head';

    const badge = document.createElement('span');
    badge.className = 'ab-card__badge';
    badge.textContent = `分组 ${sIndex + 1}`;

    const titleInput = makeInput('分组名，如「核心特色」', asString(section.title));
    titleInput.classList.add('ab-card__title');
    titleInput.dataset.abSectionTitle = String(sIndex);
    titleInput.setAttribute('aria-label', `分组 ${sIndex + 1} 的名称`);
    titleInput.addEventListener('input', () => {
      section.title = titleInput.value;
      markDirty();
    });

    head.append(
      badge,
      titleInput,
      rowActions({
        up: () => {
          if (moveItem(sections, sIndex, -1)) {
            markDirty();
            renderSections();
          }
        },
        down: () => {
          if (moveItem(sections, sIndex, 1)) {
            markDirty();
            renderSections();
          }
        },
        remove: () => {
          sections.splice(sIndex, 1);
          markDirty();
          renderSections();
        },
        canUp: sIndex > 0,
        canDown: sIndex < sections.length - 1,
        removeLabel: '删除这个分组',
      }),
    );

    card.append(head);

    /* ---- 条目列表 ---- */
    const items = itemList(section);
    const listBox = document.createElement('div');
    listBox.className = 'ab-items';

    if (!items.length) listBox.append(makeEmpty('这一组还没有条目，点「新增一条」加一条。'));

    items.forEach((item, iIndex) => {
      const row = document.createElement('div');
      row.className = 'ab-item';

      const itemTitle = makeInput('名称，如「在线发布」', asString(item.title));
      itemTitle.classList.add('ab-item__title');
      itemTitle.dataset.abItemTitle = '1';
      itemTitle.dataset.abSection = String(sIndex);
      itemTitle.dataset.abItem = String(iIndex);
      itemTitle.setAttribute('aria-label', `分组 ${sIndex + 1} 第 ${iIndex + 1} 条的名称`);
      itemTitle.addEventListener('input', () => {
        item.title = itemTitle.value;
        markDirty();
      });

      const itemText = makeArea('说明，如「无需本地环境，浏览器里直接发布」', asString(item.text), 2);
      itemText.classList.add('ab-item__text');
      itemText.setAttribute('aria-label', `分组 ${sIndex + 1} 第 ${iIndex + 1} 条的说明`);
      itemText.addEventListener('input', () => {
        item.text = itemText.value;
        markDirty();
      });

      row.append(
        itemTitle,
        itemText,
        rowActions({
          up: () => {
            if (moveItem(items, iIndex, -1)) {
              markDirty();
              renderSections();
            }
          },
          down: () => {
            if (moveItem(items, iIndex, 1)) {
              markDirty();
              renderSections();
            }
          },
          remove: () => {
            items.splice(iIndex, 1);
            markDirty();
            renderSections();
          },
          canUp: iIndex > 0,
          canDown: iIndex < items.length - 1,
          removeLabel: '删除这一条',
        }),
      );

      listBox.append(row);
    });

    const addItem = document.createElement('button');
    addItem.type = 'button';
    addItem.className = 'btn-pill ab-add';
    addItem.dataset.abAddItem = String(sIndex);
    addItem.textContent = '＋ 新增一条';
    addItem.addEventListener('click', () => {
      items.push({ title: '', text: '' });
      markDirty();
      renderSections();
      focusItem(sIndex, items.length - 1);
    });

    card.append(listBox, addItem);
    box.append(card);
  });
}

/** 新增条目后把光标放进去，省得再点一下 */
function focusItem(section: number, item: number): void {
  document
    .querySelector<HTMLInputElement>(
      `[data-ab-item-title][data-ab-section="${section}"][data-ab-item="${item}"]`,
    )
    ?.focus();
}

/** 三个板块一起重画（读文件 / 改 JSON 之后调用） */
function renderAll(): void {
  renderFields();
  renderIntro();
  renderSections();
}

/* ============================================================
   7. JSON 源码板块
   ============================================================ */

function jsonEl(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-ab-json]');
}

function syncJsonText(): void {
  const el = jsonEl();
  if (!el) return;
  el.value = `${JSON.stringify(config, null, 2)}\n`;
  jsonDirty = false;
}

/**
 * 把 JSON 文本框里的内容解析回 config。
 * @param silent true 时不在界面上弹提示（边打字边试解析）
 */
function applyJson(silent = false): boolean {
  const el = jsonEl();
  if (!el) return true;

  try {
    const parsed: unknown = JSON.parse(el.value);
    if (!isObj(parsed)) {
      if (!silent) showToast('about.json 应该是一个 JSON 对象');
      return false;
    }
    config = normalize(parsed);
    jsonDirty = false;
    renderAll();
    return true;
  } catch (error) {
    if (!silent) {
      showToast(error instanceof Error ? `JSON 格式错误：${error.message}` : 'JSON 格式错误');
    }
    return false;
  }
}

function bindJsonBox(): void {
  const el = jsonEl();
  if (!el || el.dataset.bound === '1') return;
  el.dataset.bound = '1';
  el.addEventListener('input', () => {
    jsonDirty = true;
    if (applyJson(true)) setStatus('JSON 已更新，记得点「保存并提交」');
    else setStatus('JSON 有语法错误，先修好再保存');
  });
}

/* ============================================================
   8. 读 / 存
   ============================================================ */

async function loadAbout(): Promise<void> {
  if (!getEditSession()) return;
  setStatus('读取中…');

  try {
    const file = await getFile(aboutPath());
    if (!file) {
      // 明确知道仓库里没有这份文件：允许直接保存新建
      loadedOk = true;
      setStatus('仓库里没找到 config/about.json（保存会新建一个）');
      return;
    }

    fileSha = file.sha;

    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      showToast('仓库里的 about.json 解析失败，已停在 JSON 源码');
      const el = jsonEl();
      if (el) el.value = file.text;
      setStatus('配置文件有语法错误');
      return;
    }

    config = normalize(isObj(parsed) ? parsed : blank());
    jsonDirty = false;
    dirty = false;
    loadedOk = true;
    renderAll();
    syncJsonText();
    setStatus('已读取最新 About Me');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '读取失败');
  }
}

async function saveAbout(): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }

  // 还没把仓库里那份读下来：这时候表单是空的，直接保存会把真内容覆盖掉
  if (!loadedOk) {
    setStatus('先读取文件再保存');
    showToast('还没读到 config/about.json，先点「重新读取」');
    return;
  }

  // 什么都没改就别提交一个空 commit 了
  if (!dirty && !jsonDirty) {
    setStatus('没有改动');
    showToast('还没改内容，不用提交');
    return;
  }

  // JSON 板块有没同步的改动：先确保它合法
  if (jsonDirty && !applyJson(false)) {
    setStatus('JSON 格式不对，未提交');
    return;
  }

  const next = cleanForSave();
  const path = aboutPath();
  setStatus('提交中…');

  try {
    const latest = await getFile(path);
    await putFile(
      path,
      `${JSON.stringify(next, null, 2)}\n`,
      'about: 可视化编辑 about.json',
      latest?.sha ?? fileSha,
    );
    fileSha = latest?.sha ?? fileSha;
    config = next;
    dirty = false;
    renderAll();
    syncJsonText();
    setStatus('已提交，等自动部署完成后生效');
    showToast('About Me 已提交，约 1 分钟后生效');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '保存失败');
  }
}

/* ============================================================
   9. 入口
   ============================================================ */

function initAbout(): void {
  const root = rootEl();
  if (!root) return;

  // 换页回来是全新一页：先把上一页留下的状态清掉
  config = blank();
  fileSha = undefined;
  jsonDirty = false;
  dirty = false;
  loadedOk = false;

  renderGate();
  bindFields(root);
  bindJsonBox();
  renderAll();
  syncJsonText();

  if (getEditSession()) void loadAbout();
}

onPageLoad(initAbout);

/* 授权 / 退出 / 保存 / 增删：用事件委托，换页（ClientRouter 换 DOM）后依然有效 */
document.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('[data-ab-login]')) {
      openEditLogin()
        .then(() => {
          showToast('写作授权成功');
          renderGate();
          void loadAbout();
        })
        .catch((error: unknown) => {
          showToast(error instanceof Error ? error.message : '授权失败');
        });
      return;
    }

    if (target.closest('[data-ab-logout]')) {
      clearEditSession();
      renderGate();
      showToast('已退出写作授权');
      return;
    }

    if (target.closest('[data-ab-reload]')) {
      if (dirty && !window.confirm('有未保存的改动，确定重新读取吗？')) return;
      void loadAbout();
      return;
    }

    if (target.closest('[data-ab-save]')) {
      void saveAbout();
      return;
    }

    if (target.closest('[data-ab-add-intro]')) {
      const list = introList();
      list.push('');
      markDirty();
      renderIntro();
      const rows = document.querySelectorAll<HTMLTextAreaElement>('[data-ab-intro] .ab-row__area');
      rows[rows.length - 1]?.focus();
      return;
    }

    if (target.closest('[data-ab-add-section]')) {
      const sections = sectionList();
      sections.push({ title: '', items: [] });
      markDirty();
      renderSections();
      document
        .querySelector<HTMLInputElement>(`[data-ab-section-title="${sections.length - 1}"]`)
        ?.focus();
      return;
    }

    if (target.closest('[data-ab-json-format]')) {
      if (!applyJson(false)) return;
      syncJsonText();
      setStatus('已格式化');
      return;
    }

    if (target.closest('[data-ab-json-validate]')) {
      if (applyJson(false)) setStatus('格式正确');
    }
  },
  true,
);
