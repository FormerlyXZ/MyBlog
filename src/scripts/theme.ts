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
 * 持久化：
 *   localStorage['theme']        当前这套（换页 / 刷新恢复用）
 *   localStorage['theme-light']  浅色那支上次挑的那套
 *   localStorage['theme-dark']   深色那支上次挑的那套（一键切换靠这两条来回翻）
 *   localStorage['banner-mode']  Banner 形态
 * 防闪屏：BaseLayout 的 <head> 里有一段 inline 脚本先跑（本文件只负责后续切换）
 *
 * 明暗一键切换（data-theme-toggle）带一段「波纹扩散」过渡：
 * 新配色从按钮（波源）像水波一样摊满整屏，实现在 scripts/theme-wave.ts。
 *
 * 清单本身在 src/utils/theme.ts（纯数据，服务端也要用）。
 * ============================================================
 */

import { BANNER_MODES, DARK_THEMES, THEME_LIST, type BannerMode } from '../utils/theme';
import { onPageLoad } from './pageload';
import { bindPopover } from './popover';
import { playThemeWave, waveOrigin } from './theme-wave';

export { BANNER_MODES, DARK_THEMES };
export type { BannerMode };

const THEME_KEY = 'theme';
/**
 * 「浅色那支上次用的是哪套 / 深色那支上次用的是哪套」。
 * 只有 THEME_KEY 的话，一键切换永远只会回到站点默认的 garden / dracula ——
 * 手动挑过的 sunset、nord 就被丢掉了。所以两支各记一份：
 *   theme-light = nord      theme-dark = sunset
 * 一键切换时「切到哪一支，就用那一支上次挑的那套」。
 */
const LIGHT_THEME_KEY = 'theme-light';
const DARK_THEME_KEY = 'theme-dark';
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

/** 记住「这一支（浅 / 深）上次用的是哪套」，供一键切换回来时用 */
function rememberTheme(name: string): void {
  if (!THEME_NAMES.includes(name)) return;
  try {
    localStorage.setItem(isDarkTheme(name) ? DARK_THEME_KEY : LIGHT_THEME_KEY, name);
  } catch {
    /* 隐私模式下写不了，忽略 */
  }
}

/**
 * 取「这一支上次用的那套」。
 * 没记过（第一次用、清了缓存）就回落到 config/site.json 里配的默认浅 / 深色。
 */
function recallTheme(type: 'light' | 'dark'): string {
  const { light, dark } = defaults();
  const fallback = type === 'dark' ? dark : light;
  try {
    const stored = localStorage.getItem(type === 'dark' ? DARK_THEME_KEY : LIGHT_THEME_KEY);
    // 只在「确实属于这一支」时采用，免得旧数据或手改的脏值把明暗切反
    if (stored && THEME_NAMES.includes(stored) && isDarkTheme(stored) === (type === 'dark')) {
      return stored;
    }
  } catch {
    /* 忽略 */
  }
  return THEME_NAMES.includes(fallback) ? fallback : type === 'dark' ? 'dracula' : 'garden';
}

/** 真正把配色写到 <html> 上（不带过渡动画的那一步） */
function applyTheme(name: string, persist: boolean): void {
  const root = document.documentElement;
  root.dataset.theme = name;
  root.dataset.themeType = isDarkTheme(name) ? 'dark' : 'light';
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, name);
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
    // 顺手把「这一支上次用的是哪套」记下来（一键切换回来时用）
    rememberTheme(name);
  }
  syncSelected();
  document.dispatchEvent(new CustomEvent('melodyxz:theme', { detail: { theme: name } }));
}

/** 切换配色时，波纹从哪扩散（见 scripts/theme-wave.ts） */
export interface ThemeSwitchOptions {
  /** 触发切换的元素：键盘触发时用它当波源 */
  source?: Element | null;
  /** 触发事件：鼠标 / 手指点击时取点击坐标当波源 */
  event?: Event | null;
  /** 关掉波纹直接切（初始化、换页恢复这类场景用） */
  wave?: boolean;
}

/**
 * 切换配色并持久化。
 * 默认播放「波纹扩散」：新配色从波源（按钮 / 点击点）像水波一样摊满整屏。
 */
export function setTheme(name: string, persist = true, options: ThemeSwitchOptions = {}): void {
  const apply = (): void => applyTheme(name, persist);

  // 配色没变就别播动画（点中当前那套时闪一下反而怪）
  if (options.wave === false || name === document.documentElement.dataset.theme) {
    apply();
    return;
  }

  playThemeWave(apply, waveOrigin(options.event, options.source));
}

/**
 * 在「浅色」和「深色」之间切换。
 *
 * 记住两支各自上次用的那套，而不是每次都跳回默认值：
 *   挑了 sunset（深）→ 切到浅色 → 再切回深色，回到的是 sunset，不是 dracula。
 * 切换前先把「当前这套」记回它自己那一支（第一次切换时那一支还没有记忆）。
 *
 * 传入点击事件与按钮本身，波纹就从按钮处扩散出去。
 */
export function toggleTheme(options: ThemeSwitchOptions = {}): void {
  const current = document.documentElement.dataset.theme || '';
  const targetType = isDarkTheme(current) ? 'light' : 'dark';

  // 先记住当前这套：第一次切换时目标那一支还没记忆，回来时就不会丢
  rememberTheme(current);

  const next = recallTheme(targetType);
  setTheme(next, true, options);
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

/** 把 <html> 上的状态同步成 localStorage 里的选择（换页恢复用，不播动画） */
function reapplyStored(): void {
  const state = resolveStoredState();
  const root = document.documentElement;
  applyTheme(state.theme, false);
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
  // 这里不播波纹：点完弹层要收起，波纹会把「正在淡出的面板」冻在快照里 0.5 秒
  for (const el of document.querySelectorAll<HTMLElement>('[data-theme-option]')) {
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    el.addEventListener('click', () => {
      const name = el.dataset.themeOption;
      if (name) setTheme(name, true, { wave: false });
    });
  }

  // 明暗一键切换：<button data-theme-toggle>（桌面 / 移动各一个）
  // 波纹从被点的那个按钮处扩散，所以把事件和元素一起传进去
  for (const el of document.querySelectorAll<HTMLElement>('[data-theme-toggle]')) {
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    el.addEventListener('click', (event) => toggleTheme({ event, source: el }));
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
