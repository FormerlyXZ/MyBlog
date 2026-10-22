/**
 * 音乐页交互
 * ============================================================
 * 只做五件事：
 *   ① 把播放器状态画到唱机 / 控制条上（数据在 scripts/player.ts）
 *   ② 渲染播放列表（多歌单切换 + 搜索 + 悬停预览封面）
 *   ③ 解析并滚动歌词（时间轴跟随 + 拖拽跳转 + 点亮当前句）
 *   ④ 从封面里取色，喂给整块毛玻璃
 *   ⑤ 全屏播放（桌面铺满视口；竖屏走三级歌词）
 * ============================================================
 */

import { onBeforeSwap, onPageLoad } from './pageload';
import { bindScrubber, clamp01 } from './scrub';
import { mountWave, type WaveHandle } from './visualizer';
import {
  cycleMode,
  formatTime,
  getState,
  next,
  playSong,
  prev,
  seek,
  setPlaylist,
  setVolume,
  subscribe,
  toggle,
  toggleMute,
  type PlayerSnapshot,
  type PlayerSong,
} from './player';

const MODE_META = {
  list: { selector: '.mp-mode-list', label: '列表循环' },
  one: { selector: '.mp-mode-one', label: '单曲循环' },
  shuffle: { selector: '.mp-mode-shuffle', label: '随机播放' },
} as const;

interface LyricLine {
  time: number | null;
  text: string;
}

/* ---------------- 模块状态 ---------------- */

let root: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let spin: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let playlistsEl: HTMLElement | null = null;
let filterInput: HTMLInputElement | null = null;
let tabsEl: HTMLElement | null = null;

let lyricsBox: HTMLElement | null = null;
let lyricsViewport: HTMLElement | null = null;
let lyricsInner: HTMLElement | null = null;
let jumpBtn: HTMLButtonElement | null = null;
let jumpLabel: HTMLElement | null = null;
let followBtn: HTMLButtonElement | null = null;
let bgLayers: Array<HTMLElement | null> = [null, null];

/** 竖屏全屏第一级那条 3 行歌词预览 */
let lyricBarEl: HTMLElement | null = null;
const barLines: {
  prev: HTMLElement | null;
  cur: HTMLElement | null;
  next: HTMLElement | null;
} = { prev: null, cur: null, next: null };

/* ---- 全屏：0 正常 / 1 全屏播放 / 2 全屏歌词 / 3 纯歌词 ---- */
type FsStage = 0 | 1 | 2 | 3;
let fsStage: FsStage = 0;
let fsPrevView: 'list' | 'lyrics' = 'list';

let unsubscribe: (() => void) | null = null;
let globalBound = false;
let wave: WaveHandle | null = null;

let currentView: 'list' | 'lyrics' = 'list';
let activeFilter = '';
let listKey = '';
let scrubbing = false;

/** 歌词：按歌曲 id 存原始文本（来自页面那份带歌词的 payload） */
const lyricsBySong = new Map<string, string>();

let lyricLines: LyricLine[] = [];
let lyricEls: HTMLElement[] = [];
/** 每一句在 inner 坐标系里的纵向中心，换行 / 换字号后重算 */
let lyricCenters: number[] = [];
let lyricActive = -1;
let activeEl: HTMLElement | null = null;
let lyricsForSong: string | null = null;

/* ---- 滚动：只记「整块该挪到哪」，句子各自的错峰归位在 moveBlock 里做 ---- */
let shift = 0;
let frameRaf = 0;
let lastFrame = 0;

/* ---- 手动拖拽 ---- */
let manual = false;
let focusIndex = 0;
let dragPointer: number | null = null;
let dragArmed = false;
let dragActive = false;
let dragStartY = 0;
let dragStartX = 0;
let dragOrigin = 0;
/** 拖完不操作的话，过一会儿自己回到正在唱的那句 */
let manualTimer = 0;
const MANUAL_HOLD = 5200;

/* ---- 字号 ---- */
const LYRIC_SIZES = [1.35, 1.6, 1.875, 2.2, 2.6];
const LYRIC_SIZE_KEY = 'melodyxz-lyric-size';
let sizeIndex = 2;

/** 页面是不是还挂在文档里（换页之后旧引用就不该再响应全局事件） */
function isMounted(): boolean {
  return Boolean(root && document.contains(root));
}

/* ---------------- LRC 解析 ---------------- */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * 解析歌词文本。
 * 支持 [mm:ss.xx] 时间轴（一行多个也可以）、[offset:] 校正，
 * 没有时间轴就当纯文本歌词（只滚动，不高亮）。
 */
export function parseLyrics(raw: string): { lines: LyricLine[]; synced: boolean } {
  const text = (raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { lines: [], synced: false };

  const lines: LyricLine[] = [];
  let offsetMs = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = /^\[(ti|ar|al|by|au|length|offset):(.*)\]$/i.exec(line);
    if (meta) {
      if (meta[1]!.toLowerCase() === 'offset') offsetMs = Number(meta[2]) || 0;
      continue;
    }

    TIME_TAG.lastIndex = 0;
    const times: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = TIME_TAG.exec(line)) !== null) {
      const minutes = Number(match[1]) || 0;
      const seconds = Number(match[2]) || 0;
      const fractionRaw = match[3] ?? '';
      const fraction = fractionRaw ? Number(fractionRaw) / 10 ** fractionRaw.length : 0;
      times.push(minutes * 60 + seconds + fraction);
    }

    const content = line.replace(TIME_TAG, '').trim();
    if (!times.length) {
      lines.push({ time: null, text: content });
      continue;
    }
    for (const time of times) lines.push({ time, text: content });
  }

  const synced = lines.some((item) => item.time !== null);
  if (synced) {
    lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    if (offsetMs) {
      for (const item of lines) {
        if (item.time !== null) item.time = Math.max(0, item.time - offsetMs / 1000);
      }
    }
  }

  return { lines, synced };
}

/* ---------------- 数据 ---------------- */

function readPageData(): void {
  if (lyricsBySong.size) return;
  const node = document.getElementById('music-page-data');
  if (!node) return;
  try {
    const parsed = JSON.parse(node.textContent || '{}') as {
      playlists?: Array<{ songs?: Array<{ id?: string; lyrics?: string }> }>;
    };
    for (const playlist of parsed.playlists ?? []) {
      for (const song of playlist.songs ?? []) {
        if (song?.id && song.lyrics) lyricsBySong.set(song.id, song.lyrics);
      }
    }
  } catch {
    /* 数据坏了就当作没有歌词 */
  }
}

function q<T extends Element>(selector: string): T | null {
  return root ? root.querySelector<T>(selector) : null;
}

