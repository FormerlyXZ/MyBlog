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

/** 还没加载好元数据时记下想跳到的位置，metadata 一到就补上 */
let pendingSeek: number | null = null;

/** 随机播放用的洗牌队列 */
let shuffleBag: string[] = [];

/**
 * 播放历史（最近放过的歌，越靠后越新）。
 *
 * 只服务于「上一首」：随机播放时没有「前一首」这个概念，只能靠它退回去 ——
 * 上一首放的是哪首，按回去就回到哪首，绝对不能重新随机一首新的。
 * 列表循环用不着它（按索引 ±1 走，首尾相接），但照样记着：
 * 万一听一半切到随机，还能接着退。
 */
let history: string[] = [];
const HISTORY_MAX = 60;

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
    // 正在淡出的那 240ms 里就算「已经暂停」了：图标立刻翻过来，别等声音收完
    playing: Boolean(audio && !audio.paused && !audio.ended && !fadeAfter),
    mode,
    volume,
    muted,
    currentTime:
      audio && audioSongId === song?.id ? pendingSeek ?? audio.currentTime : 0,
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
/** 音量衰减放在分析器**后面**：分析器读到的是没有经过音量衰减的原始信号 */
let volumeGain: GainNode | null = null;
/** 元素接进音频图之后才有：它才是「元素已被 Web Audio 接管」的唯一凭据 */
let sourceNode: MediaElementAudioSourceNode | null = null;
let graphFailed = false;
/** 音频跨域拿不到 CORS 授权时置位：退回元素原生出声，永不建图 */
let mediaCorsBlocked = false;
/** 当前真正写进音频链的音量（元素音量 / 增益节点二选一，读的时候别去碰 DOM） */
let appliedVolume = 1;

/**
 * 统一入口：把「应该多大声」写进音频链。
 * 音频图建好之后走增益节点，元素自身的 volume 固定为 1 ——
 * 这样律动条读到的频谱跟用户把音量拖到 1% 还是 100% 完全无关。
 */
function applyGain(value: number): void {
  const level = Math.max(0, Math.min(1, value));
  appliedVolume = level;
  if (sourceNode && volumeGain && audioContext) {
    const now = audioContext.currentTime;
    // 直接赋值会「咔」一声，用极短斜坡把跳变收掉
    volumeGain.gain.cancelScheduledValues(now);
    volumeGain.gain.setTargetAtTime(level, now, 0.008);
    return;
  }
  if (audio) audio.volume = level;
}

/**
 * 建「分析器 → 增益 → 扬声器」这条后半段音频链，并让上下文跑起来。
 * 只允许在**用户手势**里调用（浏览器只给手势开 AudioContext），
 * 否则上下文会一直是 suspended，声音反而出不来。
 *
 * 这里**故意不接音频元素**——为什么，见 connectSource()。
 */
function ensureContext(): AudioContext | null {
  if (graphFailed) return null;
  if (audioContext) return audioContext;

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    graphFailed = true;
    return null;
  }

  try {
    const ctx = new Ctor();
    const analyser = ctx.createAnalyser();

    // fftSize 跟着声卡采样率走：有些设备默认 192kHz，
    // 固定 2048 会让低频只用得到最前面十几个频点，律动就很钝。
    const rate = ctx.sampleRate || 44100;
    let size = 1024;
    while (size < 32768 && rate / size > 26) size *= 2;
    analyser.fftSize = size;
    // 平滑交给可视化那边自己做（快起慢落），这里不能太"黏"，否则鼓点全糊掉
    analyser.smoothingTimeConstant = 0.5;
    // 上界给到 0dB：留足动态范围，重音才不会被削平成一条顶边的直线
    analyser.minDecibels = -90;
    analyser.maxDecibels = 0;

    // 分析器 → 增益 → 扬声器
    const gain = ctx.createGain();
    gain.gain.value = appliedVolume;
    analyser.connect(gain);
    gain.connect(ctx.destination);

    audioContext = ctx;
    analyserNode = analyser;
    volumeGain = gain;
  } catch {
    graphFailed = true;
    audioContext = null;
    analyserNode = null;
    volumeGain = null;
    return null;
  }

  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
  return audioContext;
}

