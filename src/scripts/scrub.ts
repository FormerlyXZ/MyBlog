/**
 * 进度条 / 音量条的拖动小工具
 * ------------------------------------------------------------
 * 迷你碟片和音乐页都要用，所以单独放一份。
 * 用 Pointer Events（鼠标、触屏、手写笔一套逻辑）。
 */

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 把一个元素变成「按住拖动出 0~1 的比例」的滑条。
 *
 * 注意 onRatio 在拖动过程中会连续触发 —— 只用来**画**（更新进度填充、
 * 时间文字、歌词预览），真正 setCurrentTime 要等到 onEnd，
 * 否则每移动一像素就解一次码，烫手。
 *
 * @param el        可拖动的元素（要有确定宽度）
 * @param onRatio   比例变化时回调（按下、移动都会触发）
 * @param options   onStart 标记「正在拖」；onEnd 拿到松手时的最终比例
 */
export function bindScrubber(
  el: HTMLElement,
  onRatio: (ratio: number) => void,
  options: { onStart?: () => void; onEnd?: (ratio: number) => void } = {},
): void {
  let last = 0;

  const ratioOf = (event: PointerEvent): number => {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp01((event.clientX - rect.left) / rect.width);
  };

  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    options.onStart?.();
    last = ratioOf(event);
    onRatio(last);
  });

  el.addEventListener('pointermove', (event) => {
    if (!el.hasPointerCapture(event.pointerId)) return;
    last = ratioOf(event);
    onRatio(last);
  });

  const end = (event: PointerEvent): void => {
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    options.onEnd?.(last);
  };

  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
