/**
 * 左下角迷你碟片的界面逻辑
 * ============================================================
 * 只管「把状态画出来」和「把点击翻译成播放器指令」，
 * 播放本身都在 scripts/player.ts 里。
 *
 * 因为碟片是 transition:persist 的，换页时 DOM 不会重建，
 * 所以这里的事件只绑一次（用 dataset 做幂等），
 * 但每次换页都重新订阅一次状态，确保 UI 和播放器同步。
 * ============================================================
 */

import { onPageLoad } from './pageload';
import { bindScrubber, clamp01 } from './scrub';
import { mountWave } from './visualizer';
import {
  cycleMode,
  formatTime,
  getState,
  next,
  prev,
  seek,
  setVolume,
  subscribe,
  toggle,
  toggleMute,
  type PlayerSnapshot,
} from './player';

const MODE_META = {
  list: { selector: '.mp-mode-list', label: '列表循环' },
  one: { selector: '.mp-mode-one', label: '单曲循环' },
  shuffle: { selector: '.mp-mode-shuffle', label: '随机播放' },
} as const;

let root: HTMLElement | null = null;
let scrubbing = false;

function render(state: PlayerSnapshot): void {
  if (!root) return;

  const playing = state.playing;
  root.classList.toggle('is-playing', playing);

  /* ---- 封面 ---- */
  const cover = state.song?.cover ?? null;
  const face = root.querySelector<HTMLElement>('[data-mp-cover]');
  if (face) {
    if (cover) face.style.setProperty('--cover', `url("${cover}")`);
    else face.style.removeProperty('--cover');
  }

  const thumb = root.querySelector<HTMLElement>('[data-mp-thumb]');
  if (thumb) {
    const url = cover ?? state.playlist?.cover ?? null;
    const current = thumb.dataset.cover || '';
    if (url && url !== current) {
      thumb.dataset.cover = url;
      thumb.textContent = '';
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      thumb.appendChild(img);
    } else if (!url && current) {
      delete thumb.dataset.cover;
      thumb.innerHTML =
        '<svg class="h-5 w-5 text-base-content/40" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 2.2a6.8 6.8 0 110 13.6 6.8 6.8 0 010-13.6zM12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z"/></svg>';
    }
  }

  /* ---- 文本 ---- */
  const title = root.querySelector<HTMLElement>('[data-mp-title]');
  const artist = root.querySelector<HTMLElement>('[data-mp-artist]');
  const playlistLabel = root.querySelector<HTMLElement>('[data-mp-playlist]');

  if (title) title.textContent = state.song?.title ?? '还没有在播放';
  if (artist) {
    const bits = [state.song?.artist, state.song?.album].filter(Boolean);
    artist.textContent = bits.length ? bits.join(' · ') : '点碟片开始播放';
  }
  if (playlistLabel) playlistLabel.textContent = state.playlist?.name ?? '';

  /* ---- 进度 ---- */
  const duration = state.duration > 0 ? state.duration : 0;
  const ratio = duration > 0 ? clamp01(state.currentTime / duration) : 0;
  const pct = Math.round(ratio * 1000) / 10;

  const ring = root.querySelector<SVGCircleElement>('[data-mp-ring]');
  if (ring) ring.style.strokeDasharray = `${pct} ${100 - pct}`;

  const track = root.querySelector<HTMLElement>('[data-mp-seek]');
  if (track && !scrubbing) track.style.setProperty('--val', `${pct}%`);

  const currentLabel = root.querySelector<HTMLElement>('[data-mp-current]');
  const totalLabel = root.querySelector<HTMLElement>('[data-mp-total]');
  if (currentLabel) currentLabel.textContent = formatTime(state.currentTime);
  if (totalLabel) totalLabel.textContent = formatTime(duration);

  /* ---- 播放模式 ---- */
  const modeBtn = root.querySelector<HTMLElement>('[data-mp-mode]');
  if (modeBtn) {
    const meta = MODE_META[state.mode];
    for (const [key, value] of Object.entries(MODE_META)) {
      const icon = root.querySelector<HTMLElement>(value.selector);
      if (icon) icon.classList.toggle('is-shown', key === state.mode);
    }
    modeBtn.title = `播放模式：${meta.label}`;
    modeBtn.setAttribute('aria-label', `播放模式：${meta.label}`);
  }

  /* ---- 音量 ---- */
  const volumeFill = root.querySelector<HTMLElement>('[data-mp-volume-fill]');
  const volumeTrack = root.querySelector<HTMLElement>('[data-mp-volume]');
  const volPct = Math.round((state.muted ? 0 : state.volume) * 100);
  if (volumeTrack) volumeTrack.style.setProperty('--val', `${volPct}%`);
  if (volumeFill) volumeFill.style.width = `${volPct}%`;

  const muteBtn = root.querySelector<HTMLElement>('[data-mp-mute]');
  if (muteBtn) {
    const silent = state.muted || state.volume === 0;
    muteBtn.classList.toggle('is-on', silent);
    const on = muteBtn.querySelector<HTMLElement>('.mp-vol-on');
    const off = muteBtn.querySelector<HTMLElement>('.mp-vol-off');
    if (on) on.classList.toggle('is-shown', !silent);
    if (off) off.classList.toggle('is-shown', silent);
  }
}