/* ---------------- 封面取色 → 毛玻璃底色 ---------------- */

interface Palette {
  hue: number;
  base: string;
  base2: string;
  glow: string;
  glow2: string;
}

const paletteCache = new Map<string, Palette | null>();
let paletteUrl = '';
let lastCover = '';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rgbToHue(r: number, g: number, b: number, max: number, min: number): number | null {
  if (max === min) return null;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

const cssRgb = (rgb: [number, number, number]): string => `${rgb[0]} ${rgb[1]} ${rgb[2]}`;

/**
 * 从封面缩略图里取一组颜色。
 *
 * 权重 = 饱和度^1.4 ×（1 - 亮度×0.55）：
 * 浅色 / 灰白色封面里那些深色、饱和的块会被放大，
 * 所以「白色封面 + 一点深蓝」也能调出一块够深、够有颜色的玻璃。
 * 色相用圆周平均取，避免 350° 和 10° 平均成 180°。
 */
function sampleCover(img: HTMLImageElement): Palette | null {
  const N = 28;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, N, N);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, N, N).data;
  } catch {
    return null; // 跨域图片画不进 canvas
  }

  let weight = 0;
  let satSum = 0;
  let sinSum = 0;
  let cosSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 128) continue;
    const r = (data[i] ?? 0) / 255;
    const g = (data[i + 1] ?? 0) / 255;
    const b = (data[i + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);

    const w = s ** 1.4 * (1 - l * 0.55) + 0.003;
    weight += w;
    satSum += s * w;

    const hue = rgbToHue(r, g, b, max, min);
    if (hue !== null) {
      const hw = w * s;
      sinSum += Math.sin((hue * Math.PI) / 180) * hw;
      cosSum += Math.cos((hue * Math.PI) / 180) * hw;
    }
  }

  if (!weight) return null;

  const avgSat = satSum / weight;
  const hue = sinSum || cosSum ? (((Math.atan2(sinSum, cosSum) * 180) / Math.PI) + 360) % 360 : 265;
  // 玻璃底色要「有颜色但很沉」：彩度封顶，亮度压到 15% 左右，
  // 这样白字永远是白的，而且不管封面多花哨都不会变成一块糖果色。
  const sat = clamp(avgSat * 1.05 + 0.08, 0.12, 0.28);

  return {
    hue: Math.round(hue),
    base: cssRgb(hslToRgb(hue, sat, 0.145)),
    base2: cssRgb(hslToRgb(hue, sat * 0.9, 0.09)),
    glow: cssRgb(hslToRgb(hue, Math.min(0.5, sat + 0.12), 0.34)),
    glow2: cssRgb(hslToRgb((hue + 38) % 360, sat * 0.85, 0.28)),
  };
}

const FALLBACK_PALETTE: Palette = {
  hue: 265,
  base: '28 30 38',
  base2: '16 17 22',
  glow: '96 100 118',
  glow2: '58 64 82',
};

function writePalette(palette: Palette | null): void {
  if (!root) return;
  const p = palette ?? FALLBACK_PALETTE;
  const style = root.style;
  style.setProperty('--mu-hue', String(p.hue));
  style.setProperty('--mu-base', p.base);
  style.setProperty('--mu-base2', p.base2);
  style.setProperty('--mu-glow', p.glow);
  style.setProperty('--mu-glow2', p.glow2);
}

function applyCoverPalette(url: string): void {
  paletteUrl = url;
  if (!url) {
    writePalette(null);
    return;
  }
  const cached = paletteCache.get(url);
  if (cached !== undefined) {
    writePalette(cached);
    return;
  }
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    let palette: Palette | null = null;
    try {
      palette = sampleCover(img);
    } catch {
      palette = null;
    }
    paletteCache.set(url, palette);
    if (paletteUrl === url) writePalette(palette);
  };
  img.onerror = () => {
    paletteCache.set(url, null);
    if (paletteUrl === url) writePalette(null);
  };
  img.src = url;
}

/* ---------------- 渲染 ---------------- */

/** 两张模糊封面叠着淡入淡出，换歌时底色不会「啪」地跳一下 */
let bgFlip = false;
function crossfadeBackdrop(url: string): void {
  const [a, b] = bgLayers;
  if (!a || !b) return;
  bgFlip = !bgFlip;
  const nextLayer = bgFlip ? b : a;
  const prevLayer = bgFlip ? a : b;
  nextLayer.style.backgroundImage = url ? `url("${url}")` : '';
  nextLayer.classList.toggle('is-on', Boolean(url));
  prevLayer.classList.remove('is-on');
}

function renderCovers(song: PlayerSong | null, playlistCover?: string): void {
  if (!root) return;
  const url = song?.cover || playlistCover || '';
  if (url) root.style.setProperty('--cover', `url("${url}")`);
  else root.style.removeProperty('--cover');

  if (url !== lastCover) {
    lastCover = url;
    crossfadeBackdrop(url);
    applyCoverPalette(url);
  }
}

function renderProgress(state: PlayerSnapshot): void {
  if (scrubbing) return;

  const duration = state.duration || 0;
  const ratio = duration > 0 ? clamp01(state.currentTime / duration) : 0;
  const pct = `${Math.round(ratio * 1000) / 10}%`;

  const track = q<HTMLElement>('[data-mu-seek]');
  if (track) track.style.setProperty('--val', pct);

  const current = q<HTMLElement>('[data-mu-current]');
  if (current) current.textContent = formatTime(state.currentTime);

  const total = q<HTMLElement>('[data-mu-total]');
  if (total) total.textContent = formatTime(duration);
}

function renderControls(state: PlayerSnapshot): void {
  const modeBtn = q<HTMLElement>('[data-mu-mode]');
  if (modeBtn) {
    for (const [key, value] of Object.entries(MODE_META)) {
      q<HTMLElement>(value.selector)?.classList.toggle('is-shown', key === state.mode);
    }
    const label = MODE_META[state.mode].label;
    modeBtn.title = `播放模式：${label}`;
    modeBtn.setAttribute('aria-label', `播放模式：${label}`);
  }

  const silent = state.muted || state.volume === 0;
  q<HTMLElement>('[data-mu-mute]')?.classList.toggle('is-on', silent);
  q<HTMLElement>('.mp-vol-on')?.classList.toggle('is-shown', !silent);
  q<HTMLElement>('.mp-vol-off')?.classList.toggle('is-shown', silent);

  const volPct = `${Math.round((silent ? 0 : state.volume) * 100)}%`;
  q<HTMLElement>('[data-mu-volume]')?.style.setProperty('--val', volPct);
  const volFill = q<HTMLElement>('[data-mu-volume-fill]');
  if (volFill) volFill.style.width = volPct;
}

