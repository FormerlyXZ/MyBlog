/**
 * 导航（顶部胶囊）隐现：滚动 + 鼠标召唤
 * ============================================================
 * 两路输入，合成一个「收不收起」：
 *
 * ① 滚动：向下滚且累计位移 > 80px → 收起；一往上滚 → 立刻恢复；
 *    位移 < 5px 的抖动直接忽略（移动端回弹、触摸板微动不触发）。
 * ② 鼠标召唤：分界线是 Banner 里那行大标题「MelodyZzX's Blog」——
 *    · 指针在标题**之上**（含页面顶部那条带子）→ 导航常驻：不收起，
 *      也不跟滚动较劲；
 *    · 指针滑过标题、落到标题下面（横幅、正文都算）→ 让位收起来；
 *    · 再往上回到标题之上 → 立刻唤回。
 *    标题被滚出视口后，这条分界线不会再低于顶部那条召唤带（SUMMON_ZONE），
 *    于是自然退化成「贴到页面顶部才唤回」。
 *    每页都生效（工具页没有横幅标题，就只有顶部那条召唤带）。
 *
 * 三种「不能被收起」的例外：
 *   · 指针压在导航胶囊或它展开的下拉面板上（不然点不到）；
 *   · 有下拉面板开着（面板挂在导航上，跟着一起收起来就点不到了）；
 *   · 键盘用户：焦点进了导航就强制显示（Tab 过去时不能是个隐形的东西）。
 *     只有「Tab 进去」才算 —— 鼠标点完按钮焦点会留在按钮上，
 *     那时候还锁着不收，等于用鼠标点过一次导航以后就再也不让位了。
 *
 * 第四种例外：竖屏的悬浮目录（.toc-float）正展开着。
 *   它钉在屏幕顶上，正好把「鼠标移到最上面把导航召唤回来」的那条带子盖住了 ——
 *   于是鼠标点导航，点头点到的是目录面板（触屏更是连点都点不到，只能靠滚）。
 *   所以目录展开期间导航一直待着（目录也会自动往下让位），
 *   收起成小胶囊之后恢复原来的「滚动/悬停躲开」。
 *   状态由 scripts/toc.ts 通过 html.toc-float-open + melodyxz:toc-float 事件广播。
 *
 * 手指（pointerType === 'touch'）不参与鼠标那套：没有 hover，
 * 碰一下就收起只会碍事，触屏上还是只看滚动。
 *
 * 重算时机：滚动 / 指针移动 / 窗口缩放。滚动也要重算 ——
 * 滚动时标题和 Banner 会从静止的指针底下挪走，只靠 pointermove 会留下过时的判断。
 * ============================================================
 */

import { onPageLoad, onBeforeSwap } from './pageload';

/** 向下滚超过这个距离才收起 */
const THRESHOLD = 80;

/** 小于这个位移的抖动忽略 */
const MIN_DELTA = 5;

/** 召唤带的高度：指针离页面顶部多近一定算「在标题之上」 */
const SUMMON_ZONE = 110;

interface PointerPos {
  x: number;
  y: number;
}

let cleanup: (() => void) | null = null;

