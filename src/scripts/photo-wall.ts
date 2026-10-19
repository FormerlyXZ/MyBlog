/**
 * 照片墙：按 ?id 显示对应相册 + 灯箱
 * ============================================================
 * 相册 HTML 是服务端渲染好的（每个相册一个 <section data-pw-album>），
 * 这里只做三件事：
 *   ① 读 ?id，显示对应相册（找不到就显示第一个）
 *   ② 把相册标题/副标题填到页头
 *   ③ 灯箱：点击放大、左右切换、Esc 关闭
 *
 * 键盘：← → 切换，Esc 关闭（dialog 自带 Esc）。
 */

import { onPageLoad, onBeforeSwap } from './pageload';

let keyHandler: ((event: KeyboardEvent) => void) | null = null;

function initWall(): void {
  const root = document.querySelector<HTMLElement>('[data-photo-wall]');
  if (!root) return;

  const sections = [...root.querySelectorAll<HTMLElement>('[data-pw-album]')];
  if (!sections.length) return;

  // ① 决定显示哪个相册
  const id = new URLSearchParams(location.search).get('id');
  const target = sections.find((section) => section.dataset.pwAlbum === id) ?? sections[0];
  for (const section of sections) section.hidden = section !== target;

  // ② 页头文案
  const eventEl = root.querySelector<HTMLElement>('[data-pw-event]');
  const subtitleEl = root.querySelector<HTMLElement>('[data-pw-subtitle]');
  const heading = target.getAttribute('aria-label') ?? '照片墙';
  if (eventEl) eventEl.textContent = heading;
  if (subtitleEl) {
    const photos = target.querySelectorAll('[data-pw-photo]').length;
    subtitleEl.textContent = `${photos} 张照片`;
  }

  // ③ 灯箱
  const dialog = root.querySelector<HTMLDialogElement>('[data-pw-lightbox]');
  const img = root.querySelector<HTMLImageElement>('[data-pw-lightbox-img]');
  const caption = root.querySelector<HTMLElement>('[data-pw-lightbox-caption]');
  if (!dialog || !img) return;

  const photos = [...target.querySelectorAll<HTMLButtonElement>('[data-pw-photo]')];
  let current = 0;

  const show = (index: number) => {
    if (!photos.length) return;
    current = (index + photos.length) % photos.length;
    const btn = photos[current]!;
    img.src = btn.dataset.pwSrc ?? '';
    img.alt = btn.dataset.pwTitle || `照片 ${current + 1}`;
    if (caption) {
      const title = btn.dataset.pwTitle ?? '';
      const desc = btn.dataset.pwDesc ?? '';
      caption.textContent = [title, desc].filter(Boolean).join(' · ') || `${current + 1} / ${photos.length}`;
    }
  };

  for (const btn of photos) {
    if (btn.dataset.bound === '1') continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      show(Number(btn.dataset.pwIndex ?? 0));
      if (!dialog.open) dialog.showModal();
    });
  }

  root.querySelector('[data-pw-prev]')?.addEventListener('click', () => show(current - 1));
  root.querySelector('[data-pw-next]')?.addEventListener('click', () => show(current + 1));
  root.querySelector('[data-pw-close]')?.addEventListener('click', () => dialog.close());

  // 点遮罩区域关闭
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  // 键盘左右切换（Esc 由 <dialog> 自己处理）
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = (event: KeyboardEvent) => {
    if (!dialog.open) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      show(current - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      show(current + 1);
    }
  };
  document.addEventListener('keydown', keyHandler);
}

onBeforeSwap(() => {
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
});

onPageLoad(initWall);
