/**
 * 全站音乐播放器（单例）
 * ============================================================
 * 一个页面只有一个 <audio>，左下角碟片和 /music/ 页面共用它。
 *
 * 几个关键约定：
 *   ① 播放状态放模块级变量里，不依赖 DOM —— 换页时 DOM 会换，模块不会。
 *   ② 碟片那一块用 transition:persist 固定在 <body> 里，换页时不重建，
 *      所以音乐能一直播下去（这也是「边看文章边听歌」的前提）。
 *   ③ 数据来自 BaseLayout 里那一小段 <script id="mp-data">，
 *      只有元信息、没有歌词，体积很小；歌词只在 /music/ 页面另带一份。
 *   ④ 所有状态变化都往外抛事件：
 *        change  结构变了（换歌 / 播放状态 / 模式 / 音量）→ UI 整块重画
 *        tick    时间走了 → UI 只更新进度
 * ============================================================
 */

import { onPageLoad } from './pageload';

/* ---------------- 类型 ---------------- */

export type PlayMode = 'list' | 'one' | 'shuffle';

export interface PlayerSong {
  id: string;
  title: string;
  artist: string;
  album?: string;
  src: string;
  cover?: string;
  duration?: number;
  lyrics?: string;
}

export interface PlayerPlaylist {
  id: string;
  name: string;
  description?: string;
  cover?: string;
  songs: PlayerSong[];
}

export interface PlayerSnapshot {
  playlists: PlayerPlaylist[];
  playlistId: string | null;
  playlist: PlayerPlaylist | null;
  songId: string | null;
  song: PlayerSong | null;
  playing: boolean;
  mode: PlayMode;
  volume: number;
  muted: boolean;
  currentTime: number;
  /** 音频真实时长（没加载出来时退回元信息里的 duration，可能是 0） */
  duration: number;
  /** 浏览器阻止了自动播放 */
  blocked: boolean;
}

export interface MusicEventDetail {
  type: 'change' | 'tick';
  state: PlayerSnapshot;
}

const STORAGE_KEY = 'melodyxz-music';
const EVENT = 'melodyxz:music';
const DATA_ID = 'mp-data';

/* ---------------- 模块级状态 ---------------- */

let playlists: PlayerPlaylist[] = [];
let playlistId: string | null = null;
let songId: string | null = null;
let mode: PlayMode = 'list';
let volume = 0.8;
let muted = false;
let blocked = false;
let restored = false;

let audio: HTMLAudioElement | null = null;
let audioSongId: string | null = null;
let bound = false;
let ready = false;

/** 随机播放用的洗牌队列 */
let shuffleBag: string[] = [];

const listeners = new Set<(detail: MusicEventDetail) => void>();

/* ---------------- 小工具 ---------------- */

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function readData(): void {
  if (ready) return;
  const node = document.getElementById(DATA_ID);
  if (!node) return;
  try {
    const parsed = JSON.parse(node.textContent || '{}') as { playlists?: PlayerPlaylist[] };
    playlists = Array.isArray(parsed.playlists)
      ? parsed.playlists.filter((item) => item && Array.isArray(item.songs) && item.songs.length)
      : [];
  } catch {
    playlists = [];
  }
  if (!playlists.length) return;

  ready = true;
  playlistId = playlists[0]?.id ?? null;
  songId = playlists[0]?.songs[0]?.id ?? null;
}

function currentPlaylist(): PlayerPlaylist | null {
  return playlists.find((item) => item.id === playlistId) ?? playlists[0] ?? null;
}

function currentSong(): PlayerSong | null {
  const list = currentPlaylist();
  if (!list) return null;
  return list.songs.find((item) => item.id === songId) ?? list.songs[0] ?? null;
}

export function findSong(id: string): PlayerSong | null {
  for (const list of playlists) {
    const found = list.songs.find((item) => item.id === id);
    if (found) return found;
  }
  return null;
}

export function findPlaylistOf(songIdValue: string): PlayerPlaylist | null {
  return playlists.find((list) => list.songs.some((song) => song.id === songIdValue)) ?? null;
}