export function initNav(): void {
  // 上一轮的监听先拆掉（换页后会重新初始化）
  cleanup?.();
  cleanup = null;

  const shell = document.querySelector<HTMLElement>('[data-nav-shell]');
  if (!shell) return;

  let lastY = window.scrollY;
  let scrollHidden = false; // 向下滚动 → 收起
  let pointerAway = false; // 指针滑过标题、落到它下面 → 让位
  let heldFocus: Element | null = null; // 键盘送进来、还握着焦点的那个控件
  let pointer: PointerPos | null = null; // 最后一次指针位置（视口坐标）
  let viaPointer = false; // 最近一次操作是鼠标点的还是键盘敲的
  let waiting = false; // rAF 节流

  /**
   * 「常驻线」：指针在这条线之上时导航一直待着，越过它才让位。
   * 就是 Banner 里那行大标题的下边缘 —— 指针还没滑过「MelodyZzX's Blog」
   * 说明用户要么在往导航那边去、要么就在看标题，这时候不该把导航撤走。
   * 标题被滚出视口后这条线不会低于顶部召唤带（SUMMON_ZONE），
   * 于是自然退化成「贴到页面顶部才唤回」。
   */
  const residentLine = (): number => {
    const title = document.querySelector<HTMLElement>('[data-banner] .banner__title');
    if (!title) return SUMMON_ZONE;
    const rect = title.getBoundingClientRect();
    if (rect.height <= 0) return SUMMON_ZONE;
    return Math.max(rect.bottom, SUMMON_ZONE);
  };

  /** 导航里有没有展开着的下拉面板（配色 / Banner 模式 / 账号） */
  const panelOpen = (): boolean => Boolean(shell.querySelector('.is-open'));

  /**
   * 竖屏悬浮目录是不是正展开着（scripts/toc.ts 给 <html> 挂的标记）。
   * 展开着的目录面板盖住了屏幕顶部那条「召唤带」，鼠标也好手指也好，
   * 想点导航都得先让目录让开 —— 所以这段时间导航干脆不躲。
   */
  const tocFloatHold = (): boolean => document.documentElement.classList.contains('toc-float-open');

  /** 指针是不是已经滑过标题、该把导航让出去了 */
  const pointerAwayFromLine = (p: PointerPos | null): boolean => {
    if (!p) return false;
    // 还在常驻线之上（标题上方）：不动
    if (p.y <= residentLine()) return false;
    // 面板开着就先别动（它挂在导航下面，看不到面板就没法选）
    if (panelOpen()) return false;
    // 悬浮目录展开着：它压着顶部，收起来就点不到了
    if (tocFloatHold()) return false;
    // 指针其实压在导航胶囊或它展开的面板上：不能收，否则点不到
    const under = document.elementFromPoint(p.x, p.y);
    return !(under && shell.contains(under));
  };

  /** 键盘送上来的焦点是不是还站在原地（还在导航里就锁住不收） */
  const focusHeld = (): boolean => heldFocus !== null && document.activeElement === heldFocus;

  const render = (): void => {
    shell.classList.toggle('is-hidden', !focusHeld() && (scrollHidden || pointerAway));
  };

  /** 把所有输入重算一遍 —— 滚动、指针、缩放都走这里 */
  const update = (): void => {
    waiting = false;
    const y = window.scrollY;

    // 指针停在常驻线之上（标题上方）：导航该一直待着，不跟滚动较劲
    const resident = pointer !== null && pointer.y <= residentLine();

    if (Math.abs(y - lastY) >= MIN_DELTA) {
      scrollHidden = y > lastY && y > THRESHOLD;
      lastY = y;
    }
    // 指针停在顶部召唤带 / 悬浮目录展开着：滚动也别收
    if (resident || tocFloatHold()) scrollHidden = false;

    pointerAway = pointerAwayFromLine(pointer);
    render();
  };

  const schedule = (): void => {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(update);
  };

  /**
   * 悬浮目录的展开 / 收起（scripts/toc.ts 广播）
   * ---------------------------------------------------------------
   * 这里刻意**同步**重算，不走 schedule：目录面板的「让位距离」
   * （--toc-float-y）是跟着导航的 is-hidden 算的，两件事必须落在同一帧，
   * 不然面板会先滑到屏幕顶上、下一帧再往下跳一下。
   */
  const onTocFloat = (): void => {
    update();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  };

  /** 指针离开窗口：别再拿旧坐标判断 */
  const onPointerLeave = (): void => {
    pointer = null;
    schedule();
  };

  // 焦点是不是「键盘」送上来的：鼠标点按钮也会让按钮拿到焦点，
  // 那种不算（见文件头的说明），否则用鼠标点过一次导航就再也不让位了。
  const onPointerDown = (): void => {
    viaPointer = true;
  };

  const onKeyDown = (): void => {
    viaPointer = false;
  };

  const onFocusIn = (): void => {
    // 只有「键盘送上来的焦点」才锁住导航；鼠标点出来的焦点不算，
    // 否则用鼠标点过一次导航，之后它就一直不肯让位了。
    if (!viaPointer) heldFocus = document.activeElement;
    render();
  };

  const onFocusOut = (event: FocusEvent): void => {
    // 焦点还在导航内部（Tab 走到下一个控件）：锁继续有效
    const next = event.relatedTarget as Node | null;
    if (next && shell.contains(next)) return;
    heldFocus = null;
    render();
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('keydown', onKeyDown);
  // 悬浮目录展开 / 收起 / 变动（scripts/toc.ts 广播）：跟着重算要不要待着
  document.addEventListener('melodyxz:toc-float', onTocFloat);
  document.documentElement.addEventListener('pointerleave', onPointerLeave);
  shell.addEventListener('focusin', onFocusIn);
  shell.addEventListener('focusout', onFocusOut);

  cleanup = () => {
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('melodyxz:toc-float', onTocFloat);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    shell.removeEventListener('focusin', onFocusIn);
    shell.removeEventListener('focusout', onFocusOut);
    shell.classList.remove('is-hidden');
  };
}

onBeforeSwap(() => {
  cleanup?.();
  cleanup = null;
});

onPageLoad(initNav);
