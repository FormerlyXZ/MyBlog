/**
 * /config 页面逻辑（可视化编辑 + JSON 源码）
 * ============================================================
 * 数据流是单向的：
 *
 *   repo 里的 config/site.json
 *        ↓ 读取（getFile）
 *   内存里的 config 对象   ←→  页面上的控件（data-cfg / 数组编辑器）
 *        ↓ 校验 + 保存（putFile，一次 commit）
 *   repo 里的 config/site.json（等自动部署）
 *
 * 约定：
 *   · 每个字段控件上写的是 config 里的**点路径**，如 site.title、site.banner.interval
 *   · 数组（社交媒体 / banner 图片）由专门的渲染函数生成行，改动直接写回原数组
 *   · JSON 源码板块是同一份数据的另一种视图：改那边等于整份替换 config
 *   · 图片上传是单独的 commit（先提交图片，再把路径写回 config）
 */

import { onPageLoad } from './pageload';
import { clearEditSession, getEditSession, openEditLogin, showToast } from '../utils/site';
import { getFile, putBinary, putFile } from '../utils/github';

type Json = Record<string, unknown>;

const CONFIG_PATH_DEFAULT = 'config/site.json';

/** 内存里的完整配置（保留 JSON 里所有未知字段，不做裁剪） */
let config: Json = {};
/** 最近一次读到的文件 sha（提交时要用） */
let fileSha: string | undefined;
/** JSON 源码板块里有没有未同步进 config 的改动 */
let jsonDirty = false;

/* ============================================================
   1. 路径读写 / 类型小工具
   ============================================================ */

function getAt(source: Json, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (current && typeof current === 'object' && !Array.isArray(current) && key in current) {
      current = (current as Json)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAt(target: Json, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Json = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i] as string;
    const next = current[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) current[key] = {};
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
   2. 界面开关：授权前 / 授权后
   ============================================================ */

function rootEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-config-root]');
}

function configPath(): string {
  return rootEl()?.dataset.configPath ?? CONFIG_PATH_DEFAULT;
}

function setStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-config-status]');
  if (el) el.textContent = text;
}

function markDirty(): void {
  setStatus('有未保存的改动，记得点「保存并提交」');
}

function renderGate(): void {
  const authed = Boolean(getEditSession());
  const gate = document.querySelector<HTMLElement>('[data-config-gate]');
  const form = document.querySelector<HTMLElement>('[data-config-form]');
  const logoutBtn = document.querySelector<HTMLElement>('[data-edit-logout]');

  if (gate) gate.hidden = authed;
  if (form) {
    form.hidden = !authed;
    form.classList.toggle('hidden', !authed);
    form.classList.toggle('flex', authed);
  }
  if (logoutBtn) logoutBtn.hidden = !authed;
}

/* ============================================================
   3. 把 config 渲染进控件 / 从控件写回 config
   ============================================================ */

/** 输入框两侧的值同步（文本 / 数字 / 开关 / 多行数组） */
function bindFields(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-cfg]')) {
    if (el.dataset.cfgBound === '1') continue;
    el.dataset.cfgBound = '1';
    const path = el.dataset.cfg as string;
    const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    input.addEventListener('input', () => {
      setAt(config, path, input.value);
      markDirty();
    });
  }

  for (const el of root.querySelectorAll<HTMLInputElement>('[data-cfg-number]')) {
    if (el.dataset.cfgBound === '1') continue;
    el.dataset.cfgBound = '1';
    const path = el.dataset.cfgNumber as string;
    el.addEventListener('input', () => {
      const raw = el.value.trim();
      setAt(config, path, raw === '' ? 0 : Number(raw));
      if (el.hasAttribute('data-cfg-range')) syncRangeOutput(el);
      markDirty();
    });
  }

  for (const el of root.querySelectorAll<HTMLInputElement>('[data-cfg-check]')) {
    if (el.dataset.cfgBound === '1') continue;
    el.dataset.cfgBound = '1';
    const path = el.dataset.cfgCheck as string;
    el.addEventListener('change', () => {
      setAt(config, path, el.checked);
      markDirty();
    });
  }

  for (const el of root.querySelectorAll<HTMLTextAreaElement>('[data-cfg-lines]')) {
    if (el.dataset.cfgBound === '1') continue;
    el.dataset.cfgBound = '1';
    const path = el.dataset.cfgLines as string;
    el.addEventListener('input', () => {
      const lines = el.value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      setAt(config, path, lines);
      markDirty();
    });
  }
}