function snapshot(): PlayerSnapshot {
  const playlist = currentPlaylist();
  const song = currentSong();
  return {
    playlists,
    playlistId: playlist?.id ?? null,
    playlist,
    songId: song?.id ?? null,
    song,
    playing: Boolean(audio && !audio.paused && !audio.ended),
    mode,
    volume,
    muted,
    currentTime: audio && audioSongId === song?.id ? audio.currentTime : 0,
    duration:
      (audio && audioSongId === song?.id && Number.isFinite(audio.duration) ? audio.duration : 0) ||
      song?.duration ||
      0,
    blocked,
  };
}

export function getState(): PlayerSnapshot {
  return snapshot();
}

export function subscribe(fn: (detail: MusicEventDetail) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type: 'change' | 'tick'): void {
  const detail: MusicEventDetail = { type, state: snapshot() };
  for (const fn of listeners) {
    try {
      fn(detail);
    } catch {
      /* 单个订阅者出错不影响别人 */
    }
  }
  window.dispatchEvent(new CustomEvent<MusicEventDetail>(EVENT, { detail }));
}

/* ---------------- 持久化 ---------------- */

interface StoredState {
  playlistId?: string | null;
  songId?: string | null;
  mode?: PlayMode;
  volume?: number;
  muted?: boolean;
}

function save(): void {
  try {
    const payload: StoredState = {
      playlistId,
      songId,
      mode,
      volume,
      muted,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* 隐私模式写不进去，忽略 */
  }
}

function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as StoredState;
    if (data.mode === 'list' || data.mode === 'one' || data.mode === 'shuffle') mode = data.mode;
    if (typeof data.volume === 'number' && data.volume >= 0 && data.volume <= 1) volume = data.volume;
    if (typeof data.muted === 'boolean') muted = data.muted;

    // 只恢复「上次听到哪首」，不自动播放（浏览器也会拦）
    if (typeof data.songId === 'string' && data.songId && findSong(data.songId)) {
      const owner = findPlaylistOf(data.songId);
      if (owner) {
        playlistId = owner.id;
        songId = data.songId;
      }
    } else if (typeof data.playlistId === 'string' && playlists.some((item) => item.id === data.playlistId)) {
      playlistId = data.playlistId;
    }
  } catch {
    /* 坏数据当没有 */
  }
}

/* ---------------- 频谱（给律动可视化用） ---------------- */

let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let graphFailed = false;

/**
 * 建立「元素 → 分析器 → 扬声器」这条音频链。
 * 只允许在**用户手势**里调用（浏览器只给手势开 AudioContext），
 * 否则上下文会一直是 suspended，声音反而出不来。
 */
function ensureAnalyser(): AnalyserNode | null {
  if (analyserNode || graphFailed) return analyserNode;
  const el = ensureAudio();
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!el || !Ctor) {
    graphFailed = true;
    return null;
  }

  try {
    audioContext = new Ctor();
    const source = audioContext.createMediaElementSource(el);
    analyserNode = audioContext.createAnalyser();

    // fftSize 跟着声卡采样率走：有些设备默认 192kHz，
    // 固定 2048 会让低频只用得到最前面十几个频点，律动就很钝。
    const rate = audioContext.sampleRate || 44100;
    let size = 1024;
    while (size < 32768 && rate / size > 26) size *= 2;
    analyserNode.fftSize = size;
    // 平滑交给可视化那边自己做（快起慢落），这里不能太"黏"，否则鼓点全糊掉
    analyserNode.smoothingTimeConstant = 0.5;
    // 上界给到 0dB：留足动态范围，重音才不会被削平成一条顶边的直线
    analyserNode.minDecibels = -90;
    analyserNode.maxDecibels = 0;

    source.connect(analyserNode);
    analyserNode.connect(audioContext.destination);
  } catch {
    graphFailed = true;
    analyserNode = null;
  }
  return analyserNode;
}