/**
 * 把 <audio> 元素接进音频图。**只在元素真的开始出声之后**才调用。
 *
 * 为什么不能提前接：createMediaElementSource() 会接管元素的输出，而元素加载的是
 * 跨域音频（picture.melodyxz.top）。跨域且没拿到 CORS 授权时，规范要求
 * MediaElementAudioSourceNode 输出**整段静音**——表现就是进度条、歌词、时长全都
 * 正常，就是没有声音。等 playing 事件到了再接，说明这次加载确实按 CORS 通过了
 * （元素上写了 crossorigin="anonymous"、R2 也回了 Access-Control-Allow-Origin），
 * 这时接管才安全。
 */
function connectSource(): void {
  if (sourceNode || graphFailed || mediaCorsBlocked) return;
  if (!audioContext || !analyserNode) return;
  const el = audio;
  if (!el) return;

  try {
    const node = audioContext.createMediaElementSource(el);
    node.connect(analyserNode);
    // 接管之后元素音量锁死在 1，音量统一交给增益节点，频谱读数才不受音量影响
    el.volume = 1;
    if (volumeGain) volumeGain.gain.value = appliedVolume;
    sourceNode = node;
  } catch {
    // 接不上就干脆别接管，让元素自己出声（只是没有频谱律动）
    graphFailed = true;
    sourceNode = null;
    el.volume = appliedVolume;
  }
}

/** 律动可视化读的就是这个；还没接管元素时返回 null，别让它读出一片静音 */
export function getAnalyser(): AnalyserNode | null {
  return sourceNode ? analyserNode : null;
}

/** 用户点了播放 / 暂停时调用：确保音频上下文建好并且跑起来 */
export function resumeAudioGraph(): void {
  ensureContext();
  // 已经在播（暂停后继续、或上次的自动恢复）就当场接管，别等下一个 playing 事件
  if (audio && !audio.paused && audio.readyState >= 2) connectSource();
}

/* ---------------- 播放控制 ---------------- */

/* ---- 暂停 / 继续时的音量淡出淡入 ----
   直接 pause() 是「啪」一下断掉，继续播放又是「啪」一下冒出来。
   这里用 volume 走一小段曲线把声音收掉 / 涨起来：耳朵几乎听不出是渐变，
   但断点不再刺耳。音量滑块的值（volume）始终不动，只是临时动一下增益。 */

const FADE_OUT_MS = 240;
const FADE_IN_MS = 300;

/** 此刻「应该」是多大声（把静音算进去）；渐变一律以它为目标 */
function targetVolume(): number {
  return muted ? 0 : volume;
}

let fadeToken = 0;
let fadeTimer = 0;
/** 淡出之后要做的事（暂停）：被新的操作打断就作废，不然按两次播放会自己停 */
let fadeAfter: (() => void) | null = null;

/** 掐掉正在跑的渐变；返回原本「淡出结束后要做的事」 */
function stopFade(): (() => void) | null {
  fadeToken += 1;
  window.clearInterval(fadeTimer);
  fadeTimer = 0;
  const after = fadeAfter;
  fadeAfter = null;
  return after;
}

/** 从当前音量平滑走到 target（两端慢中间快），到点后执行 after */
function fadeVolume(target: number, ms: number, after?: () => void): void {
  const el = audio;
  if (!el) {
    after?.();
    return;
  }

  stopFade();
  const token = fadeToken;
  const from = appliedVolume;
  fadeAfter = after ?? null;

  if (ms <= 0 || Math.abs(target - from) < 0.002) {
    applyGain(target);
    const run = fadeAfter;
    fadeAfter = null;
    run?.();
    return;
  }

  const startedAt = performance.now();
  const tick = window.setInterval(() => {
    if (!audio || token !== fadeToken) {
      window.clearInterval(tick);
      return;
    }
    const t = Math.min(1, (performance.now() - startedAt) / ms);
    // smoothstep：起步和收尾都很轻，听不出是「拉杆」
    const eased = t * t * (3 - 2 * t);
    applyGain(from + (target - from) * eased);
    if (t < 1) return;

    window.clearInterval(tick);
    fadeTimer = 0;
    applyGain(target);
    const run = fadeAfter;
    fadeAfter = null;
    run?.();
  }, 16);
  fadeTimer = tick;
}

/** 暂停：声音先淡掉，淡完再真的 pause()，然后把音量摆回原值备用 */
function fadeOutAndPause(): void {
  const el = audio;
  if (!el) return;
  if (el.paused) {
    applyGain(targetVolume());
    return;
  }
  fadeVolume(0, FADE_OUT_MS, () => {
    audio?.pause();
    applyGain(targetVolume());
  });
  // 声音还在收，但界面上已经当它停了
  emit('change');
}