function renderNowPlaying(state: PlayerSnapshot): void {
  const title = q<HTMLElement>('[data-mu-title]');
  if (title) title.textContent = state.song?.title ?? '挑一首歌开始';

  const artist = q<HTMLElement>('[data-mu-artist]');
  if (artist) artist.textContent = state.song?.artist ?? '';

  const album = q<HTMLElement>('[data-mu-album]');
  if (album) {
    const value = state.song?.album ?? '';
    album.textContent = value;
    album.hidden = !value;
  }

  const count = q<HTMLElement>('[data-mu-count]');
  if (count) count.textContent = String(state.playlist?.songs.length ?? 0);

  stage?.classList.toggle('is-playing', state.playing);
  root?.classList.toggle('is-playing', state.playing);
}

function renderPlaylists(state: PlayerSnapshot): void {
  if (!playlistsEl) return;
  if (state.playlists.length <= 1) {
    playlistsEl.hidden = true;
    playlistsEl.innerHTML = '';
    return;
  }
  playlistsEl.hidden = false;
  playlistsEl.innerHTML = state.playlists
    .map(
      (playlist) => `
        <button type="button" class="mu-playlist${playlist.id === state.playlistId ? ' is-active' : ''}" data-playlist="${escapeAttr(playlist.id)}">
          <span>${escapeHtml(playlist.name)}</span>
          <span class="mu-playlist__count">${playlist.songs.length}</span>
        </button>`,
    )
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function renderList(state: PlayerSnapshot): void {
  if (!listEl) return;
  const songs = state.playlist?.songs ?? [];
  const keyword = activeFilter.trim().toLowerCase();
  const visible = keyword
    ? songs.filter((song) =>
        `${song.title} ${song.artist} ${song.album ?? ''}`.toLowerCase().includes(keyword),
      )
    : songs;

  const key = `${state.playlistId}|${keyword}`;
  if (key === listKey) {
    // 只是换了当前播放的歌：更新高亮就行，别整块重画（避免打断悬停预览）
    for (const row of listEl.querySelectorAll<HTMLElement>('[data-song]')) {
      row.classList.toggle('is-active', row.dataset.song === state.songId);
    }
    return;
  }
  listKey = key;

  if (!visible.length) {
    listEl.innerHTML = '<div class="ma-empty" style="margin-top:.5rem">没有匹配的歌</div>';
    return;
  }

  listEl.innerHTML = visible
    .map((song, index) => {
      const active = song.id === state.songId;
      const cover = song.cover
        ? `<img src="${escapeAttr(song.cover)}" alt="" loading="lazy" decoding="async">`
        : '<svg class="h-4 w-4 text-base-content/30" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 2.2a6.8 6.8 0 110 13.6 6.8 6.8 0 010-13.6zM12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z"/></svg>';

      return `
        <button type="button" class="mu-song${active ? ' is-active' : ''}" data-song="${escapeAttr(song.id)}"${song.cover ? ` data-cover="${escapeAttr(song.cover)}"` : ''}>
          <span class="mu-song__index">
            <span class="mu-song__num">${index + 1}</span>
            <span class="mu-song__bars" aria-hidden="true"><span></span><span></span><span></span></span>
          </span>
          <span class="mu-song__cover">${cover}</span>
          <span class="mu-song__body">
            <span class="mu-song__title">${escapeHtml(song.title)}</span>
            <span class="mu-song__artist">${escapeHtml(song.artist)}</span>
          </span>
          <span class="mu-song__time">${song.duration ? formatTime(song.duration) : '--:--'}</span>
        </button>`;
    })
    .join('');
}

/* ---------------- 歌词 ---------------- */

/** 双语歌词用两个以上空格把原文和译文连在同一行（网易云/QQ 的惯例） */
const BILINGUAL_GAP = /\s{2,}/;

/**
 * 一句歌词 → 行内 HTML。
 * 双语时拆成原文 / 译文两行（译文小一号、淡一点）。
 * 以前这里还复制一层 data-text 用 clip-path 做逐字扫光，现在不要了：
 * LRC 只精确到整句，长句换行时扫光会在两行之间一起扫，反而不如整句点亮。
 */
function lyricInner(text: string): string {
  const parts = text
    .split(BILINGUAL_GAP)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return `<span class="mu-lyric__row">${escapeHtml(text)}</span>`;
  }

  return (
    `<span class="mu-lyric__row">${escapeHtml(parts[0]!)}</span>` +
    `<span class="mu-lyric__row mu-lyric__row--tr">${escapeHtml(parts.slice(1).join(' '))}</span>`
  );
}

/* ---- 几何 ---- */

function measureLyrics(): void {
  lyricCenters = lyricEls.map((el) => el.offsetTop + el.offsetHeight / 2);
}

/** 让第 index 句停在视口正中间需要的位移 */
function centreShift(index: number): number {
  const height = lyricsViewport?.clientHeight ?? 0;
  const centre = lyricCenters[index];
  if (!height || centre === undefined || !Number.isFinite(centre)) return 0;
  return Math.round(height / 2 - centre);
}

/** 当前应该跟着谁：手动拖拽时跟焦点句，否则跟正在唱的那句（没开始就第一句） */
function followIndex(): number {
  if (manual) return focusIndex;
  if (lyricActive >= 0) return lyricActive;
  return focusIndex >= 0 ? focusIndex : 0;
}

function applyShift(): void {
  if (!lyricsInner) return;
  if (lyricsBox?.classList.contains('is-plain')) {
    lyricsInner.style.transform = 'none';
    return;
  }
  lyricsInner.style.transform = `translate3d(0, ${shift.toFixed(2)}px, 0)`;
  updateJumpPill();
}

function realign(animate: boolean): void {
  measureLyrics();
  moveBlock(centreShift(followIndex()), animate);
}

/* ---- 位移：容器 + 错峰归位 ----
   整块用容器的一个 transform 挪到位（拖动时一次写入，最省）；
   换句时每行先被「按在原地」，再按离当前句的距离依次出发归零，
   看上去就是一句跟着一句滑上去，而不是整块弹一下。 */

/** 清掉行内位移 / 延迟，并把这一帧的过渡关掉，避免「归零」也被动画走一遍 */
function resetLineOffset(): void {
  if (!lyricsInner) return;
  lyricsInner.classList.add('is-instant');
  for (const el of lyricEls) {
    el.style.transform = '';
    el.style.removeProperty('--mu-line-delay');
  }
  void lyricsInner.offsetHeight;
  lyricsInner.classList.remove('is-instant');
}

