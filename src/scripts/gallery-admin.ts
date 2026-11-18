/**
 * 照片墙管理（/config → 照片墙 面板）
 * ============================================================
 * 一份文件管完整件事：config/gallery.json
 *   { settings: {...}, railTags: [...], photos: [ { id, src, w, h, title?, tags? } ] }
 *
 * 能做的事：
 *   · 批量上传本地图片（浏览器里压成 WebP 直接进图床 gallery/，一个字节都不进仓库）
 *   · 从图床里挑已有的图（复用 /config 里那个媒体库弹窗）
 *   · 上传前先勾「新照片标签」，进来就带着分类（勾选记本机，下次还在）
 *   · 拖拽排序（顺序就是照片海的流动顺序）、单张删除、批量删除
 *   · 把照片直接拖到右侧标签篮的标签上 = 加标签；点标签 = 网格只看它
 *   · 批量打标签 / 批量去标签；单张改标题、单独加删标签
 *   · 展示分类：左侧分类栏只列挑中的那几个标签（railTags；空 = 全部）
 *   · 排版参数（列宽 / 间隙 / 画布比例 / 圆角 / 放大占比 / 周围缩小 / 变暗）实时可调
 *   · 「保存并提交」= 一次 GitHub commit，1 分钟后生效
 *
 * 几个实现上的取舍：
 *   · 图片一律进图床（Cloudflare R2 的 gallery/），JSON 里只留 URL ——
 *     照片几百张时，进仓库会让每次构建都变慢（原方案的 R10 风险）。
 *     想用仓库内路径或外链也行，直接往 JSON 里填（src 字段三种写法都认）。
 *   · 删除照片只从 JSON 里摘掉；图床上的文件在**提交成功之后**才删
 *     （提交失败还能改，先删文件就没得救了）。
 *   · 排序用原生 HTML5 拖放：管理面板只在桌面用，不值得为它写一套指针拖拽。
 *   · 同一个拖放还兼做「打标」：落在卡片上 = 改顺序，落在右侧标签篮的标签上 = 加标签。
 *     两者用落点区分，不额外发明手势；拖的那张如果已被勾选，则勾选的那几张一起加。
 *   · 展示分类（railTags）存的是「白名单」而不是「黑名单」：空数组 = 全部展示，
 *     和「还没调过」的语义一致，以后新加的标签也不会被静默藏起来。
 * ============================================================
 */

import { onPageLoad } from './pageload';
import { ApiError, clearEditSession, getEditSession, onEditAuthChange, showToast } from '../utils/site';
import { commitFiles, getFile } from '../utils/github';
import { deleteMedia, mediaKeyFromUrl, uploadImage } from '../utils/media';
import { openMediaDialog } from './media-dialog';
import { registerPanelWriter } from './panel-save';
import {
  DEFAULT_SETTINGS,
  GALLERY_PATH,
  RATIO_KEYS,
  SETTING_RANGE,
  aspectOf,
  newPhotoId,
  normalizePhoto,
  normalizeRailTags,
  normalizeSettings,
  normalizeTagNames,
  tagList,
  type GalleryPhoto,
  type GallerySettings,
} from '../utils/gallery-shared';

/** 「新照片标签」的勾选记在这儿（只影响本机的上传流程，不进仓库） */
const UPLOAD_TAGS_KEY = 'melodyxz-galg-upload-tags';

/** 新文件默认带上的说明（保留文件里原有的 _说明 字段） */
const DEFAULT_NOTE =
  '照片墙数据。photos 是扁平图池，每张照片靠 tags 分类；顺序 = 数组顺序（排版从左到右、从上到下流动）。railTags 是左侧分类栏展示哪些标签（空/缺省 = 全部）。在 /config → 照片墙 里可视化编辑，也可直接改这个文件。src 支持图床地址、仓库内路径（/image/gallery/...）或任意外链；w/h 是照片像素尺寸，排版按它算宽高比。';

interface State {
  settings: GallerySettings;
  /** 左侧分类栏展示哪些标签；空 = 全部（见 gallery-shared.ts） */
  railTags: string[];
  /** 上传时给新照片自动打的标签（本机偏好，存 localStorage） */
  uploadTags: string[];
  /** 网格的临时筛选（只在面板里生效，不写进仓库） */
  tagFilter: string | null;
  /** 标签篮里打开着「⋯」菜单的那个标签（同一时刻只开一个） */
  menuTag: string | null;
  photos: GalleryPhoto[];
  picked: Set<string>;
  note: string;
  sha: string | undefined;
  dirty: boolean;
  busy: boolean;
  /** 提交成功之后要删掉的图床 key */
  trash: Set<string>;
}

const state: State = {
  settings: { ...DEFAULT_SETTINGS },
  railTags: [],
  uploadTags: [],
  tagFilter: null,
  menuTag: null,
  photos: [],
  picked: new Set(),
  note: DEFAULT_NOTE,
  sha: undefined,
  dirty: false,
  busy: false,
  trash: new Set(),
};

/* ------------------------------------------------------------------ */
/* DOM 小工具                                                          */
/* ------------------------------------------------------------------ */

function root(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-galg-admin]');
}

