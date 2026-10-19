/**
 * 导航弹层（配色 / Banner 模式 / 账号菜单）统一开合
 * ============================================================
 * 三件事：
 *   ① 一次只开一个 —— 打开新的会自动收起其它（点开「配色」时 Banner 面板自己关掉）
 *   ② 平滑开合 —— 靠 CSS 类 .is-open 驱动 opacity/transform 过渡，不再用 hidden 硬切
 *   ③ 点空白关 / 按 Esc 关
 *
 * 原来每个下拉各绑一套 document 监听（换页后旧节点还挂着，越翻页越多），
 * 现在集中在这里，document 级监听全站只绑一次。
 *
 * 约定：面板元素带 data-dropdown-menu 或 data-auth-menu，
 *       触发器带 data-dropdown-toggle 或 data-auth-toggle，两者在同一个外层包裹里。
 * ============================================================
 */

const OPEN_CLASS = 'is-open';
const MENU_SELECTOR = '[data-dropdown-menu], [data-auth-menu]';
const WRAP_SELECTOR = '[data-dropdown], .auth-user';
const TOGGLE_SELECTOR = '[data-dropdown-toggle], [data-auth-toggle]';

function allMenus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(MENU_SELECTOR));
}

/** 找到某个面板对应的触发器（同一个包裹里的那个按钮） */
function triggerOf(menu: HTMLElement): HTMLElement | null {
  const wrap = menu.closest<HTMLElement>(WRAP_SELECTOR) ?? menu.parentElement;
  return wrap?.querySelector<HTMLElement>(TOGGLE_SELECTOR) ?? null;
}

/** 收起所有面板（可以用 except 留一个） */
export function closePanels(except?: HTMLElement | null): void {
  for (const menu of allMenus()) {
    if (menu === except || !menu.classList.contains(OPEN_CLASS)) continue;
    menu.classList.remove(OPEN_CLASS);
    triggerOf(menu)?.setAttribute('aria-expanded', 'false');
  }
}

/** 打开某个面板（顺手把别的收掉） */
export function openPanel(menu: HTMLElement): void {
  closePanels(menu);
  menu.classList.add(OPEN_CLASS);
  triggerOf(menu)?.setAttribute('aria-expanded', 'true');
}

/** 收起某个面板 */
export function closePanel(menu: HTMLElement): void {
  menu.classList.remove(OPEN_CLASS);
  triggerOf(menu)?.setAttribute('aria-expanded', 'false');
}

let globalBound = false;

/** 点空白 / Esc 收起：document 级监听只绑一次 */
function ensureGlobal(): void {
  if (globalBound) return;
  globalBound = true;

  document.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (!target) return;
    for (const menu of allMenus()) {
      if (!menu.classList.contains(OPEN_CLASS)) continue;
      const wrap = menu.closest<HTMLElement>(WRAP_SELECTOR);
      if (wrap && !wrap.contains(target)) closePanel(menu);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanels();
  });
}

/**
 * 给一对「触发器 + 面板」绑好开合。
 * menu 上的 hidden 属性只用来挡「JS 还没跑起来」的那一下，绑上之后交给 CSS 过渡。
 */
export function bindPopover(toggle: HTMLElement, menu: HTMLElement): void {
  menu.hidden = false;
  menu.classList.remove(OPEN_CLASS);
  toggle.setAttribute('aria-expanded', 'false');

  toggle.addEventListener('click', (event) => {
    // 别让这次点击冒到 document，否则会立刻又被「点空白收起」关掉
    event.stopPropagation();
    if (menu.classList.contains(OPEN_CLASS)) closePanel(menu);
    else openPanel(menu);
  });

  // 点面板里的选项（配色小卡 / Banner 模式）后自动收起
  menu.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-theme-option], [data-banner-mode-option], [data-popover-close]')) {
      closePanel(menu);
    }
  });

  ensureGlobal();
}