function moveBlock(next: number, animate: boolean): void {
  const delta = next - shift;
  const moved = Math.abs(delta) >= 0.5;

  if (moved) {
    shift = next;
    applyShift();
  }
  if (!lyricsInner || !lyricEls.length) return;

  // 没挪就别碰行内样式 —— 否则 ResizeObserver / resize 这类「重复对中」
  // 会把正在跑的错峰动画一把擦掉（看着就像根本没动画）
  if (!moved) return;

  // 位移太大（拖了很远才松手）：不错峰，否则会像被甩过去；
  // 上限定得比一屏高一点，这样「自动回归」这种稍远的位移仍然有动画
  const jumpLimit = Math.max(280, (lyricsViewport?.clientHeight ?? 600) * 1.15);
  if (!animate || Math.abs(delta) > jumpLimit) {
    resetLineOffset();
    return;
  }

  const inner = lyricsInner;
  const anchor = lyricActive >= 0 ? lyricActive : focusIndex;
  const lineHeight = lyricEls[0]?.offsetHeight || 60;
  const viewportHeight = lyricsViewport?.clientHeight || 600;
  const maxLines = Math.max(4, Math.ceil(viewportHeight / lineHeight / 2) + 3);
  const offset = `translate3d(0, ${(-delta).toFixed(2)}px, 0)`;

  // 第一步：关掉过渡，把离得近的句子反向推到「原地不动」的位置。
  // （不能直接推，--mu-line-delay 会让这一步也变成延迟动画，就白推了）
  inner.classList.add('is-instant');
  for (let i = 0; i < lyricEls.length; i += 1) {
    const el = lyricEls[i]!;
    if (Math.abs(i - anchor) >= maxLines) {
      el.style.transform = '';
      el.style.removeProperty('--mu-line-delay');
      continue;
    }
    el.style.setProperty('--mu-line-delay', '0s');
    el.style.transform = offset;
  }
  void inner.offsetHeight; // 让「原地不动」先落地
  inner.classList.remove('is-instant');

  // 第二步：开过渡，按「离当前句越远出发越晚」收回去
  for (let i = 0; i < lyricEls.length; i += 1) {
    const el = lyricEls[i]!;
    if (!el.style.transform) continue;
    el.style.setProperty('--mu-line-delay', `${Math.abs(i - anchor) * 26}ms`);
    el.style.transform = 'translate3d(0, 0px, 0)';
  }
}

/* ---- 点亮当前句 ---- */

function setActive(index: number): void {
  if (activeEl) activeEl.classList.remove('is-active');

  lyricActive = index;
  activeEl = index >= 0 ? lyricEls[index] ?? null : null;

  for (let i = 0; i < lyricEls.length; i += 1) {
    lyricEls[i]!.classList.toggle('is-past', index >= 0 && i < index);
  }

  if (activeEl) activeEl.classList.add('is-active');

  renderLyricBar();

  // 高亮句字重会变，行高跟着动：重新量一遍再决定滚到哪
  if (manual) updateJumpPill();
  else if (currentView === 'lyrics') realign(true);
}

/**
 * 按播放时间决定谁是「正在唱的那句」。
 * 只在换句时动一次 DOM —— 逐字扫光已经去掉（LRC 到不了那个精度），
 * 所以这里不需要每帧写样式，rAF 只用来把换句的延迟压到一帧以内。
 */
function syncActive(time: number): void {
  if (!lyricEls.length) return;

  let active = -1;
  for (let i = 0; i < lyricLines.length; i += 1) {
    const line = lyricLines[i]!;
    if (line.time !== null && line.time <= time + 0.12) active = i;
  }

  if (active !== lyricActive) setActive(active);
}

/* ---- 竖屏全屏第一级：歌名上方的 3 行歌词 ---- */

/** 一句歌词在预览条里只留原文（双语的译文不占地方） */
function barText(index: number): string {
  const text = lyricLines[index]?.text ?? '';
  return text.split(BILINGUAL_GAP)[0]?.trim() ?? '';
}

function setBarLine(node: HTMLElement | null, text: string): void {
  if (node) node.textContent = text;
}

function renderLyricBar(): void {
  if (!lyricBarEl) return;

  const has = lyricLines.length > 0;
  lyricBarEl.classList.toggle('is-empty', !has);
  if (!has) return;

  const at = lyricActive >= 0 ? lyricActive : 0;
  setBarLine(barLines.prev, at > 0 ? barText(at - 1) : '');
  setBarLine(barLines.cur, barText(at));
  setBarLine(barLines.next, barText(at + 1));
}

/* ---- 拖拽 / 跳转 ---- */

function clampShift(value: number): number {
  const height = lyricsViewport?.clientHeight ?? 0;
  if (!height || !lyricCenters.length) return value;
  const first = lyricCenters[0] ?? 0;
  const last = lyricCenters[lyricCenters.length - 1] ?? first;
  const slack = height * 0.3;
  const edgeA = height / 2 - first + slack;
  const edgeB = height / 2 - last - slack;
  const lo = Math.min(edgeA, edgeB);
  const hi = Math.max(edgeA, edgeB);
  return Math.max(lo, Math.min(hi, value));
}

