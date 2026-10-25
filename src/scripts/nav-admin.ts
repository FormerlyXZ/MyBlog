/**
 * /config →「网站导航」
 * ============================================================
 * 可视化维护 config/navigation.json：
 *   分组（category + 图标）→ 站点（名称 / 网址 / 一句介绍 / 图标）
 *
 * 约定：
 *   · 改动先留在内存里（groups），点「保存并提交」才写仓库，一次 commit
 *   · 图标优先用图片：填站内路径（/nav/xxx.png）或外链，也可以直接上传
 *     （上传 = 先把图提交到 public/nav/，再把路径写进货架）
 *   · 图片留空时回落到 Iconify 图标名（icon 字段），卡片上就显示矢量图标
 *   · 站点的增删、排序都直接改数组，保存时按当前顺序写出去
 * ============================================================
 */

import { onPageLoad } from './pageload';
import { getEditSession, onEditAuthChange, showToast } from '../utils/site';
import { getFile, putBinary, putFile } from '../utils/github';

const NAV_PATH = 'config/navigation.json';
const LOGO_DIR = 'public/nav';

interface NavItem {
  name: string;
  url: string;
  description?: string;
  logo?: string;
  icon?: string;
}

interface NavGroup {
  category: string;
  icon?: string;
  items: NavItem[];
}

let groups: NavGroup[] = [];
let fileSha: string | undefined;
let dirty = false;
let loaded = false;
let loading = false;
let bound = false;
/** 上一次点「上传图标」的是哪一条（gi / ii） */
let pendingUpload: { gi: number; ii: number } | null = null;

/* ---------------- 小工具 ---------------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-nav-status]');
  if (el) el.textContent = text;
}

function markDirty(): void {
  dirty = true;
  setStatus('有未提交的改动');
}

function groupsBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-nav-groups]');
}

/** 把仓库里的 JSON 收敛成编辑器认识的结构（字段缺失/类型不对都不会炸） */
function normalize(raw: unknown): NavGroup[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { groups?: unknown }).groups)
      ? ((raw as { groups: unknown[] }).groups as unknown[])
      : [];

  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const group = entry as Record<string, unknown>;
    const rawItems = Array.isArray(group.items) ? group.items : [];
    return [
      {
        category: typeof group.category === 'string' ? group.category : '',
        icon: typeof group.icon === 'string' ? group.icon : '',
        items: rawItems.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const link = item as Record<string, unknown>;
          return [
            {
              name: typeof link.name === 'string' ? link.name : '',
              url: typeof link.url === 'string' ? link.url : '',
              description: typeof link.description === 'string' ? link.description : '',
              logo: typeof link.logo === 'string' ? link.logo : '',
              icon: typeof link.icon === 'string' ? link.icon : '',
            },
          ];
        }),
      },
    ];
  });
}

/* ---------------- 渲染 ---------------- */