function q<T extends HTMLElement>(selector: string): T | null {
  return root()?.querySelector<T>(selector) ?? null;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(text: string, kind: 'idle' | 'busy' | 'saved' | 'error' = 'idle'): void {
  const el = q<HTMLElement>('[data-galg-status]');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function markDirty(): void {
  state.dirty = true;
  setStatus('有未保存的改动', 'idle');
  const saveBtn = q<HTMLElement>('[data-galg-save]');
  if (saveBtn) saveBtn.classList.add('is-dirty');
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function buildCard(photo: GalleryPhoto, index: number): HTMLElement {
  const card = document.createElement('article');
  card.className = 'galg-card';
  card.dataset.galgCard = '';
  card.dataset.id = photo.id;
  card.draggable = true;

  const tags = (photo.tags ?? [])
    .map(
      (tag) =>
        `<button type="button" class="galg-tag" data-galg-tagrm="${esc(tag)}" title="移除标签 ${esc(tag)}">${esc(tag)}<span aria-hidden="true">✕</span></button>`,
    )
    .join('');

  const ratio = aspectOf(photo);

  card.innerHTML = `
    <div class="galg-thumb" style="--galg-ratio: ${ratio}">
      <img src="${esc(photo.src)}" alt="" loading="lazy" decoding="async" draggable="false" />
      <label class="galg-pick" title="选中这张">
        <input type="checkbox" data-galg-pick ${state.picked.has(photo.id) ? 'checked' : ''} />
      </label>
      <button type="button" class="galg-remove" data-galg-remove title="删除这张（保存后生效）">✕</button>
      <span class="galg-order">${index + 1}</span>
    </div>
    <input class="galg-title" data-galg-title value="${esc(photo.title ?? '')}" placeholder="标题（可留空）" />
    <div class="galg-tags">
      ${tags}
      <input class="galg-tag-new" data-galg-tagnew placeholder="+ 标签" size="4" />
    </div>
  `;
  return card;
}

function renderSettings(): void {
  for (const key of Object.keys(SETTING_RANGE) as Array<keyof GallerySettings>) {
    const input = q<HTMLInputElement>(`[data-galg-setting="${key}"]`);
    const out = q<HTMLElement>(`[data-galg-out="${key}"]`);
    const value = state.settings[key];
    if (input) input.value = String(value);
    if (out) out.textContent = formatSetting(key, value);
  }
}

function formatSetting(key: keyof GallerySettings, value: number): string {
  if (RATIO_KEYS.has(key)) {
    return `${Math.round(value * 100) / 100}`;
  }
  return `${Math.round(value)} px`;
}

function renderGrid(): void {
  const grid = q<HTMLElement>('[data-galg-grid]');
  if (!grid) return;

  // 筛选的标签可能已经被摘光了，先自愈
  if (state.tagFilter && !state.photos.some((photo) => (photo.tags ?? []).includes(state.tagFilter!))) {
    state.tagFilter = null;
  }

  const visible = visiblePhotos();
  grid.textContent = '';
  if (!state.photos.length) {
    grid.innerHTML = '<p class="galg-empty">还没有照片。点上面的「上传图片」或「从图床选」。</p>';
  } else {
    const frag = document.createDocumentFragment();
    // 顺序不能变：commitOrder 靠 DOM 顺序还原数组顺序，所以被筛掉的卡片只是 hidden，不摘掉
    state.photos.forEach((photo, index) => {
      const card = buildCard(photo, index);
      if (!matchesFilter(photo)) card.hidden = true;
      frag.append(card);
    });
    grid.append(frag);
  }

  const count = q<HTMLElement>('[data-galg-count]');
  if (count) {
    const tags = tagList(state.photos).length;
    count.textContent = state.tagFilter
      ? `${visible.length} / ${state.photos.length} 张 · 只看「${state.tagFilter}」`
      : `${state.photos.length} 张 · ${tags} 个标签`;
  }
  renderUploadTags();
  renderBasket();
  renderPicked();
}

/** 当前筛选下应该显示的照片 */
function visiblePhotos(): GalleryPhoto[] {
  return state.photos.filter(matchesFilter);
}

function matchesFilter(photo: GalleryPhoto): boolean {
  return !state.tagFilter || (photo.tags ?? []).includes(state.tagFilter);
}

/**
 * 「新照片标签」：一排可勾的胶囊，勾上之后上传 / 从图床选进来的照片直接带上。
 * 勾选只活在本机（localStorage），不写进仓库 —— 它描述的是「这次要传什么」，
 * 不是照片墙的数据。
 */
function renderUploadTags(): void {
  const box = q<HTMLElement>('[data-galg-upload-tags]');
  if (!box) return;

  const counts = new Map(tagList(state.photos).map((item) => [item.tag, item.count]));
  box.textContent = '';

  const names = knownTagNames();
  if (!names.length) {
    const tip = document.createElement('span');
    tip.className = 'galg-tip';
    tip.textContent = '还没有标签：在右边输入框里打一个，回车即建';
    box.append(tip);
  } else {
    const frag = document.createDocumentFragment();
    for (const name of names) {
      const on = state.uploadTags.includes(name);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'galg-upload-tag';
      chip.dataset.galgUploadTag = name;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', String(on));
      chip.title = on ? `上传时不再自动打「${name}」` : `上传时自动打上「${name}」`;
      chip.innerHTML = `<span>${esc(name)}</span><b>${counts.get(name) ?? 0}</b>`;
      frag.append(chip);
    }
    box.append(frag);
  }

  const hint = q<HTMLElement>('[data-galg-upload-hint]');
  if (hint) {
    hint.textContent = state.uploadTags.length
      ? `接着传的照片会带上：${state.uploadTags.join('、')}`
      : '没勾标签：新照片不带标签（勾了就自动打上，记在本机）';
  }
}

/** 已知标签名：照片上的 ∪ 当前勾着但还没照片的（新建的空标签） */
function knownTagNames(): string[] {
  const names = tagList(state.photos).map((item) => item.tag);
  for (const tag of state.uploadTags) if (!names.includes(tag)) names.push(tag);
  return names;
}

function toggleUploadTag(name: string): void {
  const tag = name.trim();
  if (!tag) return;
  state.uploadTags = state.uploadTags.includes(tag)
    ? state.uploadTags.filter((item) => item !== tag)
    : [...state.uploadTags, tag];
  saveUploadTags();
  renderUploadTags();
}

function saveUploadTags(): void {
  try {
    localStorage.setItem(UPLOAD_TAGS_KEY, JSON.stringify(state.uploadTags));
  } catch {
    /* 隐私模式下写不进去就算了 */
  }
}

function loadUploadTags(): void {
  try {
    const raw = localStorage.getItem(UPLOAD_TAGS_KEY);
    state.uploadTags = normalizeTagNames(raw ? JSON.parse(raw) : null);
  } catch {
    state.uploadTags = [];
  }
}

/** 眼睛图标（Material Symbols 的眼睛 / 划掉的眼睛，内联省一次图标请求） */
const EYE_ON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5S21.3 16.4 23 12c-1.7-4.4-6-7.5-11-7.5Zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7ZM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27ZM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53a5 5 0 0 1-5-5c0-.79.2-1.53.53-2.2Zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3l-.17.01Z"/></svg>';

/**
 * 右侧标签篮：一行一个标签（最上面是「全部」）。
 *   点名字     → 网格只看这个标签
 *   拖照片到行 → 给照片加上这个标签
 *   眼睛       → 相册页左侧抽屉列不列这个分类（写 railTags）
 *   ⋯          → 重命名 / 合并到别的标签 / 删除这个标签
 */
function renderBasket(): void {
  const list = q<HTMLElement>('[data-galg-basket-list]');
  if (!list) return;

  const all = tagList(state.photos);
  if (state.tagFilter && !all.some((item) => item.tag === state.tagFilter)) state.tagFilter = null;
  if (state.menuTag && !all.some((item) => item.tag === state.menuTag)) state.menuTag = null;

  list.textContent = '';
  if (!all.length) {
    const tip = document.createElement('span');
    tip.className = 'galg-tip';
    tip.textContent = '照片还没有标签。在卡片里输入标签再回车，标签就会出现在这儿。';
    list.append(tip);
  } else {
    const frag = document.createDocumentFragment();
    frag.append(basketRow('', '全部', state.photos.length));
    for (const item of all) frag.append(basketRow(item.tag, item.tag, item.count));
    list.append(frag);
  }

  const count = q<HTMLElement>('[data-galg-basket-count]');
  if (count) {
    const shown = state.railTags.length
      ? all.filter((item) => state.railTags.includes(item.tag)).length
      : all.length;
    count.textContent = all.length ? `${all.length} 个标签 · 左侧栏 ${shown}` : '';
  }

  const showAllBtn = q<HTMLElement>('[data-galg-rail-all]');
  if (showAllBtn) showAllBtn.hidden = !all.length || !state.railTags.length;
}

function basketRow(tag: string, label: string, n: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'galg-basket__row';
  row.dataset.galgBasketRow = tag;
  row.dataset.tag = tag;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'galg-basket__item';
  main.dataset.galgBasketTag = tag;
  const active = (state.tagFilter ?? '') === tag;
  main.classList.toggle('is-active', active);
  main.setAttribute('aria-pressed', String(active));
  main.title = tag ? `点一下只看「${tag}」，再点取消；照片可以拖到这一行` : '点一下回到全部照片';
  main.innerHTML = `<span>${esc(label)}</span><b>${n}</b>`;
  row.append(main);

  // 「全部」只是取消筛选的入口，没有眼睛和 ⋯
  if (!tag) return row;

  const eyed = !state.railTags.length || state.railTags.includes(tag);
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'galg-basket__eye';
  eye.dataset.galgRailTag = tag;
  eye.classList.toggle('is-on', eyed);
  eye.setAttribute('aria-pressed', String(eyed));
  eye.title = eyed
    ? `相册左侧栏不显示「${tag}」`
    : `相册左侧栏显示「${tag}」`;
  eye.setAttribute('aria-label', eye.title);
  eye.innerHTML = eyed ? EYE_ON : EYE_OFF;
  row.append(eye);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'galg-basket__more';
  more.dataset.galgBasketMore = tag;
  more.setAttribute('aria-expanded', String(state.menuTag === tag));
  more.setAttribute('aria-label', `管理「${tag}」：重命名 / 合并 / 删除`);
  more.title = '重命名 / 合并 / 删除';
  more.innerHTML = '<span aria-hidden="true">⋯</span>';
  row.append(more);

  if (state.menuTag === tag) {
    const menu = document.createElement('div');
    menu.className = 'galg-basket__menu';
    menu.dataset.galgTagMenu = tag;
    menu.innerHTML = `
      <button type="button" data-galg-tag-act="rename">重命名…</button>
      <button type="button" data-galg-tag-act="merge">合并到…</button>
      <button type="button" class="galg-danger" data-galg-tag-act="delete">删除标签</button>
    `;
    row.append(menu);
  }

  return row;
}

/* ------------------------------------------------------------------ */
/* 标签改名 / 合并 / 删除                                                */
/* ------------------------------------------------------------------ */

/**
 * 把一个标签名批量换成另一个名字（照片 + railTags + 上传勾选 + 当前筛选一起改）。
 * 返回被改到的照片张数。
 */
function retagAll(from: string, to: string): number {
  let changed = 0;
  for (const photo of state.photos) {
    const tags = photo.tags ?? [];
    if (!tags.includes(from)) continue;
    // 目标标签已经在这张照片上时，顺带去个重
    photo.tags = [...new Set(tags.map((tag) => (tag === from ? to : tag)))];
    changed += 1;
  }

  state.railTags = normalizeTagNames(state.railTags.map((tag) => (tag === from ? to : tag)));
  if (state.uploadTags.includes(from)) {
    state.uploadTags = normalizeTagNames(state.uploadTags.map((tag) => (tag === from ? to : tag)));
    saveUploadTags();
  }
  if (state.tagFilter === from) state.tagFilter = to;
  state.menuTag = null;
  return changed;
}

/** 从所有照片上摘掉一个标签（照片没别的标签了就连 tags 字段一起删） */
function removeTagEverywhere(tag: string): number {
  let changed = 0;
  for (const photo of state.photos) {
    const tags = photo.tags ?? [];
    if (!tags.includes(tag)) continue;
    const next = tags.filter((item) => item !== tag);
    if (next.length) photo.tags = next;
    else delete photo.tags;
    changed += 1;
  }

  state.railTags = state.railTags.filter((item) => item !== tag);
  if (state.uploadTags.includes(tag)) {
    state.uploadTags = state.uploadTags.filter((item) => item !== tag);
    saveUploadTags();
  }
  if (state.tagFilter === tag) state.tagFilter = null;
  state.menuTag = null;
  return changed;
}

/** ⋯ 菜单里的三个动作（改名 / 合并 / 删除） */
function runTagAction(tag: string, action: string | undefined): void {
  if (!tag) return;
  const known = tagList(state.photos).map((item) => item.tag);

  if (action === 'rename' || action === 'merge') {
    const merging = action === 'merge';
    const answer = window.prompt(
      merging
        ? `把「${tag}」合并到哪个标签？（输入标签名；这个标签会消失）`
        : `把「${tag}」改名叫：`,
      merging ? '' : tag,
    );
    if (answer === null) return;
    const to = answer.trim();
    if (!to) {
      showToast('名字不能是空的');
      return;
    }
    if (to === tag) return;

    const exists = known.includes(to);
    if (merging && !exists) {
      showToast(`没有「${to}」这个标签：这等于改名，直接改了`);
    }
    if (!merging && exists) {
      const ok = window.confirm(`已经有「${to}」这个标签了，把「${tag}」合并进去？`);
      if (!ok) return;
    }

    const changed = retagAll(tag, to);
    markDirty();
    renderGrid();
    setStatus(
      changed
        ? `「${tag}」→「${to}」：改了 ${changed} 张照片，记得「保存并提交」`
        : `「${tag}」→「${to}」：没有照片受影响，记得「保存并提交」`,
      'idle',
    );
    return;
  }

  if (action === 'delete') {
    const ok = window.confirm(
      `从所有照片上删掉「${tag}」这个标签？（照片本身不动，保存后生效）`,
    );
    if (!ok) return;
    const changed = removeTagEverywhere(tag);
    markDirty();
    renderGrid();
    setStatus(`已删掉标签「${tag}」：${changed} 张照片受影响，记得「保存并提交」`, 'idle');
  }
}

/** 刚被打上标签的卡片闪一下，确认「确实打到这张了」 */
function flashCards(ids: Iterable<string>): void {
  const grid = q<HTMLElement>('[data-galg-grid]');
  if (!grid) return;
  for (const id of ids) {
    const card = grid.querySelector<HTMLElement>(
      `[data-galg-card][data-id="${CSS.escape(id)}"]`,
    );
    if (!card) continue;
    card.classList.add('is-tagged');
    window.setTimeout(() => card.classList.remove('is-tagged'), 800);
  }
}

/**
 * 眼睛：切换这个标签在**相册页左侧抽屉**里显示 / 不显示（写 `railTags` 白名单）。
 * 全开 = 不限制（存空数组），以后新加的标签才会自动出现在抽屉里。
 */
function toggleRailTag(tag: string): void {
  const all = tagList(state.photos).map((item) => item.tag);
  if (!tag || !all.includes(tag)) return;

  // 没有白名单 = 当前全开；顺序按标签列表（JSON 白名单的顺序在读取后会保持）
  const base = state.railTags.length ? state.railTags : all;
  const order = [...base, ...all.filter((item) => !base.includes(item))];
  const on = new Set(base);
  if (on.has(tag)) on.delete(tag);
  else on.add(tag);

  const next = order.filter((item) => on.has(item));
  if (!next.length) {
    // 一个都不选没有意义（抽屉只剩「全部」），退回「全部展示」
    state.railTags = [];
    markDirty();
    renderBasket();
    showToast('一个分类都不选 = 全部展示，相册左侧栏会列出所有标签');
    return;
  }
  state.railTags = next.length === all.length ? [] : next;
  markDirty();
  renderBasket();
  setStatus(
    state.railTags.length
      ? `相册左侧栏展示 ${state.railTags.length} 个分类，记得「保存并提交」`
      : '相册左侧栏展示全部分类，记得「保存并提交」',
    'idle',
  );
}

/** 选中状态 / 批量按钮可用性（筛选生效时「全选」只覆盖看得见的那些） */
function renderPicked(): void {
  const n = state.picked.size;
  const visible = visiblePhotos();
  const visiblePicked = visible.filter((photo) => state.picked.has(photo.id)).length;

  const label = q<HTMLElement>('[data-galg-selected]');
  if (label) {
    label.textContent = n
      ? state.tagFilter
        ? `已选 ${n} 张（当前筛选 ${visiblePicked}/${visible.length}）`
        : `已选 ${n} 张`
      : '未选中';
  }

  for (const el of root()?.querySelectorAll<HTMLElement>('[data-galg-batch-op]') ?? []) {
    el.toggleAttribute('disabled', n === 0);
  }

  const all = q<HTMLInputElement>('[data-galg-pick-all]');
  if (all) {
    all.checked = visible.length > 0 && visiblePicked === visible.length;
    all.indeterminate = visiblePicked > 0 && visiblePicked < visible.length;
    all.title = state.tagFilter ? `只全选「${state.tagFilter}」里的照片` : '全选所有照片';
  }
}

function renderAll(): void {
  renderSettings();
  renderGrid();
}

/* ------------------------------------------------------------------ */
/* 读 / 写                                                             */
/* ------------------------------------------------------------------ */

async function load(): Promise<void> {
  if (!getEditSession() || !root()) return;
  state.busy = true;
  setStatus('读取中…', 'busy');
  try {
    const file = await getFile(GALLERY_PATH);
    if (!file) {
      state.sha = undefined;
      state.settings = { ...DEFAULT_SETTINGS };
      state.railTags = [];
      state.tagFilter = null;
      state.photos = [];
      state.picked.clear();
      renderAll();
      setStatus('仓库里还没有这个文件，保存时会新建', 'idle');
      return;
    }

    state.sha = file.sha;
    const parsed: unknown = JSON.parse(file.text);
    const data = (parsed && typeof parsed === 'object' ? parsed : {}) as {
      _说明?: unknown;
      settings?: unknown;
      railTags?: unknown;
      photos?: unknown;
    };

    state.settings = normalizeSettings(data.settings);
    state.railTags = normalizeRailTags(data.railTags);
    state.note = typeof data._说明 === 'string' && data._说明 ? data._说明 : DEFAULT_NOTE;
    state.photos = (Array.isArray(data.photos) ? data.photos : [])
      .map((photo, index) => normalizePhoto(photo as Partial<GalleryPhoto>, index))
      .filter((photo): photo is GalleryPhoto => photo !== null);
    state.picked.clear();
    state.trash.clear();
    state.tagFilter = null;
    state.dirty = false;
    renderAll();
    setStatus(`已读取 ${state.photos.length} 张照片`, 'saved');
  } catch (error) {
    handleError(error, '读取失败');
  } finally {
    state.busy = false;
  }
}

async function save(): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }
  if (state.busy) return;
  // 没改过就别提交：否则点一下「保存并提交」也会在远端留一个空提交
  if (!state.dirty) {
    setStatus('没有改动', 'idle');
    showToast('照片墙没有改动，不用提交');
    return;
  }
  if (!state.photos.length) {
    showToast('照片池是空的：先传几张，或者确认一下吧');
    return;
  }

  // id 不能重复：重复的话筛选/聚焦会认错人
  const seen = new Set<string>();
  for (const photo of state.photos) {
    if (seen.has(photo.id)) photo.id = newPhotoId();
    seen.add(photo.id);
  }

  state.busy = true;
  setStatus('提交中…', 'busy');
  const saveBtn = q<HTMLButtonElement>('[data-galg-save]');
  if (saveBtn) saveBtn.disabled = true;

  try {
    // 展示分类只保留照片上真的有的标签（删照片 / 去标签之后，白名单里可能留着孤儿名字）
    const present = new Set(tagList(state.photos).map((item) => item.tag));
    const railTags = state.railTags.filter((tag) => present.has(tag));

    const payload = {
      _说明: state.note,
      settings: state.settings,
      ...(railTags.length ? { railTags } : {}),
      photos: state.photos.map((photo) => ({
        id: photo.id,
        src: photo.src,
        w: photo.w,
        h: photo.h,
        ...(photo.title ? { title: photo.title } : {}),
        ...(photo.description ? { description: photo.description } : {}),
        ...(photo.tags?.length ? { tags: photo.tags } : {}),
        ...(photo.date ? { date: photo.date } : {}),
      })),
    };

    const result = await commitFiles(
      [{ path: GALLERY_PATH, text: `${JSON.stringify(payload, null, 2)}\n` }],
      `gallery: 更新照片墙（${state.photos.length} 张）`,
    );
    state.sha = result.commitSha;
    state.dirty = false;
    // 本地面板跟着写进去的那份对齐（白名单里被剪掉的孤儿标签不该还挂在界面上）
    state.railTags = railTags;
    if (saveBtn) saveBtn.classList.remove('is-dirty');

    // 提交成功之后再清图床上的孤儿文件
    const stillUsed = new Set(
      state.photos.map((photo) => mediaKeyFromUrl(photo.src)).filter(Boolean) as string[],
    );
    const trash = [...state.trash].filter((key) => !stillUsed.has(key));
    state.trash.clear();
    if (trash.length) {
      try {
        await deleteMedia(trash);
      } catch {
        /* 删不掉不影响这次提交，图床里多留几个文件而已 */
      }
    }

    setStatus('已提交，约 1 分钟后生效', 'saved');
    showToast(`已提交 ${state.photos.length} 张照片，约 1 分钟后生效`);
  } catch (error) {
    handleError(error, '保存失败');
  } finally {
    state.busy = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

function handleError(error: unknown, fallback: string): void {
  if (error instanceof ApiError && error.status === 401) {
    clearEditSession();
    showToast('写作授权已失效，请在页面顶部重新授权');
    setStatus('授权已失效', 'error');
    return;
  }
  setStatus('', 'idle');
  showToast(error instanceof Error ? error.message : fallback);
}

/* ------------------------------------------------------------------ */
/* 加照片                                                              */
/* ------------------------------------------------------------------ */

/** 上传时给新照片自动打上的标签（工具栏「新照片标签」里勾的那些） */
function uploadTagList(): string[] {
  return [...state.uploadTags];
}

function looksLikeImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i.test(file.name);
}

async function addLocalFiles(files: File[]): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }
  const images = files.filter(looksLikeImage);
  if (!images.length) {
    showToast('只能上传图片');
    return;
  }

  const tags = uploadTagList();
  const queue = [...images];
  let done = 0;
  let failed = 0;
  let added = 0;

  const grid = q<HTMLElement>('[data-galg-grid]');
  const empty = grid?.querySelector('.galg-empty');
  empty?.remove();

  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        const result = await uploadImage(file, {
          folder: 'gallery',
          maxSide: 2000,
          quality: 0.88,
          targetBytes: 320 * 1024,
          maxBytes: 1.2 * 1024 * 1024,
        });
        const photo: GalleryPhoto = {
          id: newPhotoId(),
          src: result.url,
          w: result.width,
          h: result.height,
          ...(tags.length ? { tags } : {}),
        };
        state.photos.push(photo);
        added += 1;
        if (grid) grid.append(buildCard(photo, state.photos.length - 1));
      } catch (error) {
        failed += 1;
        showToast(
          error instanceof Error ? `「${file.name}」上传失败：${error.message}` : '上传失败',
        );
      } finally {
        done += 1;
        setStatus(`上传 ${done}/${images.length}…`, 'busy');
      }
    }
  });

  await Promise.all(workers);

  if (added) markDirty();
  renderPicked();
  renderUploadTags();
  renderBasket();
  const count = q<HTMLElement>('[data-galg-count]');
  if (count) count.textContent = `${state.photos.length} 张 · ${tagList(state.photos).length} 个标签`;
  if (!state.photos.length) renderGrid();
  const suffix = tags.length ? `（标签：${tags.join('、')}）` : '';
  setStatus(
    failed
      ? `上传完成：成功 ${added}，失败 ${failed}`
      : `已加入 ${added} 张${suffix}，记得点「保存并提交」`,
    failed ? 'error' : 'idle',
  );
}