function nearestLineIndex(): number {
  const height = lyricsViewport?.clientHeight ?? 0;
  if (!height || !lyricCenters.length) return lyricActive >= 0 ? lyricActive : 0;
  const centre = height / 2 - shift;
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lyricCenters.length; i += 1) {
    const dist = Math.abs((lyricCenters[i] ?? 0) - centre);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function setManual(value: boolean): void {
  if (manual === value) {
    if (!value) updateJumpPill();
    return;
  }
  manual = value;
  lyricsBox?.classList.toggle('is-manual', value);
  if (followBtn) followBtn.hidden = !value;
  if (!value) window.clearTimeout(manualTimer);

  if (!value) {
    lyricEls[focusIndex]?.classList.remove('is-focus');
    focusIndex = lyricActive >= 0 ? lyricActive : 0;
  }
  updateJumpPill();
}

/** 拖完不操作就自己回到正在唱的那句（点过「跳到这句」或「回到当前」就不用等） */
function armManualTimer(): void {
  window.clearTimeout(manualTimer);
  manualTimer = window.setTimeout(() => {
    if (!manual || !isMounted()) return;
    setManual(false);
    realign(true);
  }, MANUAL_HOLD);
}

function enterManual(index: number): void {
  for (const el of lyricsInner?.querySelectorAll<HTMLElement>('.is-focus, .is-hover') ?? []) {
    el.classList.remove('is-focus', 'is-hover');
  }
  manual = true;
  lyricsBox?.classList.add('is-manual');
  if (followBtn) followBtn.hidden = false;

  focusIndex = index;
  lyricEls[index]?.classList.add('is-focus');
  moveBlock(centreShift(index), true);
  updateJumpPill();
  armManualTimer();
}

/** 浮在右侧的「跳到这句」按钮：位置跟着句子走，字号跟着拖拽实时更新 */
function updateJumpPill(): void {
  if (!jumpBtn) return;

  const index = manual ? focusIndex : -1;
  const line = index >= 0 ? lyricLines[index] : undefined;
  const show = Boolean(line && line.time !== null && index !== lyricActive);

  jumpBtn.hidden = !show;
  if (!show) return;

  const centre = lyricCenters[index] ?? 0;
  jumpBtn.style.setProperty('--jump-top', `${Math.round(centre + shift)}px`);
  if (jumpLabel) jumpLabel.textContent = `跳到 ${formatTime(line!.time ?? 0)}`;
}

function jumpToLine(index: number): void {
  const line = lyricLines[index];
  if (!line || line.time === null) return;
  setManual(false);
  seek(line.time);
  lyricActive = -1;
  moveBlock(centreShift(index), true);
  updateJumpPill();
}

function bindLyricsDrag(): void {
  const viewport = lyricsViewport;
  if (!viewport) return;

  viewport.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // 先记起点：走够 6px 才算拖（点一下什么也不做）
    dragArmed = true;
    dragActive = false;
    dragPointer = event.pointerId;
    dragStartY = event.clientY;
    dragStartX = event.clientX;
    dragOrigin = shift;
    window.clearTimeout(manualTimer);
  });

  viewport.addEventListener('pointermove', (event) => {
    if (!dragArmed || event.pointerId !== dragPointer) return;

    const dy = event.clientY - dragStartY;
    if (!dragActive) {
      if (Math.abs(dy) < 6) return;
      // 明显是横着划的，不当拖拽
      if (Math.abs(event.clientX - dragStartX) > Math.abs(dy) * 1.6) return;
      dragActive = true;
      viewport.setPointerCapture(event.pointerId);
      lyricsBox?.classList.add('is-dragging');
      resetLineOffset();
    }

    shift = clampShift(dragOrigin + dy);
    applyShift();

    // 拖到哪句就点亮哪句，松手才「着陆」
    const index = nearestLineIndex();
    if (index !== focusIndex) {
      lyricEls[focusIndex]?.classList.remove('is-hover');
      focusIndex = index;
      lyricEls[index]?.classList.add('is-hover');
    }
    updateJumpPill();
  });

  const finish = (event: PointerEvent): void => {
    if (event.pointerId !== dragPointer) return;
    const wasDrag = dragActive;
    dragArmed = false;
    dragActive = false;
    dragPointer = null;

    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    lyricsBox?.classList.remove('is-dragging');

    if (!wasDrag) {
      // 竖屏全屏歌词里点一下歌词（没有拖动）→ 收回第一级，这就是「退出全屏歌词」
      if (fsStage === 2) setFsStage(1);
      return;
    }

    for (const el of lyricsInner?.querySelectorAll<HTMLElement>('.is-hover') ?? []) {
      el.classList.remove('is-hover');
    }
    enterManual(nearestLineIndex());
  };

  viewport.addEventListener('pointerup', finish);
  viewport.addEventListener('pointercancel', finish);
}

/* ---- 渲染 / 排版 ---- */

function renderLyrics(song: PlayerSong | null): void {
  if (!lyricsInner) return;

  lyricsForSong = song?.id ?? null;
  lyricLines = [];
  lyricEls = [];
  lyricCenters = [];
  lyricActive = -1;
  activeEl = null;
  setManual(false);
  focusIndex = 0;

  const raw = song ? lyricsBySong.get(song.id) ?? song.lyrics ?? '' : '';
  const parsed = parseLyrics(raw);

  if (!parsed.lines.length) {
    lyricsInner.innerHTML = `
      <div class="mu-lyrics__empty">
        <svg class="h-7 w-7 opacity-40" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18.5a2.5 2.5 0 11-2.5-2.5c.17 0 .34.02.5.05V6.2l10-2.2v9.5a2.5 2.5 0 11-2.5-2.5c.17 0 .34.02.5.05V7.2l-5 1.1v10.2z"/></svg>
        <span>这首歌还没有歌词<br>在「站点配置 → 音乐库」里可以贴上 LRC 或上传 .lrc 文件</span>
      </div>`;
    lyricsBox?.classList.remove('is-plain');
    shift = 0;
    applyShift();
    if (jumpBtn) jumpBtn.hidden = true;
    renderLyricBar();
    return;
  }

  lyricLines = parsed.lines;

  // 句子本身不再是按钮：点它不跳，只有右侧「跳到这句」才跳
  lyricsInner.innerHTML = parsed.lines
    .map((line, index) => {
      const timeAttr = line.time !== null ? ` data-time="${line.time}"` : '';
      const text = line.text || '♪';
      return `<span class="mu-lyric"${timeAttr} data-line="${index}">${lyricInner(text)}</span>`;
    })
    .join('');

  lyricEls = Array.from(lyricsInner.querySelectorAll<HTMLElement>('[data-line]'));

  // 没有时间轴 → 让歌词区可以自由滚动，不做自动跟随
  lyricsBox?.classList.toggle('is-plain', !parsed.synced);

  // 新歌默认把第一句摆到正中间
  measureLyrics();
  shift = centreShift(0);
  applyShift();
  resetLineOffset();
  updateJumpPill();
  renderLyricBar();
}

/** 现在有没有「活着的歌词」需要逐帧盯时间轴：右侧歌词视图，或竖屏全屏第一级的预览条 */
function lyricsLive(): boolean {
  return currentView === 'lyrics' || fsStage === 1;
}

function syncFrameLoop(): void {
  if (!isMounted()) {
    stopFrameLoop();
    return;
  }
  if (lyricsLive()) startFrameLoop();
  else stopFrameLoop();
}

function startFrameLoop(): void {
  if (frameRaf) return;
  lastFrame = 0;
  frameRaf = requestAnimationFrame(frame);
}

function stopFrameLoop(): void {
  if (!frameRaf) return;
  cancelAnimationFrame(frameRaf);
  frameRaf = 0;
}

function frame(): void {
  frameRaf = requestAnimationFrame(frame);
  if (!isMounted() || !lyricsLive()) {
    stopFrameLoop();
    return;
  }

  if (dragActive) return;
  const state = getState();
  if (!scrubbing) syncActive(state.currentTime);
}

