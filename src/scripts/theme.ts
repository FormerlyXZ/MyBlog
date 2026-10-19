/**
 * 主题切换与 Banner 模式（DOM 逻辑）
 * ============================================================
 * 两件事都在这里：
 *   ① 29 套 daisyUI 配色（浅色默认 garden，深色默认 dracula）
 *   ② Banner 四档模式：默认 / 全屏 / 隐藏 / 作为背景
 *
 * 状态都写到 <html> 上：
 *   data-theme="garden"         daisyUI 配色
 *   data-theme-type="light"     明暗分叉（决定拟态阴影、Giscus 主题、遮罩强度）
 *   data-banner-mode="default"   Banner 形态
 *
 * 持久化：localStorage['theme'] / localStorage['banner-mode']
 * 防闪屏：BaseLayout 的 <head> 里有一段 inline 脚本先跑（本文件只负责后续切换）
 *
 * 清单本身在 src/utils/theme.ts（纯数据，服务端也要用）。
 * ============================================================
 */

import { BANNER_MODES, DARK_THEMES, THEME_LIST, type BannerMode } from '../utils/theme';
import { onPageLoad } from './pageload';
import { bindPopover } from './popover';

export { BANNER_MODES, DARK_THEMES };
export type { BannerMode };

const THEME_KEY = 'theme';
const BANNER_MODE_KEY = 'banner-mode';
const THEME_NAMES: string[] = THEME_LIST.map((item) => item.name);

/** 读 <html> 上由 SSR 写入的默认值 */
function defaults(): { light: string; dark: string } {
  const root = document.documentElement;
  return {
    light: root.dataset.themeLight || 'garden',
    dark: root.dataset.themeDark || 'dracula',
  };
}

export function isDarkTheme(name: string): boolean {
  return DARK_THEMES.includes(name);
}

/** 切换配色并持久化 */
export function setTheme(name: string, persist = true): void {
  const root = document.documentElement;
  root.dataset.theme = name;
  root.dataset.themeType = isDarkTheme(name) ? 'dark' : 'light';
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, name);
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }
  syncSelected();
  document.dispatchEvent(new CustomEvent('melodyxz:theme', { detail: { theme: name } }));
}

/** 在「浅色默认」和「深色默认」之间切换 */
export function toggleTheme(): void {
  const current = document.documentElement.dataset.theme || '';
  const { light, dark } = defaults();
  setTheme(isDarkTheme(current) ? light : dark);
}

/** 切换 Banner 模式并持久化 */
export function setBannerMode(mode: BannerMode): void {
  document.documentElement.dataset.bannerMode = mode;
  try {
    localStorage.setItem(BANNER_MODE_KEY, mode);
  } catch {
    /* 忽略 */
  }
  syncSelected();
  document.dispatchEvent(new CustomEvent('melodyxz:banner-mode', { detail: { mode } }));
}

/** 把当前选中项同步到 UI（高亮 + aria-pressed） */
function syncSelected(): void {
  const root = document.documentElement;
  const theme = root.dataset.theme;
  const mode = root.dataset.bannerMode || 'default';

  for (const el of document.querySelectorAll<HTMLElement>('[data-theme-option]')) {
    el.setAttribute('aria-pressed', String(el.dataset.themeOption === theme));
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-banner-mode-option]')) {
    el.setAttribute('aria-pressed', String(el.dataset.bannerModeOption === mode));
  }
}

/**
 * 通用下拉：<div data-dropdown><button data-dropdown-toggle>…<div data-dropdown-menu hidden>
 *
 * 开合本身交给 scripts/popover.ts —— 一次只开一个面板，且用 .is-open 走 CSS 过渡；
 * 这里只负责「找到每一对触发器/面板」并把它们绑上。
 */
function bindDropdowns(): void {
  for (const wrap of document.querySelectorAll<HTMLElement>('[data-dropdown]')) {
    if (wrap.dataset.bound === '1') continue;

    const toggle = wrap.querySelector<HTMLElement>('[data-dropdown-toggle]');
    const menu = wrap.querySelector<HTMLElement>('[data-dropdown-menu]');
    if (!toggle || !menu) continue;

    wrap.dataset.bound = '1';
    bindPopover(toggle, menu);
  }
}

/** 把 <html> 上的状态同步成 localStorage 里的选择 */
function reapplyStored(): void {
  const state = resolveStoredState();
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  root.dataset.themeType = isDarkTheme(state.theme) ? 'dark' : 'light';
  root.dataset.bannerMode = state.mode;
}