/** 把 config 里的值写回控件（读仓库配置后 / 改了 JSON 后调用） */
function renderFields(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-cfg]')) {
    const path = el.dataset.cfg as string;
    const value = asString(getAt(config, path));
    if (el instanceof HTMLSelectElement) {
      if ([...el.options].some((option) => option.value === value)) el.value = value;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = value;
    }
  }

  for (const el of root.querySelectorAll<HTMLInputElement>('[data-cfg-number]')) {
    const value = getAt(config, el.dataset.cfgNumber as string);
    el.value = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
    if (el.hasAttribute('data-cfg-range')) syncRangeOutput(el);
  }

  for (const el of root.querySelectorAll<HTMLInputElement>('[data-cfg-check]')) {
    el.checked = Boolean(getAt(config, el.dataset.cfgCheck as string));
  }

  for (const el of root.querySelectorAll<HTMLTextAreaElement>('[data-cfg-lines]')) {
    el.value = asArray(getAt(config, el.dataset.cfgLines as string)).map((line) => asString(line)).join('\n');
  }

  for (const wrap of root.querySelectorAll<HTMLElement>('[data-cfg-image]')) {
    const preview = wrap.querySelector<HTMLImageElement>('[data-cfg-image-preview]');
    const value = asString(getAt(config, wrap.dataset.cfgImage as string));
    if (preview && value) preview.src = value;
  }
}

/* ============================================================
   4. 数组编辑器：社交媒体 / Banner 图片
   ============================================================ */

/** 滑杆字段右侧的数值显示（<output>）跟着滑条同步 */
function syncRangeOutput(input: HTMLInputElement): void {
  const out = input.closest('.config-range')?.querySelector<HTMLOutputElement>('[data-cfg-range-output]');
  if (out) out.textContent = input.value;
}

function makeInput(placeholder: string, value: string): HTMLInputElement {  const input = document.createElement('input');
  input.className = 'input-pill';
  input.placeholder = placeholder;
  input.value = value;
  return input;
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

/** 移动数组元素（上移 / 下移） */
function moveItem(list: unknown[], index: number, delta: number): boolean {
  const target = index + delta;
  if (target < 0 || target >= list.length) return false;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
  return true;
}

/** 社交媒体列表 */
function renderSocial(): void {
  const box = document.querySelector<HTMLElement>('[data-cfg-social]');
  if (!box) return;

  const list = asArray(getAt(config, 'user.social'));
  box.textContent = '';

  if (!list.length) {
    box.append(makeEmpty('还没有社交链接，点下面「新增一个」开始。'));
    return;
  }

  list.forEach((raw, index) => {
    // 容错：手写 JSON 时可能只写了字符串，这里统一成对象
    const item: Json =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Json) : { href: asString(raw) };
    list[index] = item;

    const row = document.createElement('div');
    row.className = 'config-social-row';

    const labelInput = makeInput('名称（悬停提示）', asString(item.label));
    const iconInput = makeInput('图标名，如 ri:github-line', asString(item.icon, 'ri:link'));
    const hrefInput = makeInput('链接地址 https://…', asString(item.href));

    labelInput.addEventListener('input', () => {
      item.label = labelInput.value;
      markDirty();
    });
    iconInput.addEventListener('input', () => {
      item.icon = iconInput.value;
      markDirty();
    });
    hrefInput.addEventListener('input', () => {
      item.href = hrefInput.value;
      markDirty();
    });

    const actions = document.createElement('div');
    actions.className = 'config-row-actions';

    const up = makeIconBtn('↑', '上移');
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      if (moveItem(list, index, -1)) {
        markDirty();
        renderSocial();
      }
    });

    const down = makeIconBtn('↓', '下移');
    down.disabled = index === list.length - 1;
    down.addEventListener('click', () => {
      if (moveItem(list, index, 1)) {
        markDirty();
        renderSocial();
      }
    });

    const remove = makeIconBtn('✕', '删除这一条');
    remove.addEventListener('click', () => {
      list.splice(index, 1);
      markDirty();
      renderSocial();
    });

    actions.append(up, down, remove);
    row.append(labelInput, iconInput, hrefInput, actions);
    box.append(row);
  });
}