/** 律动可视化读的就是这个 */
export function getAnalyser(): AnalyserNode | null {
  return analyserNode;
}

/** 用户点了播放 / 暂停时调用：确保音频链建好并且跑起来 */
export function resumeAudioGraph(): void {
  const analyser = ensureAnalyser();
  if (!analyser || !audioContext) return;
  if (audioContext.state === 'suspended') {
    void audioContext.resume().catch(() => {});
  }
}

/* ---------------- 播放控制 ---------------- */

function ensureAudio(): HTMLAudioElement | null {
  if (audio) return audio;
  audio = document.querySelector<HTMLAudioElement>('[data-mp-audio]');
  if (!audio) return null;

  audio.volume = muted ? 0 : volume;

  audio.addEventListener('timeupdate', () => {
    emit('tick');
    updateMediaPosition();
  });
  audio.addEventListener('loadedmetadata', () => emit('change'));
  audio.addEventListener('play', () => {
    blocked = false;
    emit('change');
    syncMediaSession();
  });
  audio.addEventListener('pause', () => emit('change'));
  audio.addEventListener('ended', () => {
    if (mode === 'one') {
      audio!.currentTime = 0;
      void audio!.play().catch(() => {});
      return;
    }
    next({ fromEnd: true });
  });
  audio.addEventListener('error', () => {
    // 音频加载失败就跳到下一首，别卡住
    const playlist = currentPlaylist();
    if (playlist && playlist.songs.length > 1) next({ silent: true });
  });

  return audio;
}

function loadSong(id: string, options: { autoplay?: boolean } = {}): void {
  const el = ensureAudio();
  const song = findSong(id);
  if (!el || !song) return;

  const { autoplay = true } = options;
  const owner = findPlaylistOf(id);
  if (owner) playlistId = owner.id;
  songId = id;
  blocked = false;

  if (audioSongId !== id) {
    audioSongId = id;
    el.preload = 'auto';
    el.src = song.src;
    el.currentTime = 0;
  }

  syncMediaSession();
  save();
  emit('change');

  if (autoplay) {
    const promise = el.play();
    if (promise) {
      promise.catch(() => {
        blocked = true;
        emit('change');
      });
    }
  }
}

export function playSong(id: string): void {
  resumeAudioGraph();
  loadSong(id, { autoplay: true });
}

/** 点一下当前这首：暂停 / 继续；还没加载就加载它 */
export function toggle(): void {
  const el = ensureAudio();
  const song = currentSong();
  if (!el || !song) return;

  resumeAudioGraph();

  if (audioSongId !== song.id) {
    loadSong(song.id, { autoplay: true });
    return;
  }

  if (el.paused) {
    blocked = false;
    void el.play().catch(() => {
      blocked = true;
      emit('change');
    });
  } else {
    el.pause();
  }
}

export function pause(): void {
  audio?.pause();
}

function nextShuffled(): string | null {
  const playlist = currentPlaylist();
  if (!playlist) return null;
  const ids = playlist.songs.map((item) => item.id);

  if (!shuffleBag.length) {
    // 洗一轮，尽量别让开头又撞上刚放完的那首
    shuffleBag = ids.filter((id) => id !== songId);
    for (let i = shuffleBag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffleBag[i], shuffleBag[j]] = [shuffleBag[j]!, shuffleBag[i]!];
    }
  }
  return shuffleBag.shift() ?? null;
}

export function next(options: { fromEnd?: boolean; silent?: boolean } = {}): void {
  const playlist = currentPlaylist();
  if (!playlist || !playlist.songs.length) return;

  if (mode === 'shuffle') {
    const id = nextShuffled();
    if (id) loadSong(id, { autoplay: true });
    return;
  }

  const index = playlist.songs.findIndex((item) => item.id === songId);
  const target = playlist.songs[(index + 1) % playlist.songs.length];
  if (target) loadSong(target.id, { autoplay: !options.silent });
}