/* ---------------- 字号 ---------------- */

function applyLyricSize(persist: boolean): void {
  const size = LYRIC_SIZES[clamp(sizeIndex, 0, LYRIC_SIZES.length - 1)] ?? 1.875;
  root?.style.setProperty('--mu-lyric-size', `${size}rem`);
  if (persist) {
    try {
      localStorage.setItem(LYRIC_SIZE_KEY, String(sizeIndex));
    } catch {
      /* 隐私模式 */
    }
  }
  if (currentView === 'lyrics') requestAnimationFrame(() => realign(false));
}

function readLyricSize(): void {
  try {
    const raw = localStorage.getItem(LYRIC_SIZE_KEY);
    const value = raw === null ? NaN : Number(raw);
    if (Number.isFinite(value)) sizeIndex = clamp(value, 0, LYRIC_SIZES.length - 1);
  } catch {
    /* 读不到就用默认 */
  }
  applyLyricSize(false);
}

/* ---------------- 视图切换 ---------------- */

function switchView(view: 'list' | 'lyrics'): void {
  currentView = view;
  if (tabsEl) tabsEl.style.setProperty('--tab-index', view === 'lyrics' ? '1' : '0');

  for (const tab of root?.querySelectorAll<HTMLElement>('[data-mu-tab]') ?? []) {
    const isActive = tab.dataset.muTab === view;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }

  for (const panel of root?.querySelectorAll<HTMLElement>('[data-mu-view]') ?? []) {
    panel.hidden = panel.dataset.muView !== view;
  }

  if (view === 'lyrics') {
    // 隐藏时高度都是 0，显示出来这一帧才量得到真正的行高
    requestAnimationFrame(() => {
      realign(false);
      syncActive(getState().currentTime);
    });
  }

  syncFrameLoop();
}

/* ---------------- 全屏 ---------------- */

/** 竖屏（窄屏）：全屏走三级歌词，不去请求浏览器原生全屏 */
function narrowScreen(): boolean {
  return window.matchMedia('(max-width: 1023.98px)').matches;
}

/** 宽屏：左右两栏都在，全屏时把控制搬到底部那条 */
function wideScreen(): boolean {
  return window.matchMedia('(min-width: 1024px)').matches;
}

/* ---- 底部控制条：把唱机里的几块搬进 .mu-dock ---- */

interface DockEntry {
  el: HTMLElement;
  /** 原来的前一个兄弟：搬回去时插在它后面（比记 nextSibling 稳，不受文本节点影响） */
  prev: Element | null;
}

let dockEl: HTMLElement | null = null;
let dockEntries: DockEntry[] = [];
let dockHover = false;
let dockTimer = 0;
let lastDockMove = 0;
const DOCK_HOLD = 2600;

/** 鼠标不动就沉下去 */
function armDockTimer(): void {
  window.clearTimeout(dockTimer);
  dockTimer = window.setTimeout(() => {
    if (!dockEl || !isMounted() || dockHover) return;
    // 键盘焦点还在控制条里就别收，不然会「用着用着消失」
    if (dockEl.contains(document.activeElement)) return;
    dockEl.classList.add('is-hidden');
  }, DOCK_HOLD);
}

function showDock(): void {
  if (!dockEl || !dockEl.classList.contains('is-docked')) return;
  dockEl.classList.remove('is-hidden');
  armDockTimer();
}

/**
 * 把歌名 / 进度 / 主控 / 次控搬进 / 搬出底部控制条。
 *
 * 搬移节点而不是复制一份：所有监听、渲染函数、拖拽绑定都是按节点走的，
 * 复制就必须再绑一遍，还容易两份状态不同步。
 */
function dockControls(want: boolean): void {
  if (!dockEl || !root) return;

  if (want) {
    if (dockEntries.length) return;
    const nodes = [
      q<HTMLElement>('.mu-now'),
      q<HTMLElement>('.mu-progress'),
      q<HTMLElement>('.mu-controls'),
      q<HTMLElement>('.mu-subcontrols'),
    ].filter((el): el is HTMLElement => Boolean(el));
    if (!nodes.length) return;

    dockEntries = nodes.map((el) => ({ el, prev: el.previousElementSibling }));
    for (const entry of dockEntries) dockEl.appendChild(entry.el);
    dockEl.classList.add('is-docked');
    dockEl.classList.remove('is-hidden');
    armDockTimer();
    return;
  }

  if (!dockEntries.length) return;

  // 按原顺序插回去：每一项的前一个兄弟此刻都还在 stage 里（前一项刚插回去）
  for (const entry of dockEntries) {
    const parent = entry.prev?.parentElement;
    if (parent && entry.prev?.isConnected) parent.insertBefore(entry.el, entry.prev.nextSibling);
    else stage?.appendChild(entry.el);
  }

  dockEntries = [];
  dockEl.classList.remove('is-docked', 'is-hidden');
  window.clearTimeout(dockTimer);
}

/** 全屏 + 宽屏才需要底部控制条；转屏 / 改窗口宽度时跟着调整 */
function syncDock(): void {
  dockControls(fsStage > 0 && wideScreen());
}

async function requestNativeFullscreen(): Promise<void> {
  const el = root as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }) | null;
  if (!el || document.fullscreenElement) return;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch {
    /* 不支持 / 被拒绝都没关系：position: fixed 已经把面板铺满了 */
  }
}

async function releaseNativeFullscreen(): Promise<void> {
  if (!document.fullscreenElement) return;
  try {
    await document.exitFullscreen();
  } catch {
    /* 已经退出来了 */
  }
}