/** Banner 图片列表（顺序 = 轮播顺序） */
function renderBannerImages(): void {
  const box = document.querySelector<HTMLElement>('[data-cfg-banner-images]');
  if (!box) return;

  const list = asArray(getAt(config, 'site.banner.images'));
  box.textContent = '';

  if (!list.length) {
    box.append(makeEmpty('还没有横幅图片，上传一张开始（没图时会回落到默认图）。'));
    return;
  }

  list.forEach((raw, index) => {
    const row = document.createElement('div');
    row.className = 'config-banner-row';

    const order = document.createElement('span');
    order.className = 'config-banner-row__index';
    order.textContent = String(index + 1);
    order.title = `第 ${index + 1} 张`;

    const thumb = document.createElement('img');
    thumb.className = 'config-banner-row__thumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.src = asString(raw);

    const pathInput = makeInput('图片路径，如 /banner/xxx.jpg', asString(raw));
    pathInput.classList.add('config-banner-row__path');
    pathInput.addEventListener('input', () => {
      list[index] = pathInput.value;
      thumb.src = pathInput.value;
      markDirty();
    });

    const actions = document.createElement('div');
    actions.className = 'config-row-actions';

    const up = makeIconBtn('↑', '往前挪');
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      if (moveItem(list, index, -1)) {
        markDirty();
        renderBannerImages();
      }
    });

    const down = makeIconBtn('↓', '往后挪');
    down.disabled = index === list.length - 1;
    down.addEventListener('click', () => {
      if (moveItem(list, index, 1)) {
        markDirty();
        renderBannerImages();
      }
    });

    const remove = makeIconBtn('✕', '删除这张');
    remove.addEventListener('click', () => {
      list.splice(index, 1);
      markDirty();
      renderBannerImages();
    });

    actions.append(up, down, remove);
    row.append(order, thumb, pathInput, actions);
    box.append(row);
  });
}

/** 所有数组编辑器 + 字段一起重画 */
function renderAll(): void {
  const root = rootEl();
  if (!root) return;
  renderFields(root);
  renderSocial();
  renderBannerImages();
}

/* ============================================================
   5. 图片上传（头像 / logo / favicon / banner）
   ============================================================ */

/** 把文件丢进仓库指定目录，返回站内绝对路径（/banner/xxx.jpg） */
async function uploadImage(file: File, dir: string): Promise<string> {
  const buffer = await file.arrayBuffer();
  const safeName = file.name.replace(/[^\w.-]+/g, '-');
  const path = `${dir}/${Date.now()}-${safeName}`;
  await putBinary(path, buffer, `asset: ${file.name}`);
  return `/${path.replace(/^public\//, '')}`;
}

function bindImageFields(root: HTMLElement): void {
  for (const wrap of root.querySelectorAll<HTMLElement>('[data-cfg-image]')) {
    if (wrap.dataset.imageBound === '1') continue;
    wrap.dataset.imageBound = '1';

    const path = wrap.dataset.cfgImage as string;
    const dir = wrap.dataset.uploadDir || 'public';
    const input = wrap.querySelector<HTMLInputElement>('[data-cfg]');
    const preview = wrap.querySelector<HTMLImageElement>('[data-cfg-image-preview]');
    const pickBtn = wrap.querySelector<HTMLElement>('[data-cfg-image-pick]');
    const fileInput = wrap.querySelector<HTMLInputElement>('[data-cfg-image-input]');
    if (!input || !fileInput) continue;

    pickBtn?.addEventListener('click', () => fileInput.click());

    // 手改路径时预览跟着变
    input.addEventListener('input', () => {
      if (preview && input.value) preview.src = input.value;
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (!getEditSession()) {
        showToast('请先授权');
        return;
      }

      setStatus('图片上传中…');
      try {
        const url = await uploadImage(file, dir);
        setAt(config, path, url);
        input.value = url;
        if (preview) preview.src = url;
        markDirty();
        showToast('图片已上传，别忘了点「保存并提交」');
      } catch (error) {
        setStatus('');
        showToast(error instanceof Error ? error.message : '上传失败');
      }
    });
  }
}