/** 继续播放：先把音量压到 0，等 play() 真的起来再淡进来 */
function fadeInAndPlay(): void {
  const el = audio;
  if (!el) return;

  stopFade();
  applyGain(0);
  blocked = false;
  emit('change');

  const promise = el.play();
  if (!promise) {
    fadeVolume(targetVolume(), FADE_IN_MS);
    return;
  }
  void promise.then(
    () => {
      if (audio !== el) return;
      fadeVolume(targetVolume(), FADE_IN_MS);
    },
    () => {
      blocked = true;
      if (audio === el) applyGain(targetVolume());
      emit('change');
    },
  );
}

function ensureAudio(): HTMLAudioElement | null {
  if (audio) return audio;
  audio = document.querySelector<HTMLAudioElement>('[data-mp-audio]');
  if (!audio) return null;

  applyGain(targetVolume());

  audio.addEventListener('timeupdate', () => {
    emit('tick');
    updateMediaPosition();
  });
  audio.addEventListener('loadedmetadata', () => {
    // 之前点过歌词 / 拖过进度条：等元数据就绪再补一次真正的跳转
    if (pendingSeek !== null) {
      const duration = Number.isFinite(audio!.duration) ? audio!.duration : pendingSeek;
      const target = Math.max(0, Math.min(pendingSeek, duration));
      pendingSeek = null;
      audio!.currentTime = target;
    }
    emit('change');
  });
  audio.addEventListener('play', () => {
    blocked = false;
    emit('change');
    syncMediaSession();
  });
  // 真的出声了才接管元素：跨域音频拿不到 CORS 时接管 = 整段静音，见 connectSource()
  audio.addEventListener('playing', () => connectSource());
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
    // 跨域音频被拒（边缘缓存里存的是别的 Origin 的 ACAO，或者压根没有）：
    // 还没接管元素时先退回「元素原生出声」——这一首没有频谱律动，但至少有声音。
    if (!mediaCorsBlocked && !sourceNode && audio!.crossOrigin === 'anonymous') {
      mediaCorsBlocked = true;
      audio!.removeAttribute('crossorigin');
      const song = audioSongId ? findSong(audioSongId) : null;
      if (song) {
        audio!.src = audioSrc(song.src);
        void audio!.play().catch(() => {});
        return;
      }
    }
    // 音频加载失败就跳到下一首，别卡住
    const playlist = currentPlaylist();
    if (playlist && playlist.songs.length > 1) next({ silent: true });
  });

  return audio;
}

/**
 * 跨域音频要接进 Web Audio 图就必须过 CORS。而边缘（EdgeOne）是按「URL」缓存的、
 * 不看 Vary —— 它存的是**首个回源请求**那个 Origin 的 Access-Control-Allow-Origin，
 * 早先留下的旧副本更是压根没有这个头。所以带上版本号重新回源取一份干净的。
 *
 * 本地开发必须用另一个标签：否则 127.0.0.1 的 ACAO 会被写进边缘缓存，
 * 线上反而拿不到授权（缓存 key 里没有 Origin，两边会撞在一起）。
 * 哪天 CORS 配置再变，把版本号 +1 即可。
 */
const MEDIA_CORS_TAG = location.hostname.endsWith('melodyxz.top') ? 'cors=3' : 'dev=3';

