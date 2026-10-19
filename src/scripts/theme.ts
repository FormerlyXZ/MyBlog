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

import { BANNER_MODES, DARK_THEMES, type BannerMode } from '../utils/theme';
import { onPageLoad } from './pageload';

export { BANNER_MODES, DARK_THEMES };
export type { BannerMode };

const THEME_KEY = 'theme';
const BANNER_MODE_KEY = 'banner-mode';

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

/** 通用下拉：<div data-dropdown><button data-dropdown-toggle>…<div data-dropdown-menu hidden> */
function bindDropdowns(): void {
  for (const wrap of document.querySelectorAll<HTMLElement>('[data-dropdown]')) {
    if (wrap.dataset.bound === '1') continue;
    wrap.dataset.bound = '1';

    const toggle = wrap.querySelector<HTMLElement>('[data-dropdown-toggle]');
    const menu = wrap.querySelector<HTMLElement>('[data-dropdown-menu]');
    if (!toggle || !menu) continue;

    const close = () => {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', (event) => {
      if (!menu.hidden && !wrap.contains(event.target as Node)) close();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    // 点菜单里的选项后自动收起
    menu.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-theme-option]')) close();
    });
  }
}

/* ---------------- 事件绑定（每次换页后重建） ---------------- */

onPageLoad(() => {
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