function bindBannerUpload(): void {
  const trigger = document.querySelector<HTMLElement>('[data-banner-upload]');
  const fileInput = document.querySelector<HTMLInputElement>('[data-banner-upload-input]');
  const addBtn = document.querySelector<HTMLElement>('[data-banner-add-path]');
  const newPath = document.querySelector<HTMLInputElement>('[data-banner-new-path]');

  if (trigger && fileInput && trigger.dataset.bound !== '1') {
    trigger.dataset.bound = '1';
    trigger.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = '';
      if (!files.length) return;
      if (!getEditSession()) {
        showToast('请先授权');
        return;
      }

      const images = asArray(getAt(config, 'site.banner.images'));
      setAt(config, 'site.banner.images', images);

      setStatus(`上传中… 0 / ${files.length}`);
      let done = 0;
      try {
        for (const file of files) {
          const url = await uploadImage(file, 'public/banner');
          images.push(url);
          done += 1;
          setStatus(`上传中… ${done} / ${files.length}`);
        }
        markDirty();
        renderBannerImages();
        showToast(`已上传 ${done} 张，别忘了点「保存并提交」`);
      } catch (error) {
        setStatus('');
        renderBannerImages();
        showToast(error instanceof Error ? error.message : '上传失败');
      }
    });
  }

  if (addBtn && newPath && addBtn.dataset.bound !== '1') {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => {
      const value = newPath.value.trim();
      if (!value) {
        showToast('先填一个图片路径');
        newPath.focus();
        return;
      }
      const images = asArray(getAt(config, 'site.banner.images'));
      setAt(config, 'site.banner.images', images);
      images.push(value);
      newPath.value = '';
      markDirty();
      renderBannerImages();
    });
  }
}

/** 社交媒体「新增一个」 */
function bindSocialAdd(): void {
  const btn = document.querySelector<HTMLElement>('[data-social-add]');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    const list = asArray(getAt(config, 'user.social'));
    setAt(config, 'user.social', list);
    list.push({ label: '', href: '', icon: 'ri:link' });
    markDirty();
    renderSocial();
  });
}

/* ============================================================
   6. 板块切换
   ============================================================ */

function showPanel(id: string): void {
  for (const tab of document.querySelectorAll<HTMLElement>('[data-config-tab]')) {
    const active = tab.dataset.configTab === id;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-config-panel]')) {
    panel.hidden = panel.dataset.configPanel !== id;
  }
  // 进 JSON 板块时把当前内存状态序列化过去，免得看到旧内容；
  // 但如果用户正在那边改、还没改对（jsonDirty），就别把他的文本冲掉
  if (id === 'json' && !jsonDirty) syncJsonText();
}

function bindTabs(): void {
  for (const tab of document.querySelectorAll<HTMLElement>('[data-config-tab]')) {
    if (tab.dataset.bound === '1') continue;
    tab.dataset.bound = '1';
    tab.addEventListener('click', () => {
      // 离开 JSON 板块前，把能解析的改动并回 config
      if (jsonDirty) syncFromJson(true);
      const id = tab.dataset.configTab;
      if (id) showPanel(id);
    });
  }
}

/* ============================================================
   7. JSON 源码板块
   ============================================================ */

function jsonEl(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-config-text]');
}

function syncJsonText(): void {
  const el = jsonEl();
  if (!el) return;
  el.value = `${JSON.stringify(config, null, 2)}\n`;
  jsonDirty = false;
}