function bind(): void {
  if (!root) return;

  /* 小窗里的律动：和音乐页同一个频谱，只是画得细一点 */
  const waveCanvas = root.querySelector<HTMLCanvasElement>('[data-mp-wave]');
  if (waveCanvas) {
    mountWave(waveCanvas, { points: 28, amplitude: 0.44, layers: 1, idle: 0.12, lineWidth: 1.2 });
  }

  root.querySelector<HTMLElement>('[data-mp-toggle]')?.addEventListener('click', () => toggle());
  root.querySelector<HTMLElement>('[data-mp-play]')?.addEventListener('click', () => toggle());
  root.querySelector<HTMLElement>('[data-mp-prev]')?.addEventListener('click', () => prev());
  root.querySelector<HTMLElement>('[data-mp-next]')?.addEventListener('click', () => next());
  root.querySelector<HTMLElement>('[data-mp-mute]')?.addEventListener('click', () => toggleMute());
  root.querySelector<HTMLElement>('[data-mp-mode]')?.addEventListener('click', () => cycleMode());

  /* 进度条拖动：拖动中只画，松手才真正跳转（避免一路解码卡顿） */
  const seekTrack = root.querySelector<HTMLElement>('[data-mp-seek]');
  const seekWrap = root.querySelector<HTMLElement>('[data-mp-progress]');
  if (seekTrack) {
    bindScrubber(
      seekTrack,
      (r) => {
        const state = getState();
        const duration = state.duration || 0;
        seekTrack.style.setProperty('--val', `${Math.round(r * 1000) / 10}%`);
        const currentLabel = root?.querySelector<HTMLElement>('[data-mp-current]');
        if (currentLabel) currentLabel.textContent = formatTime(r * duration);
      },
      {
        onStart: () => {
          scrubbing = true;
          seekWrap?.classList.add('is-scrubbing');
        },
        onEnd: (r) => {
          scrubbing = false;
          seekWrap?.classList.remove('is-scrubbing');
          const duration = getState().duration || 0;
          seek(Math.max(0, r * duration));
        },
      },
    );
  }

  /* 音量拖动 */
  const volumeTrack = root.querySelector<HTMLElement>('[data-mp-volume]');
  if (volumeTrack) {
    bindScrubber(volumeTrack, (r) => setVolume(r));
  }

  /* 触屏：右下角小箭头展开面板 */
  const expand = root.querySelector<HTMLElement>('[data-mp-expand]');
  expand?.addEventListener('click', (event) => {
    event.stopPropagation();
    root?.classList.toggle('is-open');
  });

  /* 点空白处收起（触屏用） */
  document.addEventListener('pointerdown', (event) => {
    if (!root?.classList.contains('is-open')) return;
    const target = event.target as Node | null;
    if (target && !root.contains(target)) root.classList.remove('is-open');
  });

  /* 键盘：空格 / 方向键在面板里也能用 */
  root.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'ArrowRight') {
      const state = getState();
      seek(Math.min((state.currentTime || 0) + 5, state.duration || 0));
    } else if (event.key === 'ArrowLeft') {
      const state = getState();
      seek(Math.max((state.currentTime || 0) - 5, 0));
    }
  });
}

function init(): void {
  const el = document.querySelector<HTMLElement>('[data-mp]');
  if (!el) return;

  root = el;

  if (el.dataset.mpBound !== '1') {
    el.dataset.mpBound = '1';
    bind();
    subscribe(({ type, state }) => {
      if (type === 'tick' && scrubbing) return;
      render(state);
    });
  }

  render(getState());
}

onPageLoad(init);