function renderFsShell(): void {
  const btn = q<HTMLElement>('[data-mu-fs]');
  if (btn) {
    const on = fsStage > 0;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = on ? '退出全屏' : '全屏播放';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  document.documentElement.classList.toggle('mu-fs-lock', fsStage > 0);
  document.body.classList.toggle('mu-fs-open', fsStage > 0);
  syncFrameLoop();
}

function setFsStage(next: FsStage): void {
  if (!root || fsStage === next) return;

  fsStage = next;
  root.dataset.muFsm = String(next);
  renderFsShell();
  syncDock();

  // 进到歌词级：右栏要切到歌词，而且布局整个变了，得重新对中
  if (next >= 2) {
    if (currentView !== 'lyrics') switchView('lyrics');
    requestAnimationFrame(() => {
      if (!isMounted()) return;
      realign(false);
      syncActive(getState().currentTime);
    });
  }
}

function enterFullscreen(): void {
  if (!root || fsStage > 0) return;
  fsPrevView = currentView;
  setFsStage(1);
  // 桌面 / 横屏：真的把浏览器也切进全屏；手机竖屏只铺满视口就够了
  if (!narrowScreen()) void requestNativeFullscreen();
}

function exitFullscreen(options: { fromNative?: boolean } = {}): void {
  if (fsStage === 0) return;
  setFsStage(0);
  if (!options.fromNative) void releaseNativeFullscreen();
  switchView(fsPrevView);
}

/** 竖屏第二级 ↔ 第三级：∨ 把进度和播放按钮收起来，∧ 收回来 */
function toggleLyricsFullscreen(): void {
  if (!narrowScreen()) return;
  if (fsStage === 2) setFsStage(3);
  else if (fsStage === 3) setFsStage(2);
}

/** 竖屏第一级：点歌名上方那 3 行歌词 → 全屏歌词 */
function openLyricsFullscreen(): void {
  if (!narrowScreen()) return;
  if (fsStage === 1) setFsStage(2);
}

/* ---------------- 总渲染 ---------------- */

function render(state: PlayerSnapshot): void {
  renderCovers(state.song, state.playlist?.cover);
  renderNowPlaying(state);
  renderProgress(state);
  renderControls(state);
  renderPlaylists(state);
  renderList(state);

  if (state.songId !== lyricsForSong) {
    renderLyrics(state.song);
    syncActive(state.currentTime);
  }
}

/* ---------------- 绑定 ---------------- */

function bind(): void {
  if (!root) return;

  stage = q<HTMLElement>('[data-mu-stage]');
  spin = q<HTMLElement>('[data-mu-spin]');
  listEl = q<HTMLElement>('[data-mu-list]');
  playlistsEl = q<HTMLElement>('[data-mu-playlists]');
  filterInput = q<HTMLInputElement>('[data-mu-filter]');
  tabsEl = q<HTMLElement>('[data-mu-tabs]');

  lyricsBox = q<HTMLElement>('[data-mu-lyrics]');
  lyricsViewport = q<HTMLElement>('[data-mu-lyrics-viewport]');
  lyricsInner = q<HTMLElement>('[data-mu-lyrics-inner]');
  jumpBtn = q<HTMLButtonElement>('[data-mu-jump]');
  jumpLabel = q<HTMLElement>('[data-mu-jump-label]');
  followBtn = q<HTMLButtonElement>('[data-mu-follow]');
  lyricBarEl = q<HTMLElement>('[data-mu-lyricbar]');
  dockEl = q<HTMLElement>('[data-mu-dock]');
  barLines.prev = q<HTMLElement>('[data-mu-lb="prev"]');
  barLines.cur = q<HTMLElement>('[data-mu-lb="cur"]');
  barLines.next = q<HTMLElement>('[data-mu-lb="next"]');
  bgLayers = [
    q<HTMLElement>('[data-mu-bg="a"]'),
    q<HTMLElement>('[data-mu-bg="b"]'),
  ];

  /* 播放控制 */
  q<HTMLElement>('[data-mu-play]')?.addEventListener('click', () => toggle());
  q<HTMLElement>('[data-mu-prev]')?.addEventListener('click', () => prev());
  q<HTMLElement>('[data-mu-next]')?.addEventListener('click', () => next());
  q<HTMLElement>('[data-mu-mode]')?.addEventListener('click', () => cycleMode());
  q<HTMLElement>('[data-mu-mute]')?.addEventListener('click', () => toggleMute());

  /* 点唱片本身也能播放 / 暂停（只绑外层，避免旋转层冒泡触发两次） */
  q<HTMLElement>('.tt__disc')?.addEventListener('click', () => toggle());

  /* 标签切换 */
  for (const tab of root.querySelectorAll<HTMLElement>('[data-mu-tab]')) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.muTab === 'lyrics' ? 'lyrics' : 'list';
      switchView(view);
    });
  }

  q<HTMLElement>('[data-mu-goto-lyrics]')?.addEventListener('click', () => switchView('lyrics'));

  /* 全屏：左上角按钮 / 竖屏那条 3 行歌词 / 控制上方的 ∨ */
  q<HTMLElement>('[data-mu-fs]')?.addEventListener('click', () => {
    if (fsStage > 0) exitFullscreen();
    else enterFullscreen();
  });
  lyricBarEl?.addEventListener('click', openLyricsFullscreen);
  q<HTMLElement>('[data-mu-fs-more]')?.addEventListener('click', toggleLyricsFullscreen);

  /* 底部控制条：鼠标一动就浮上来，停在上面不算「不动」 */
  dockEl?.addEventListener('pointerenter', () => {
    dockHover = true;
    showDock();
  });
  dockEl?.addEventListener('pointerleave', () => {
    dockHover = false;
    showDock();
  });
  document.addEventListener(
    'pointermove',
    () => {
      if (!dockEl || !dockEl.classList.contains('is-docked')) return;
      const now = performance.now();
      // 每帧都清一次定时器太浪费，60ms 一次足够
      if (now - lastDockMove < 60) return;
      lastDockMove = now;
      showDock();
    },
    { passive: true },
  );
  document.addEventListener('pointerdown', showDock, { passive: true });

  /* 律动：唱机下方那条连续曲线 */
  wave?.destroy();
  const waveCanvas = q<HTMLCanvasElement>('[data-mu-wave]');
  if (waveCanvas) {
    wave = mountWave(waveCanvas, {
      points: 48,
      amplitude: 0.46,
      layers: 2,
      idle: 0.1,
      lineWidth: 1.6,
    });
  }

  /* 进度条：拖动中只画，松手才真正跳（否则每一像素都在重新解码） */
  const seekTrack = q<HTMLElement>('[data-mu-seek]');
  const progressWrap = q<HTMLElement>('[data-mu-progress]');
  if (seekTrack) {
    bindScrubber(
      seekTrack,
      (ratio) => {
        const state = getState();
        const duration = state.duration || 0;
        seekTrack.style.setProperty('--val', `${Math.round(ratio * 1000) / 10}%`);
        const current = q<HTMLElement>('[data-mu-current]');
        if (current) current.textContent = formatTime(ratio * duration);
        // 歌词先跟着预览：拖着进度条就能看到落到哪一句
        if (lyricsLive()) syncActive(ratio * duration);
      },
      {
        onStart: () => {
          scrubbing = true;
          progressWrap?.classList.add('is-scrubbing');
        },
        onEnd: (ratio) => {
          scrubbing = false;
          progressWrap?.classList.remove('is-scrubbing');
          const duration = getState().duration || 0;
          seek(Math.max(0, ratio * duration));
        },
      },
    );
  }

  /* 音量（本地音量，实时改没问题） */
  const volumeTrack = q<HTMLElement>('[data-mu-volume]');
  if (volumeTrack) bindScrubber(volumeTrack, (ratio) => setVolume(ratio));

  /* 歌词拖拽 / 跳到这句 / 回到当前 / 字号 */
  bindLyricsDrag();

  jumpBtn?.addEventListener('click', () => jumpToLine(focusIndex));
  followBtn?.addEventListener('click', () => {
    setManual(false);
    realign(true);
  });

  for (const btn of root.querySelectorAll<HTMLElement>('[data-mu-size]')) {
    btn.addEventListener('click', () => {
      const step = Number(btn.dataset.muSize) || 0;
      sizeIndex = clamp(sizeIndex + step, 0, LYRIC_SIZES.length - 1);
      applyLyricSize(true);
    });
  }

  /* 搜索 */
  filterInput?.addEventListener('input', () => {
    activeFilter = filterInput?.value ?? '';
    listKey = '';
    render(getState());
  });

  /* 歌单切换 / 点歌（点歌词句子**不**跳播，只有右侧「跳到这句」才跳） */
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const playlistBtn = target.closest<HTMLElement>('[data-playlist]');
    if (playlistBtn?.dataset.playlist) {
      setPlaylist(playlistBtn.dataset.playlist, { autoplay: true });
      listKey = '';
      return;
    }

    const songBtn = target.closest<HTMLElement>('[data-song]');
    if (songBtn?.dataset.song) {
      playSong(songBtn.dataset.song);
    }
  });

  /* 手动拖过歌词之后，点到歌词区以外就收回跟随（不用等计时器） */
  document.addEventListener('pointerdown', (event) => {
    if (!manual || !isMounted()) return;
    const target = event.target as Node | null;
    if (target && lyricsBox?.contains(target)) return;
    if (target && (target as HTMLElement).closest?.('[data-mu-jump], [data-mu-follow]')) return;
    setManual(false);
    realign(true);
  });

  /* 悬停列表里的歌：唱片先给你看一眼它的封面 */
  root.addEventListener('pointerover', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-song]');
    if (!row || !spin) return;
    const cover = row.dataset.cover;
    if (!cover) return;
    if (row.contains(event.relatedTarget as Node | null)) return;
    spin.style.setProperty('--cover-preview', `url("${cover}")`);
    spin.classList.add('is-previewing');
  });

  root.addEventListener('pointerout', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-song]');
    if (!row || !spin) return;
    if (row.contains(event.relatedTarget as Node | null)) return;
    spin.classList.remove('is-previewing');
  });

  /* 窗口尺寸变了，行高跟着变，重新对一次中 */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    // 手机横过来 / 平板变宽：竖屏那两级歌词布局没意义了，退回第一级
    if (fsStage >= 2 && !narrowScreen()) setFsStage(1);
    // 跨过 1024 这条线：底部控制条该出现 / 该收回去
    syncDock();
    if (currentView !== 'lyrics') return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => realign(false), 120);
  });

  /* 歌词块 / 歌词视口的高度变了（字体后加载、换字号、行内换行、旁边唱机长高把
     右栏一起撑高）都要重新对中，否则「居中」会慢慢偏掉几十像素 */
  if (lyricsInner && 'ResizeObserver' in window) {
    let measurePending = false;
    const observer = new ResizeObserver(() => {
      if (measurePending || dragActive || currentView !== 'lyrics') return;
      measurePending = true;
      requestAnimationFrame(() => {
        measurePending = false;
        if (isMounted() && currentView === 'lyrics' && !dragActive) realign(false);
      });
    });
    observer.observe(lyricsInner);
    if (lyricsViewport) observer.observe(lyricsViewport);
  }

  /* 快捷键：空格 播放/暂停，左右 快退/快进，m 静音
     （全局只绑一次；页面被换掉之后 isMounted() 为 false，自然失效） */
  if (!globalBound) {
    globalBound = true;

    document.addEventListener('keydown', (event) => {
      if (!isMounted()) return;

      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // 敲键盘也算「你在用它」，把底部控制条叫出来
      showDock();

      if (event.code === 'Space') {
        if (target?.closest('button, a')) return; // 按钮自己会处理
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowRight') {
        const state = getState();
        event.preventDefault();
        seek(Math.min((state.currentTime || 0) + 5, state.duration || 0));
      } else if (event.key === 'ArrowLeft') {
        const state = getState();
        event.preventDefault();
        seek(Math.max((state.currentTime || 0) - 5, 0));
      } else if (event.key.toLowerCase() === 'm') {
        toggleMute();
      } else if (event.key === 'Escape' && fsStage > 0) {
        exitFullscreen();
      }
    });

    /* 用户按 Esc / 系统手势退出原生全屏时，面板也要跟着回到正常页面 */
    document.addEventListener('fullscreenchange', () => {
      if (!isMounted()) return;
      if (!document.fullscreenElement && fsStage > 0) exitFullscreen({ fromNative: true });
    });
  }

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => {
      if (currentView === 'lyrics') realign(false);
    });
  }
}