export function prev(): void {
  const playlist = currentPlaylist();
  if (!playlist || !playlist.songs.length) return;

  // 听超过 3 秒就先把这首从头放（和主流播放器一致）
  const el = ensureAudio();
  if (el && audioSongId === songId && el.currentTime > 3) {
    el.currentTime = 0;
    return;
  }

  if (mode === 'shuffle') {
    const id = nextShuffled();
    if (id) loadSong(id, { autoplay: true });
    return;
  }

  const index = playlist.songs.findIndex((item) => item.id === songId);
  const safeIndex = index < 0 ? 0 : index;
  const target = playlist.songs[(safeIndex - 1 + playlist.songs.length) % playlist.songs.length];
  if (target) loadSong(target.id, { autoplay: true });
}

export function seek(seconds: number): void {
  const el = ensureAudio();
  if (!el || !Number.isFinite(seconds)) return;
  el.currentTime = Math.max(0, Math.min(seconds, el.duration || seconds));
}

export function setVolume(value: number): void {
  volume = Math.max(0, Math.min(1, value));
  if (muted && volume > 0) muted = false;
  if (audio) audio.volume = muted ? 0 : volume;
  save();
  emit('change');
}

export function toggleMute(): void {
  muted = !muted;
  if (audio) audio.volume = muted ? 0 : volume;
  save();
  emit('change');
}

export function setMode(value: PlayMode): void {
  mode = value;
  shuffleBag = [];
  save();
  emit('change');
}

export function cycleMode(): PlayMode {
  const order: PlayMode[] = ['list', 'one', 'shuffle'];
  setMode(order[(order.indexOf(mode) + 1) % order.length]!);
  return mode;
}

export function setPlaylist(id: string, options: { autoplay?: boolean } = {}): void {
  const playlist = playlists.find((item) => item.id === id);
  if (!playlist || !playlist.songs.length) return;
  playlistId = id;
  shuffleBag = [];
  const first = playlist.songs[0]!;
  loadSong(first.id, { autoplay: options.autoplay ?? false });
}

/* ---------------- 系统媒体控件（锁屏 / 耳机按键） ---------------- */

let mediaSessionBound = false;

function syncMediaSession(): void {
  const session = navigator.mediaSession;
  if (!session) return;
  const song = currentSong();
  if (!song) return;

  try {
    session.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.album || currentPlaylist()?.name || '',
      artwork: song.cover ? [{ src: song.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  } catch {
    /* 老浏览器不支持就用默认的 */
  }

  if (mediaSessionBound) return;
  mediaSessionBound = true;

  const handlers: Array<[MediaSessionAction, () => void]> = [
    ['play', () => toggle()],
    ['pause', () => pause()],
    ['nexttrack', () => next()],
    ['previoustrack', () => prev()],
  ];

  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      /* 不支持某个动作就跳过 */
    }
  }
}

function updateMediaPosition(): void {
  const session = navigator.mediaSession;
  if (!session || !audio || typeof session.setPositionState !== 'function') return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    session.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate || 1,
    });
  } catch {
    /* 部分浏览器在暂停时调用会抛错，忽略 */
  }
}

/* ---------------- 初始化 ---------------- */

let started = false;

/** 播放器是否已经「上线」（有歌、有音频元素、数据读到） */
export function isReady(): boolean {
  return ready;
}

function start(): void {
  if (started) return;
  readData();
  if (!ready) return;
  started = true;

  restore();
  ensureAudio();
  applyVolume();

  if (bound) return;
  bound = true;

  // 换页后（元素还在）只需重画一次；音频元素自己带着状态
  document.addEventListener('astro:before-swap', () => {
    /* 什么都不用做：audio 元素被 transition:persist 保住了 */
  });
  window.addEventListener('pagehide', save);

  emit('change');
}

function applyVolume(): void {
  if (audio) audio.volume = muted ? 0 : volume;
}

/**
 * 组件里直接调用一次即可：内部做了幂等，ClientRouter 换页重复调用没副作用。
 */
export function setupPlayer(): void {
  onPageLoad(start);
}

/* 模块被 import 的瞬间也尝试启动一次 */
setupPlayer();