interface ThemeState {
  theme: string;
  mode: BannerMode;
}

/**
 * 从 localStorage 解析出「应该是」的主题与 Banner 模式。
 * 拿不到（隐私模式 / 没存过）就回落到 SSR 写在 <html> 上的默认值。
 */
function resolveStoredState(fallbackRoot: HTMLElement = document.documentElement): ThemeState {
  const light = fallbackRoot.dataset.themeLight || 'garden';
  const dark = fallbackRoot.dataset.themeDark || 'dracula';

  let theme = fallbackRoot.dataset.theme || '';
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored && THEME_NAMES.includes(stored)) theme = stored;
  } catch {
    /* 隐私模式读不了，忽略 */
  }
  if (!THEME_NAMES.includes(theme)) theme = light;

  let mode = (fallbackRoot.dataset.bannerMode || 'default') as BannerMode;
  try {
    const storedMode = localStorage.getItem(BANNER_MODE_KEY);
    if (storedMode && BANNER_MODES.some((item) => item.mode === storedMode)) {
      mode = storedMode as BannerMode;
    }
  } catch {
    /* 忽略 */
  }
  if (!BANNER_MODES.some((item) => item.mode === mode)) mode = 'default';

  // 保底：theme 至少是有效的浅/深默认值之一
  if (!THEME_NAMES.includes(theme)) theme = dark && isDarkTheme(dark) ? dark : light;

  return { theme, mode };
}

/**
 * ClientRouter 换页时会把新文档里 SSR 的 <html data-theme="…"> 属性搬过来，
 * 而 `astro:page-load` 触发时页面往往**已经画过一帧**了 ——
 * 表现就是「换页/切主题后偶尔是错的配色或明暗，刷新一下才好」。
 *
 * 所以这里在 **before-swap**（新文档还没上屏）就把它改成正确的值，
 * 再在 **after-swap**（上屏前）兜一次底。两个事件都在 paint 之前。
 */
let swapHooksBound = false;
function bindSwapThemeHooks(): void {
  if (swapHooksBound) return;
  swapHooksBound = true;

  const patch = (target?: Element | null): void => {
    const root = (target as HTMLElement | null) ?? document.documentElement;
    if (!root) return;
    const { theme, mode } = resolveStoredState();
    root.dataset.theme = theme;
    root.dataset.themeType = isDarkTheme(theme) ? 'dark' : 'light';
    root.dataset.bannerMode = mode;
  };

  document.addEventListener('astro:before-swap', (event) => {
    // event.newDocument 是即将换上的文档，先把它改对，Swap 之后立刻就是正确主题
    const next = (event as unknown as { newDocument?: Document }).newDocument;
    patch(next?.documentElement ?? null);
  });

  document.addEventListener('astro:after-swap', () => {
    // 兜底：万一 before-swap 没拿到新文档
    reapplyStored();
  });
}

/* ---------------- 事件绑定（每次换页后重建） ---------------- */

onPageLoad(() => {
  // ClientRouter 换页时会把 <html> 的 data-* 恢复成服务端渲染的值，
  // 所以每次进页面都按 localStorage 重新应用一次 ——
  // 否则「换了配色 / 明暗，翻一页就复原」。
  // （真正的兜底在 bindSwapThemeHooks：before-swap / after-swap 阶段就改好，避免闪一帧）
  bindSwapThemeHooks();
  reapplyStored();
  // 配色按钮：<button data-theme-option="nord">
  for (const el of document.querySelectorAll<HTMLElement>('[data-theme-option]')) {
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    el.addEventListener('click', () => {
      const name = el.dataset.themeOption;
      if (name) setTheme(name);
    });
  }

  // 明暗一键切换：<button data-theme-toggle>
  for (const el of document.querySelectorAll<HTMLElement>('[data-theme-toggle]')) {
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    el.addEventListener('click', () => toggleTheme());
  }

  // Banner 模式按钮：<button data-banner-mode-option="hidden">
  for (const el of document.querySelectorAll<HTMLElement>('[data-banner-mode-option]')) {
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    el.addEventListener('click', () => {
      const mode = el.dataset.bannerModeOption as BannerMode | undefined;
      if (mode) setBannerMode(mode);
    });
  }

  bindDropdowns();
  syncSelected();
});