/* ---------------- 生命周期 ---------------- */

function init(): void {
  const el = document.querySelector<HTMLElement>('[data-music-page]');
  if (!el) return;

  root = el;
  readPageData();

  // 换页回来时全屏状态应该是干净的（模块状态跨页面存活，这里显式复位）
  fsStage = 0;
  el.dataset.muFsm = '0';
  dockEntries = [];
  window.clearTimeout(dockTimer);
  document.documentElement.classList.remove('mu-fs-lock');
  document.body.classList.remove('mu-fs-open');

  if (el.dataset.muBound !== '1') {
    el.dataset.muBound = '1';
    bind();
    readLyricSize();
    unsubscribe?.();
    unsubscribe = subscribe(({ type, state }) => {
      if (type === 'tick') {
        renderProgress(state);
        // 歌词靠自己的 rAF 循环刷新（每帧），这里不再逐句比时间
        return;
      }
      render(state);
    });
  }

  // 换页时清掉订阅与动画，避免旧页面的 DOM 被继续操作
  onBeforeSwap(() => {
    unsubscribe?.();
    unsubscribe = null;
    stopFrameLoop();
    wave?.destroy();
    wave = null;
    // 全屏 / 滚动锁不能带到下一个页面
    fsStage = 0;
    dockEntries = [];
    window.clearTimeout(dockTimer);
    dockEl = null;
    document.documentElement.classList.remove('mu-fs-lock');
    document.body.classList.remove('mu-fs-open');
    void releaseNativeFullscreen();
  });

  render(getState());
}

onPageLoad(init);