/** 从图床挑图：已经有地址的直接进池子，一个字节都不重新上传 */
async function pickFromLibrary(): Promise<void> {
  const picked = await openMediaDialog({
    mode: 'insert',
    folder: 'gallery',
    hint: '选图床里已有的图片，或者直接在弹窗里上传',
  });
  if (!picked) return;

  const images = picked.files.filter(
    (file) =>
      (file.type || '').startsWith('image/') ||
      /\.(webp|jpe?g|png|gif|avif)$/i.test(file.name),
  );
  if (!images.length) {
    showToast('选中的不是图片');
    return;
  }

  const tags = uploadTagList();
  for (const file of images) {
    const size =
      file.width && file.height ? { w: file.width, h: file.height } : await probeSize(file.url);
    state.photos.push({
      id: newPhotoId(),
      src: file.url,
      w: size.w,
      h: size.h,
      ...(tags.length ? { tags } : {}),
    });
  }
  markDirty();
  renderGrid();
  const suffix = tags.length ? `（标签：${tags.join('、')}）` : '';
  setStatus(`已加入 ${images.length} 张${suffix}，记得点「保存并提交」`, 'idle');
}

/** 图床列表没带尺寸时（老对象）现场量一下，排版要用 */
function probeSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1200, h: img.naturalHeight || 900 });
    img.onerror = () => resolve({ w: 1200, h: 900 });
    img.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* 单张 / 批量操作                                                      */