/**
 * 把 JSON 文本框里的内容解析回 config。
 * @param silent true 时不在界面上弹提示（切换板块时静默尝试）
 */
function syncFromJson(silent = false): boolean {
  const el = jsonEl();
  if (!el) return true;
  try {
    const parsed: unknown = JSON.parse(el.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (!silent) showToast('配置应该是一个 JSON 对象');
      return false;
    }
    config = parsed as Json;
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
    // 能解析就实时同步到可视化板块（解析不了就等用户修好）
    if (syncFromJson(true)) setStatus('JSON 已更新，记得点「保存并提交」');
    else setStatus('JSON 有语法错误，先修好再保存');
  });
}

/* ============================================================
   8. 读 / 存
   ============================================================ */

async function loadConfig(): Promise<void> {
  if (!getEditSession()) return;
  setStatus('读取中…');
  try {
    const file = await getFile(configPath());
    if (!file) {
      setStatus('仓库里没找到配置文件');
      return;
    }
    fileSha = file.sha;
    try {
      const parsed: unknown = JSON.parse(file.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Json;
      }
    } catch {
      showToast('仓库里的 site.json 解析失败，已停在 JSON 板块');
      const el = jsonEl();
      if (el) el.value = file.text;
      showPanel('json');
      setStatus('配置文件有语法错误');
      return;
    }
    jsonDirty = false;
    renderAll();
    bindFields(rootEl() as HTMLElement);
    bindImageFields(rootEl() as HTMLElement);
    syncJsonText();
    setStatus('已读取最新配置');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '读取失败');
  }
}

async function saveConfig(): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }

  // JSON 板块有未同步的改动：先确保它合法
  if (jsonDirty && !syncFromJson(false)) {
    setStatus('JSON 格式不对，未提交');
    return;
  }

  const title = asString(getAt(config, 'site.title')).trim();
  if (!title) {
    showToast('网站名不能为空');
    showPanel('site');
    return;
  }

  const path = configPath();
  setStatus('提交中…');
  try {
    const latest = await getFile(path);
    await putFile(
      path,
      `${JSON.stringify(config, null, 2)}\n`,
      'config: 可视化编辑 site.json',
      latest?.sha ?? fileSha,
    );
    fileSha = latest?.sha ?? fileSha;
    syncJsonText();
    setStatus('已提交，等自动部署完成后生效');
    showToast('配置已提交，约 1 分钟后生效');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '保存失败');
  }
}

/* ============================================================
   9. 事件绑定 / 入口
   ============================================================ */

function initConfig(): void {
  const root = rootEl();
  if (!root) return;

  renderGate();
  bindTabs();
  bindFields(root);
  bindImageFields(root);
  bindBannerUpload();
  bindSocialAdd();
  bindJsonBox();
  renderSocial();
  renderBannerImages();

  if (getEditSession()) {
    void loadConfig();
  }
}

onPageLoad(() => {
  initConfig();
});

/* 授权 / 退出 / 保存 / 校验：用事件委托，换页（ClientRouter 换 DOM）后依然有效 */
document.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('[data-edit-login]')) {
      openEditLogin()
        .then(() => {
          showToast('写作授权成功');
          renderGate();
          void loadConfig();
        })
        .catch((error: unknown) => {
          showToast(error instanceof Error ? error.message : '授权失败');
        });
      return;
    }

    if (target.closest('[data-edit-logout]')) {
      clearEditSession();
      renderGate();
      showToast('已退出写作授权');
      return;
    }

    if (target.closest('[data-config-reload]')) {
      if (jsonDirty && !window.confirm('有未同步的 JSON 改动，确定重新读取吗？')) return;
      void loadConfig();
      return;
    }

    if (target.closest('[data-config-save]')) {
      void saveConfig();
      return;
    }

    if (target.closest('[data-config-format]')) {
      if (!syncFromJson(false)) return;
      syncJsonText();
      setStatus('已格式化');
      return;
    }

    if (target.closest('[data-config-validate]')) {
      if (syncFromJson(false)) setStatus('格式正确');
    }
  },
  true,
);