function audioSrc(url: string): string {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.origin === location.origin) return url; // 同源不用打标
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${MEDIA_CORS_TAG}`;
  } catch {
    return url;
  }
}

function loadSong(id: string, options: { autoplay?: boolean; remember?: boolean } = {}): void {
  const el = ensureAudio();
  const song = findSong(id);
  if (!el || !song) return;

  const { autoplay = true, remember = true } = options;
  const owner = findPlaylistOf(id);
  const previous = songId;
  if (owner) playlistId = owner.id;
  songId = id;
  blocked = false;

  // 换到另一首才记历史；「上一首」退回来的时候不要再记一遍（否则按两下原地打转）
  if (remember && previous && previous !== id) {
    if (history[history.length - 1] !== previous) history.push(previous);
    if (history.length > HISTORY_MAX) history.shift();
  }

  // 换歌：上一首没走完的淡入淡出不该落到这一首身上
  stopFade();
  applyGain(targetVolume());

  if (audioSongId !== id) {
    audioSongId = id;
    // 上一首要是因为 CORS 降级过，换歌时重新给一次机会
    mediaCorsBlocked = false;
    el.setAttribute('crossorigin', 'anonymous');
    el.preload = 'auto';
    el.src = audioSrc(song.src);
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

  // 正在淡出 → 说明是想继续（按了两下），别再把它停掉
  const fadingOut = fadeAfter !== null;
  if (el.paused || fadingOut) {
    stopFade();
    fadeInAndPlay();
  } else {
    fadeOutAndPause();
  }
}

export function pause(): void {
  if (!audio) return;
  fadeOutAndPause();
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

  // 队首正好是当前这首（按过「上一首」退回来之后会遇到）就往后挪：下一首不该原地重开
  let picked = shuffleBag.shift() ?? null;
  while (picked === songId && shuffleBag.length) picked = shuffleBag.shift() ?? null;
  return picked;
}

export function next(options: { fromEnd?: boolean; silent?: boolean } = {}): void {
  const playlist = currentPlaylist();
  if (!playlist || !playlist.songs.length) return;

  /* 随机播放：下一首永远是新的随机（同一轮里不重复），
     换走的那首会被 loadSong 记进历史，好让「上一首」退得回去 */
  if (mode === 'shuffle') {
    const id = nextShuffled();
    if (id) loadSong(id, { autoplay: true });
    return;
  }

  // 列表循环：最后一首的下一首是第一首（下标取模，首尾相接）
  const index = playlist.songs.findIndex((item) => item.id === songId);
  const target = playlist.songs[(index + 1) % playlist.songs.length];
  if (target) loadSong(target.id, { autoplay: !options.silent });
}

export function prev(): void {
  const playlist = currentPlaylist();
  if (!playlist || !playlist.songs.length) return;

  /* 随机播放：上一首 = 真的退回到上一首（历史栈顶），不是再随机一首。
     这里不套「听超过 3 秒先从头放」那条 —— 随机模式下历史里明明有上一首，
     按上一首却原地重放会让人以为按坏了。历史空（刚进页面 / 只听过这一首）
     才退化成「从头再来」。 */
  if (mode === 'shuffle') {
    const back = history.pop();
    if (back) {
      loadSong(back, { autoplay: true, remember: false });
      return;
    }
    const el = ensureAudio();
    if (el && audioSongId === songId) {
      el.currentTime = 0;
      if (el.paused) void el.play().catch(() => {});
    }
    return;
  }

  /* 列表循环：按「上一首」就是换上一首 —— 第 1 首的上一首是最后一首（下标取模，首尾相接）。
     以前这里套了一条「已经放了 3 秒以上就先把这首从头放」的规则，结果听了一会儿
     （尤其是在全屏里听）按上一首只会把当前这首重播，看着像按钮坏了，所以去掉了。
     只有歌单里就一首歌的时候没有「上一首」可退，才退化成从头再来。 */
  const el = ensureAudio();
  if (playlist.songs.length === 1) {
    if (el && audioSongId === songId) {
      el.currentTime = 0;
      if (el.paused) void el.play().catch(() => {});
    }
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
  const target = Math.max(0, seconds);
  const song = currentSong();

  // 这首歌还没加载过（刚进页面、一直没按播放）：先把音源挂上，
  // 位置记在 pendingSeek 里，metadata 到了再真跳 —— 否则点歌词没反应。
  if (song && audioSongId !== song.id) {
    pendingSeek = target;
    loadSong(song.id, { autoplay: false });
    emit('change');
    return;
  }

  // 元数据还没到（readyState = HAVE_NOTHING）时 currentTime 是写不进去的
  if (el.readyState === 0) {
    pendingSeek = target;
    el.preload = 'auto';
    emit('change');
    return;
  }

  pendingSeek = null;
  el.currentTime = Math.min(target, Number.isFinite(el.duration) ? el.duration : target);
  emit('change');
}

export function setVolume(value: number): void {
  volume = Math.max(0, Math.min(1, value));
  if (muted && volume > 0) muted = false;
  // 用户亲手拖音量：正在跑的渐变立刻作废，听手感（淡出没走完的暂停照样执行）
  const after = stopFade();
  if (audio) applyGain(targetVolume());
  after?.();
  save();
  emit('change');
}

export function toggleMute(): void {
  muted = !muted;
  const after = stopFade();
  if (audio) applyGain(targetVolume());
  after?.();
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
  if (audio) applyGain(targetVolume());
}

/**
 * 组件里直接调用一次即可：内部做了幂等，ClientRouter 换页重复调用没副作用。
 */
export function setupPlayer(): void {
  onPageLoad(start);
}

/* 模块被 import 的瞬间也尝试启动一次 */
setupPlayer();