/* ------------------------------------------------------------------ */

function findPhoto(id: string): GalleryPhoto | undefined {
  return state.photos.find((photo) => photo.id === id);
}

function removePhotos(ids: Set<string>): void {
  if (!ids.size) return;
  const keep: GalleryPhoto[] = [];
  for (const photo of state.photos) {
    if (!ids.has(photo.id)) {
      keep.push(photo);
      continue;
    }
    // 图床上的文件留到提交成功之后删；仓库内路径 / 外链不动
    const key = mediaKeyFromUrl(photo.src);
    if (key) state.trash.add(key);
  }
  state.photos = keep;
  for (const id of ids) state.picked.delete(id);
}

function addTagTo(ids: Set<string>, tag: string): number {
  const name = tag.trim();
  if (!name || !ids.size) return 0;
  let changed = 0;
  for (const photo of state.photos) {
    if (!ids.has(photo.id)) continue;
    const tags = new Set(photo.tags ?? []);
    if (tags.has(name)) continue;
    tags.add(name);
    photo.tags = [...tags];
    changed += 1;
  }
  return changed;
}

function removeTagFrom(ids: Set<string>, tag: string): number {
  const name = tag.trim();
  if (!name || !ids.size) return 0;
  let changed = 0;
  for (const photo of state.photos) {
    if (!ids.has(photo.id)) continue;
    const before = photo.tags ?? [];
    const after = before.filter((item) => item !== name);
    if (after.length === before.length) continue;
    if (after.length) photo.tags = after;
    else delete photo.tags;
    changed += 1;
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* 拖拽排序                                                            */
/* ------------------------------------------------------------------ */

let dragId: string | null = null;
/** 正在被拖的照片 id（拖的那张被勾选时 = 所有勾选的） */
let dragIds: string[] = [];

/** 收尾：清掉所有拖拽残留（卡片半透明、标签落点高亮、「可打标」提示） */
function clearDragState(): void {
  dragId = null;
  dragIds = [];
  const grid = q<HTMLElement>('[data-galg-grid]');
  for (const card of grid?.querySelectorAll('.is-dragging') ?? []) card.classList.remove('is-dragging');
  q<HTMLElement>('[data-galg-work]')?.classList.remove('is-dragging');
  for (const row of root()?.querySelectorAll('.galg-basket__item.is-over') ?? []) {
    row.classList.remove('is-over');
  }
}

function commitOrder(): void {
  const grid = q<HTMLElement>('[data-galg-grid]');
  if (!grid) return;
  const order = [...grid.querySelectorAll<HTMLElement>('[data-galg-card]')].map(
    (card) => card.dataset.id ?? '',
  );
  if (order.length !== state.photos.length) return;

  const byId = new Map(state.photos.map((photo) => [photo.id, photo]));
  const next: GalleryPhoto[] = [];
  for (const id of order) {
    const photo = byId.get(id);
    if (photo) next.push(photo);
  }
  if (next.length !== state.photos.length) return;

  const changed = next.some((photo, index) => photo !== state.photos[index]);
  state.photos = next;
  if (changed) markDirty();
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

/**
 * 上一次绑过事件的容器节点。
 *
 * 不能用 `let bound = false` 那种一次性布尔守卫：本站开了 <ClientRouter />，
 * 换页时 DOM 会被替换、而 ES 模块只执行一次，于是「离开 /config 再回来」时
 * init() 会再次跑到这里，却因为 bound 已经是 true 直接早退 ——
 * 新 DOM 一个监听都没有，整栏按钮（上传图片 / 从图床选 / 保存并提交 / 拖拽排序）
 * 全部点不动，看着像「功能坏了」。
 * 所以守的是「绑的是不是现在这个节点」：节点换了就重新绑。
 */
let boundEl: HTMLElement | null = null;

function bind(): void {
  const container = root();
  if (!container || container === boundEl) return;
  boundEl = container;

  /* --- 工具栏 --- */
  container.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest('[data-galg-upload]')) {
      q<HTMLInputElement>('[data-galg-file]')?.click();
      return;
    }
    if (target.closest('[data-galg-library]')) {
      void pickFromLibrary();
      return;
    }
    if (target.closest('[data-galg-save]')) {
      void save();
      return;
    }
    if (target.closest('[data-galg-reload]')) {
      if (state.dirty && !window.confirm('有未保存的改动，确定重新读取吗？')) return;
      void load();
      return;
    }

    /* --- 标签篮：⋯ 菜单里的动作 --- */
    const actBtn = target.closest<HTMLElement>('[data-galg-tag-act]');
    if (actBtn) {
      const tag = actBtn.closest<HTMLElement>('[data-galg-tag-menu]')?.dataset.galgTagMenu ?? '';
      runTagAction(tag, actBtn.dataset.galgTagAct);
      return;
    }

    /* --- 标签篮：⋯ 打开 / 收起管理菜单 --- */
    const moreBtn = target.closest<HTMLElement>('[data-galg-basket-more]');
    if (moreBtn) {
      const tag = moreBtn.dataset.galgBasketMore ?? '';
      state.menuTag = state.menuTag === tag ? null : tag;
      renderBasket();
      return;
    }

    /* --- 标签篮：眼睛 = 相册页左侧抽屉列不列这个分类 --- */
    const railChip = target.closest<HTMLElement>('[data-galg-rail-tag]');
    if (railChip) {
      toggleRailTag(railChip.dataset.galgRailTag ?? '');
      return;
    }
    if (target.closest('[data-galg-rail-all]')) {
      if (!state.railTags.length) {
        showToast('已经是全部展示了');
        return;
      }
      state.railTags = [];
      markDirty();
      renderBasket();
      setStatus('相册左侧栏展示全部分类，记得「保存并提交」', 'idle');
      return;
    }

    /* --- 新照片标签（上传时自动打上） --- */
    const uploadChip = target.closest<HTMLElement>('[data-galg-upload-tag]');
    if (uploadChip) {
      toggleUploadTag(uploadChip.dataset.galgUploadTag ?? '');
      return;
    }

    /* --- 标签篮：点名字 = 只看这个标签 --- */
    const basketRow = target.closest<HTMLElement>('[data-galg-basket-tag]');
    if (basketRow) {
      const tag = basketRow.dataset.galgBasketTag ?? '';
      state.tagFilter = tag && tag !== state.tagFilter ? tag : null;
      state.menuTag = null;
      renderGrid();
      setStatus(state.tagFilter ? `只看「${state.tagFilter}」` : '显示全部照片', 'idle');
      return;
    }

    /* --- 批量操作 --- */
    if (target.closest('[data-galg-select-all]')) {
      state.picked = new Set(visiblePhotos().map((photo) => photo.id));
      renderGrid();
      return;
    }
    if (target.closest('[data-galg-select-none]')) {
      state.picked.clear();
      renderGrid();
      return;
    }
    if (target.closest('[data-galg-tag-add]') || target.closest('[data-galg-tag-remove]')) {
      const input = q<HTMLInputElement>('[data-galg-tag-input]');
      const tag = input?.value.trim() ?? '';
      if (!tag) {
        showToast('先在输入框里写一个标签');
        input?.focus();
        return;
      }
      if (!state.picked.size) {
        showToast('先选中要打标签的照片');
        return;
      }
      const adding = Boolean(target.closest('[data-galg-tag-add]'));
      const changed = adding
        ? addTagTo(state.picked, tag)
        : removeTagFrom(state.picked, tag);
      if (!changed) {
        showToast(adding ? '这些照片已经有这个标签了' : '这些照片没有这个标签');
        return;
      }
      markDirty();
      renderGrid();
      setStatus(`已${adding ? '加' : '去'}标签「${tag}」：${changed} 张`, 'idle');
      return;
    }
    if (target.closest('[data-galg-batch-del]')) {
      if (!state.picked.size) return;
      const ok = window.confirm(`从照片墙删掉选中的 ${state.picked.size} 张？（保存后生效）`);
      if (!ok) return;
      removePhotos(new Set(state.picked));
      markDirty();
      renderGrid();
      return;
    }

    /* --- 单张 --- */
    const removeBtn = target.closest<HTMLElement>('[data-galg-remove]');
    if (removeBtn) {
      const card = removeBtn.closest<HTMLElement>('[data-galg-card]');
      const id = card?.dataset.id;
      if (id) {
        removePhotos(new Set([id]));
        markDirty();
        renderGrid();
      }
      return;
    }

    const tagRm = target.closest<HTMLElement>('[data-galg-tagrm]');
    if (tagRm) {
      const card = tagRm.closest<HTMLElement>('[data-galg-card]');
      const id = card?.dataset.id;
      const tag = tagRm.dataset.galgTagrm ?? '';
      if (id && tag) {
        removeTagFrom(new Set([id]), tag);
        markDirty();
        renderGrid();
      }
    }
  });

  /* --- 勾选 --- */
  container.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.matches('[data-galg-pick-all]')) {
      state.picked = target.checked
        ? new Set(visiblePhotos().map((photo) => photo.id))
        : new Set();
      renderGrid();
      return;
    }
    if (target.matches('[data-galg-pick]')) {
      const card = target.closest<HTMLElement>('[data-galg-card]');
      const id = card?.dataset.id;
      if (!id) return;
      if (target.checked) state.picked.add(id);
      else state.picked.delete(id);
      renderPicked();
    }
  });

  /* --- 改标题 --- */
  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.matches('[data-galg-title]')) {
      const card = target.closest<HTMLElement>('[data-galg-card]');
      const photo = card?.dataset.id ? findPhoto(card.dataset.id) : undefined;
      if (!photo) return;
      const value = target.value.trim();
      if (value) photo.title = value;
      else delete photo.title;
      markDirty();
      return;
    }

    if (target.matches('[data-galg-setting]')) {
      const key = target.dataset.galgSetting as keyof GallerySettings | undefined;
      if (!key || !(key in SETTING_RANGE)) return;
      const range = SETTING_RANGE[key];
      state.settings[key] = Math.min(range.max, Math.max(range.min, Number(target.value)));
      const out = q<HTMLElement>(`[data-galg-out="${key}"]`);
      if (out) out.textContent = formatSetting(key, state.settings[key]);
      markDirty();
    }
  });

  /* --- 回车：单张加标签 / 新建上传标签 --- */
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    // 工具栏「+ 新建标签」：回车即建，并顺手勾上（下次上传就用它）
    if (target.matches('[data-galg-upload-tag-new]')) {
      event.preventDefault();
      const name = target.value.trim();
      if (!name) return;
      target.value = '';
      if (state.uploadTags.includes(name)) {
        showToast(`「${name}」已经在勾选里了`);
        return;
      }
      toggleUploadTag(name);
      setStatus(`已勾上「${name}」：接下来传的照片会带上它`, 'idle');
      return;
    }

    if (!target.matches('[data-galg-tagnew]')) return;

    event.preventDefault();
    const card = target.closest<HTMLElement>('[data-galg-card]');
    const id = card?.dataset.id;
    const tag = target.value.trim();
    if (!id || !tag) return;
    addTagTo(new Set([id]), tag);
    markDirty();
    renderGrid();
  });

  /* --- 文件选择 --- */
  const fileInput = q<HTMLInputElement>('[data-galg-file]');
  fileInput?.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void addLocalFiles(files);
  });

  /* --- 拖拽：落在卡片上 = 改顺序，落在右侧标签篮上 = 加标签 --- */
  const grid = q<HTMLElement>('[data-galg-grid]');
  const work = q<HTMLElement>('[data-galg-work]');

  if (grid) {
    grid.addEventListener('dragstart', (event) => {
      const card = (event.target as Element | null)?.closest<HTMLElement>('[data-galg-card]');
      if (!card) return;
      const id = card.dataset.id ?? null;
      dragId = id;
      // 拖的那张如果已经被勾选，就带着所有勾选的一起走（一次给很多张打标）
      dragIds = id && state.picked.has(id) ? [...state.picked] : id ? [id] : [];
      card.classList.add('is-dragging');
      work?.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData('text/plain', dragIds.join(' '));
      }
    });

    grid.addEventListener('dragend', () => {
      clearDragState();
      commitOrder();
    });

    grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (!dragId) return;
      const card = (event.target as Element | null)?.closest<HTMLElement>('[data-galg-card]');
      if (!card || card.dataset.id === dragId) return;

      const dragged = grid.querySelector<HTMLElement>(
        `[data-galg-card][data-id="${CSS.escape(dragId)}"]`,
      );
      if (!dragged) return;

      const rect = card.getBoundingClientRect();
      const after = event.clientX - rect.left > rect.width / 2;
      card.parentNode?.insertBefore(dragged, after ? card.nextSibling : card);
    });

    grid.addEventListener('drop', (event) => {
      event.preventDefault();
      clearDragState();
      commitOrder();
    });
  }

  /* --- 兜底：无论在哪里松手，都把拖拽残留收干净 ---
     （落在篮子外、或者拖到一半卡片被重渲染，dragstart 打上的状态可能没人来收） */
  document.addEventListener('dragend', clearDragState);
  window.addEventListener('blur', clearDragState);

  /* --- 标签篮：拖入照片 = 加标签（整行都是落点，眼睛和 ⋯ 也在行里） --- */
  container.addEventListener('dragover', (event) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>('[data-galg-basket-row]');
    if (!row || !dragId) return;
    // 这里必须 preventDefault，否则浏览器认为「不许放」，drop 根本不会触发
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    for (const other of container.querySelectorAll('.galg-basket__row.is-over')) {
      if (other !== row) other.classList.remove('is-over');
    }
    row.classList.add('is-over');
  });

  container.addEventListener('dragleave', (event) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>('[data-galg-basket-row]');
    row?.classList.remove('is-over');
  });

  container.addEventListener('drop', (event) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>('[data-galg-basket-row]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();

    const tag = row.dataset.tag ?? '';
    // 兜底：万一 dragstart 里的多选快照没拿到，就只处理拖的这一张
    const ids = new Set(dragIds.length ? dragIds : dragId ? [dragId] : []);
    clearDragState();
    if (!tag) {
      showToast('要拖到具体的标签上才会打标；「全部」只是取消筛选');
      return;
    }
    if (!ids.size) return;

    const changed = addTagTo(ids, tag);
    if (!changed) {
      showToast(`这些照片已经有「${tag}」了`);
      return;
    }
    markDirty();
    renderGrid();
    flashCards(ids);
    setStatus(`已给 ${changed} 张加上「${tag}」，记得「保存并提交」`, 'idle');
  });

  /* --- 点篮子外面 / 按 Esc：收起「⋯」菜单 ---
     用捕获阶段：篮子里点一下会当场重渲染（行的父链被打断），
     等冒泡到 document 时 target.closest() 已经判不出「在篮子里」了。 */
  document.addEventListener(
    'click',
    (event) => {
      if (!state.menuTag) return;
      const el = event.target instanceof Element ? event.target : null;
      // 篮子里的点击交给下面那个 handler（它自己会决定要不要收）
      if (el?.closest('[data-galg-basket]')) return;
      state.menuTag = null;
      renderBasket();
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.menuTag) return;
    state.menuTag = null;
    renderBasket();
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function init(): void {
  const container = root();
  if (!container) return;
  bind();
  // 上传标签是本机偏好，跟授权无关，先读回来
  loadUploadTags();
  if (getEditSession()) {
    void load();
  } else {
    renderAll();
    setStatus('等待授权…', 'idle');
  }
}

onEditAuthChange(() => {
  if (getEditSession()) void load();
});

onPageLoad(init);

/** 顶栏那颗保存按钮切到这一栏时，交给这里 —— 写的是 config/gallery.json */
registerPanelWriter('gallery', {
  label: '照片墙',
  save,
  isDirty: () => state.dirty,
});