function itemHtml(item: NavItem, gi: number, ii: number, total: number): string {
  const logo = item.logo ?? '';
  const icon = item.icon ?? '';
  const thumb = logo
    ? `<img src="${escapeHtml(logo)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';

  return `
    <div class="na-item" data-gi="${gi}" data-ii="${ii}">
      <span class="na-item__thumb" title="图标预览">${thumb}</span>
      <div class="na-item__body">
        <div class="na-item__row na-item__row--main">
          <input class="input-pill" data-nav-field="name" data-gi="${gi}" data-ii="${ii}"
                 value="${escapeHtml(item.name)}" placeholder="站点名称，如 南航官网" />
          <input class="input-pill" data-nav-field="url" data-gi="${gi}" data-ii="${ii}"
                 value="${escapeHtml(item.url)}" placeholder="https://…" />
        </div>
        <div class="na-item__row">
          <input class="input-pill" data-nav-field="description" data-gi="${gi}" data-ii="${ii}"
                 value="${escapeHtml(item.description ?? '')}" placeholder="一句介绍：显示在卡片上的那两行" />
        </div>
        <div class="na-item__row na-item__row--icon">
          <input class="input-pill" data-nav-field="logo" data-gi="${gi}" data-ii="${ii}"
                 value="${escapeHtml(logo)}" placeholder="图标图片：/nav/xxx.png 或外链（可留空）" />
          <input class="input-pill" data-nav-field="icon" data-gi="${gi}" data-ii="${ii}"
                 value="${escapeHtml(icon)}" placeholder="图标名（没有图片时用）：ri:github-line" />
          <button type="button" class="btn-pill px-3 py-1.5 text-xs" data-nav-act="item-upload" data-gi="${gi}" data-ii="${ii}">
            上传图标
          </button>
        </div>
      </div>
      <div class="config-row-actions na-item__actions">
        <button type="button" class="config-icon-btn" data-nav-act="item-up" data-gi="${gi}" data-ii="${ii}"
                title="上移" ${ii === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="config-icon-btn" data-nav-act="item-down" data-gi="${gi}" data-ii="${ii}"
                title="下移" ${ii === total - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="config-icon-btn" data-nav-act="item-del" data-gi="${gi}" data-ii="${ii}"
                title="删除这个站点">✕</button>
      </div>
    </div>`;
}

function groupHtml(group: NavGroup, gi: number): string {
  const items = group.items.map((item, ii) => itemHtml(item, gi, ii, group.items.length)).join('');

  return `
    <section class="na-group" data-gi="${gi}">
      <div class="na-group__head">
        <input class="input-pill na-group__name" data-nav-field="category" data-gi="${gi}"
               value="${escapeHtml(group.category)}" placeholder="分组名称，如 南航专区" />
        <input class="input-pill na-group__icon" data-nav-field="icon" data-gi="${gi}"
               value="${escapeHtml(group.icon ?? '')}" placeholder="分组图标（Iconify，可留空）" />
        <div class="config-row-actions">
          <button type="button" class="config-icon-btn" data-nav-act="group-up" data-gi="${gi}"
                  title="上移分组" ${gi === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="config-icon-btn" data-nav-act="group-down" data-gi="${gi}"
                  title="下移分组" ${gi === groups.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="config-icon-btn" data-nav-act="group-del" data-gi="${gi}"
                  title="删除整个分组">✕</button>
        </div>
      </div>

      <div class="na-items">
        ${items || '<p class="na-empty">这个分组还没有站点，点下面「新增站点」加一个。</p>'}
      </div>

      <div class="na-group__foot">
        <button type="button" class="btn-pill px-3 py-1.5 text-xs" data-nav-act="item-add" data-gi="${gi}">
          ＋ 新增站点
        </button>
        <span class="na-group__count">${group.items.length} 个站点</span>
      </div>
    </section>`;
}

function render(): void {
  const box = groupsBox();
  if (!box) return;
  box.innerHTML = groups.length
    ? groups.map((group, gi) => groupHtml(group, gi)).join('')
    : '<p class="na-empty">还没有分组，点上面「新增分组」开始（例如「南航专区」）。</p>';
}

/* ---------------- 读 / 存 ---------------- */

async function load(): Promise<void> {
  if (!getEditSession()) return;
  if (loading) return;
  loading = true;
  setStatus('读取中…');
  try {
    const file = await getFile(NAV_PATH);
    if (!file) {
      groups = [];
      fileSha = undefined;
      render();
      setStatus('仓库里还没有 config/navigation.json，保存时会新建');
      return;
    }
    fileSha = file.sha;
    try {
      groups = normalize(JSON.parse(file.text));
    } catch {
      groups = [];
      showToast('navigation.json 解析失败，已从空白开始（请不要点保存，先修仓库里的文件）');
    }
    dirty = false;
    loaded = true;
    render();
    setStatus('已读取最新导航');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '读取失败');
  } finally {
    loading = false;
  }
}

function tidy(groupsIn: NavGroup[]): { list: NavGroup[]; dropped: number } {
  let dropped = 0;
  const list = groupsIn
    .map((group) => ({
      category: group.category.trim() || '未命名分组',
      icon: (group.icon ?? '').trim() || undefined,
      items: group.items
        .filter((item) => {
          const ok = Boolean(item.name.trim() && item.url.trim());
          if (!ok) dropped += 1;
          return ok;
        })
        .map((item) => ({
          name: item.name.trim(),
          url: item.url.trim(),
          description: (item.description ?? '').trim() || undefined,
          logo: (item.logo ?? '').trim() || undefined,
          icon: (item.icon ?? '').trim() || undefined,
        })),
    }))
    .filter((group) => group.items.length > 0);

  return { list, dropped };
}

async function save(): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }

  const { list, dropped } = tidy(groups);
  if (!list.length) {
    showToast('至少留一个填好名称和网址的站点');
    return;
  }

  setStatus('提交中…');
  try {
    const latest = await getFile(NAV_PATH);
    await putFile(
      NAV_PATH,
      `${JSON.stringify(list, null, 2)}\n`,
      'nav: 更新网站导航（config/navigation.json）',
      latest?.sha ?? fileSha,
    );
    fileSha = latest?.sha ?? fileSha;
    groups = list.map((group) => ({
      category: group.category,
      icon: group.icon ?? '',
      items: group.items.map((item) => ({
        name: item.name,
        url: item.url,
        description: item.description ?? '',
        logo: item.logo ?? '',
        icon: item.icon ?? '',
      })),
    }));
    dirty = false;
    loaded = true;
    render();
    setStatus('已提交，等自动部署完成后生效');
    showToast(
      dropped > 0
        ? `导航已提交（忽略 ${dropped} 个没填全的站点），约 1 分钟后生效`
        : '导航已提交，约 1 分钟后生效',
    );
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '提交失败');
  }
}

/* ---------------- 上传图标 ---------------- */

async function uploadLogo(file: File, gi: number, ii: number): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权');
    return;
  }
  const item = groups[gi]?.items[ii];
  if (!item) return;

  setStatus('图标上传中…');
  try {
    const buffer = await file.arrayBuffer();
    const safeName = file.name.replace(/[^\w.-]+/g, '-');
    const path = `${LOGO_DIR}/${Date.now()}-${safeName}`;
    await putBinary(path, buffer, `nav: 上传站点图标 ${file.name}`);
    item.logo = `/${path.replace(/^public\//, '')}`;
    markDirty();
    render();
    setStatus(`图标已上传（${item.logo}），别忘了点「保存并提交」`);
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '上传失败');
  }
}

/* ---------------- 交互 ---------------- */

function moveGroup(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= groups.length) return;
  const [group] = groups.splice(index, 1);
  if (group) groups.splice(target, 0, group);
  markDirty();
  render();
}

function moveItem(gi: number, ii: number, delta: number): void {
  const list = groups[gi]?.items;
  if (!list) return;
  const target = ii + delta;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(ii, 1);
  if (item) list.splice(target, 0, item);
  markDirty();
  render();
}

function bindDelegates(): void {
  if (bound) return;
  bound = true;

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!document.querySelector('[data-nav-admin]')) return;

      if (target.closest('[data-nav-add-group]')) {
        groups.push({
          category: `分组 ${groups.length + 1}`,
          icon: '',
          items: [{ name: '', url: '', description: '', logo: '', icon: '' }],
        });
        markDirty();
        render();
        return;
      }

      if (target.closest('[data-nav-save]')) {
        void save();
        return;
      }

      if (target.closest('[data-nav-reload]')) {
        if (dirty && !window.confirm('有未提交的改动，确定重新读取吗？')) return;
        loaded = false;
        void load();
        return;
      }

      const act = target.closest<HTMLElement>('[data-nav-act]');
      if (!act) return;

      const gi = Number(act.dataset.gi ?? -1);
      const ii = Number(act.dataset.ii ?? -1);
      const action = act.dataset.navAct;

      if (action === 'group-up') moveGroup(gi, -1);
      else if (action === 'group-down') moveGroup(gi, 1);
      else if (action === 'group-del') {
        const group = groups[gi];
        if (!group) return;
        if (!window.confirm(`删除分组「${group.category || '未命名'}」及其 ${group.items.length} 个站点？`)) return;
        groups.splice(gi, 1);
        markDirty();
        render();
      } else if (action === 'item-add') {
        groups[gi]?.items.push({ name: '', url: '', description: '', logo: '', icon: '' });
        markDirty();
        render();
      } else if (action === 'item-up') moveItem(gi, ii, -1);
      else if (action === 'item-down') moveItem(gi, ii, 1);
      else if (action === 'item-del') {
        groups[gi]?.items.splice(ii, 1);
        markDirty();
        render();
      } else if (action === 'item-upload') {
        pendingUpload = { gi, ii };
        const input = document.querySelector<HTMLInputElement>('[data-nav-file]');
        input?.click();
      }
    },
    true,
  );

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.hasAttribute('data-nav-file')) return;
    const file = target.files?.[0];
    target.value = '';
    if (!file || !pendingUpload) return;
    const { gi, ii } = pendingUpload;
    pendingUpload = null;
    void uploadLogo(file, gi, ii);
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = target.dataset.navField;
    if (!field) return;

    const gi = Number(target.dataset.gi ?? -1);
    const ii = Number(target.dataset.ii ?? -1);
    const value = target.value;

    if (target.dataset.ii === undefined) {
      // 分组级的字段（分组名 / 分组图标）
      const group = groups[gi];
      if (!group) return;
      if (field === 'category') group.category = value;
      else if (field === 'icon') group.icon = value;
    } else {
      const item = groups[gi]?.items[ii];
      if (!item) return;
      if (field === 'name') item.name = value;
      else if (field === 'url') item.url = value;
      else if (field === 'description') item.description = value;
      else if (field === 'icon') item.icon = value;
      else if (field === 'logo') {
        item.logo = value;
        // 预览跟着输入走，不用整块重绘（重绘会丢焦点）
        const thumb = target.closest('.na-item')?.querySelector<HTMLElement>('.na-item__thumb');
        if (thumb) {
          thumb.innerHTML = value
            ? `<img src="${escapeHtml(value)}" alt="" loading="lazy" onerror="this.remove()" />`
            : '';
        }
      }
    }
    markDirty();
  });

  onEditAuthChange(() => {
    if (document.querySelector('[data-nav-admin]')) void load();
  });
}

/* ---------------- 入口 ---------------- */

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-nav-admin]');
  if (!root) return;

  bindDelegates();
  if (getEditSession() && !loaded && !loading) void load();

  // 从别处带 #nav 过来时直接展开这个板块
  if (window.location.hash === '#nav') {
    document.querySelector<HTMLElement>('[data-config-tab="nav"]')?.click();
  }
}

onPageLoad(init);
