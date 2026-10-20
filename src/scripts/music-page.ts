/**
 * 音乐页交互
 * ============================================================
 * 只做三件事：
 *   ① 把播放器状态画到唱机 / 控制条上（数据在 scripts/player.ts）
 *   ② 渲染播放列表（多歌单切换 + 搜索 + 悬停预览封面）
 *   ③ 解析并滚动歌词（支持 .lrc 时间轴，逐句卡拉OK式渐染）
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
let lyricsInner: HTMLElement | null = null;
let lyricsViewport: HTMLElement | null = null;

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
let lyricActive = -1;
let lyricsForSong: string | null = null;

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

/* ---------------- 渲染 ---------------- */

function renderCovers(song: PlayerSong | null, playlistCover?: string): void {
  if (!root) return;
  const url = song?.cover || playlistCover || '';
  if (url) root.style.setProperty('--cover', `url("${url}")`);
  else root.style.removeProperty('--cover');
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

function renderLyrics(song: PlayerSong | null): void {
  if (!lyricsInner) return;

  lyricsForSong = song?.id ?? null;
  lyricLines = [];
  lyricEls = [];
  lyricActive = -1;

  const raw = song ? lyricsBySong.get(song.id) ?? song.lyrics ?? '' : '';
  const parsed = parseLyrics(raw);
  const box = lyricsViewport?.closest<HTMLElement>('.mu-lyrics') ?? null;

  if (!parsed.lines.length) {
    lyricsInner.innerHTML = `
      <div class="mu-lyrics__empty">
        <svg class="h-7 w-7 opacity-40" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18.5a2.5 2.5 0 11-2.5-2.5c.17 0 .34.02.5.05V6.2l10-2.2v9.5a2.5 2.5 0 11-2.5-2.5c.17 0 .34.02.5.05V7.2l-5 1.1v10.2z"/></svg>
        <span>这首歌还没有歌词<br>在「站点配置 → 音乐库」里可以贴上 LRC 或上传 .lrc 文件</span>
      </div>`;
    box?.classList.remove('is-plain');
    lyricsInner.style.setProperty('--shift', '0');
    return;
  }

  lyricLines = parsed.lines;

  const html = parsed.lines
    .map((line, index) => {
      const timeAttr = line.time !== null ? ` data-time="${line.time}"` : '';
      const tag = line.time !== null ? 'button' : 'span';
      const type = line.time !== null ? ' type="button"' : '';
      const text = line.text || '♪';
      return `<${tag}${type} class="mu-lyric"${timeAttr} data-line="${index}"><span class="mu-lyric__text">${escapeHtml(text)}</span></${tag}>`;
    })
    .join('');

  lyricsInner.innerHTML = html;
  lyricEls = Array.from(lyricsInner.querySelectorAll<HTMLElement>('[data-line]'));

  // 没有时间轴 → 让歌词区可以自由滚动，不做自动跟随
  box?.classList.toggle('is-plain', !parsed.synced);

  lyricsInner.style.setProperty('--shift', '0');
  requestAnimationFrame(() => layoutLyrics());
}

function nextTimedIndex(from: number): number | null {
  for (let i = from + 1; i < lyricLines.length; i += 1) {
    if (lyricLines[i]!.time !== null) return i;
  }
  return null;
}

function syncLyrics(state: PlayerSnapshot): void {
  if (!lyricEls.length) return;

  const time = state.currentTime;
  let active = -1;
  for (let i = 0; i < lyricLines.length; i += 1) {
    const line = lyricLines[i]!;
    if (line.time !== null && line.time <= time + 0.12) active = i;
  }

  if (active !== lyricActive) {
    const previous = lyricActive >= 0 ? lyricEls[lyricActive] : null;
    if (previous) {
      previous.classList.remove('is-active');
      previous.style.removeProperty('--karaoke');
    }

    lyricActive = active;

    const nextEl = active >= 0 ? lyricEls[active] : null;
    if (nextEl) {
      nextEl.classList.add('is-active');
      nextEl.style.setProperty('--karaoke', '0%');
      if (currentView === 'lyrics') requestAnimationFrame(() => layoutLyrics());
    }
  }

  // 当前句的渐染进度
  if (lyricActive >= 0) {
    const el = lyricEls[lyricActive]!;
    const start = lyricLines[lyricActive]?.time ?? 0;
    const nextIndex = nextTimedIndex(lyricActive);
    const end =
      nextIndex !== null
        ? (lyricLines[nextIndex]?.time ?? start + 6)
        : state.duration > start
          ? state.duration
          : start + 6;
    const span = Math.max(0.5, end - start);
    const progress = clamp01((time - start) / span);
    el.style.setProperty('--karaoke', `${(progress * 100).toFixed(1)}%`);
  }
}

function layoutLyrics(): void {
  if (!lyricsViewport || !lyricsInner || !lyricEls.length) return;
  if (currentView !== 'lyrics' || !isMounted()) return;

  const target = lyricActive >= 0 ? lyricEls[lyricActive] : null;
  if (!target) {
    lyricsInner.style.setProperty('--shift', '0');
    return;
  }

  const viewportHeight = lyricsViewport.clientHeight;
  if (!viewportHeight) return;

  const center = target.offsetTop + target.offsetHeight / 2;
  const shift = Math.round(viewportHeight * 0.4 - center);
  lyricsInner.style.setProperty('--shift', String(shift));
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
    requestAnimationFrame(() => {
      layoutLyrics();
    });
  }
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
    syncLyrics(state);
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
  lyricsInner = q<HTMLElement>('[data-mu-lyrics-inner]');
  lyricsViewport = q<HTMLElement>('[data-mu-lyrics-viewport]');

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

  /* 进度条 */
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
        seek(ratio * duration);
      },
      {
        onStart: () => {
          scrubbing = true;
          progressWrap?.classList.add('is-scrubbing');
        },
        onEnd: () => {
          scrubbing = false;
          progressWrap?.classList.remove('is-scrubbing');
        },
      },
    );
  }

  /* 音量 */
  const volumeTrack = q<HTMLElement>('[data-mu-volume]');
  if (volumeTrack) bindScrubber(volumeTrack, (ratio) => setVolume(ratio));

  /* 搜索 */
  filterInput?.addEventListener('input', () => {
    activeFilter = filterInput?.value ?? '';
    listKey = '';
    render(getState());
  });

  /* 歌单切换 / 点歌 / 点歌词跳播 */
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
      return;
    }

    const lyricBtn = target.closest<HTMLElement>('.mu-lyric[data-time]');
    if (lyricBtn?.dataset.time) {
      seek(Number(lyricBtn.dataset.time));
    }
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

  /* 歌词视图里重新排版 */
  window.addEventListener('resize', () => {
    if (currentView === 'lyrics') layoutLyrics();
  });

  /* 快捷键：空格 播放/暂停，左右 快退/快进，m 静音
     （全局只绑一次；页面被换掉之后 isMounted() 为 false，自然失效） */
  if (!globalBound) {
    globalBound = true;

    document.addEventListener('keydown', (event) => {
      if (!isMounted()) return;

      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

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
      }
    });
  }

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => {
      if (currentView === 'lyrics') layoutLyrics();
    });
  }
}

/* ---------------- 生命周期 ---------------- */

function init(): void {
  const el = document.querySelector<HTMLElement>('[data-music-page]');
  if (!el) return;

  root = el;
  readPageData();

  if (el.dataset.muBound !== '1') {
    el.dataset.muBound = '1';
    bind();
    unsubscribe?.();
    unsubscribe = subscribe(({ type, state }) => {
      if (type === 'tick') {
        renderProgress(state);
        syncLyrics(state);
        return;
      }
      render(state);
      syncLyrics(state);
    });
  }

  // 换页时清掉订阅与动画，避免旧页面的 DOM 被继续操作
  onBeforeSwap(() => {
    unsubscribe?.();
    unsubscribe = null;
    wave?.destroy();
    wave = null;
  });

  render(getState());
  syncLyrics(getState());
}

onPageLoad(init);
