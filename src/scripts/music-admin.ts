/**
 * /config → 音乐库
 * ============================================================
 * 站长在这里上传本地音乐：音频、封面、歌词，全部提交进仓库
 * （public/music/… + config/music.json），部署后由音乐页和左下角
 * 迷你碟片读取，全站不调用任何第三方音乐接口。
 *
 * 交互约定：
 *   · 改动先留在内存（draft），点「保存并提交」才写仓库
 *   · 一次保存 = 一次 commit：音频二进制 + music.json 同时提交，
 *     不会出现「配置改了、歌还没传上去」的半截状态
 *   · 选完音频会读一次时长，自动把文件名拆成「歌手 - 歌名」
 * ============================================================
 */

import { onPageLoad } from './pageload';
import { getEditSession, onEditAuthChange, showToast } from '../utils/site';
import { commitFiles, getFile, type FileChange } from '../utils/github';

const MUSIC_PATH = 'config/music.json';
const AUDIO_DIR = 'public/music/audio';
const COVER_DIR = 'public/music/covers';
/** 单个音频上限：GitHub 单文件上限 100MB，但仓库会被撑爆，这里留个更实用的门 */
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

/* ---------------- 数据模型 ---------------- */

interface DraftSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  src: string;
  cover: string;
  duration: number;
  lyrics: string;
  /* 还没提交的文件 */
  audioFile?: File;
  coverFile?: File;
  /* 选完文件的本地预览地址 */
  audioPreview?: string;
  coverPreview?: string;
}

interface DraftPlaylist {
  id: string;
  name: string;
  description: string;
  cover: string;
  coverFile?: File;
  coverPreview?: string;
  songs: DraftSong[];
}

let playlists: DraftPlaylist[] = [];
let dirty = false;
let loading = false;
let loaded = false;
let boundDelegates = false;

/** 哪些行的「歌词」折叠块是展开的（重绘后要还原） */
const openLyrics = new Set<string>();

/* ---------------- 小工具 ---------------- */

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
}

function setStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-ma-status]');
  if (el) el.textContent = text;
}

function markDirty(): void {
  dirty = true;
  setStatus('有未提交的改动');
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function metaFromFileName(name: string): { title: string; artist: string } {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+[\s._-]*/, '')
    .trim();

  const split = /^(.{1,40}?)\s*[-–—]\s*(.{1,60})$/.exec(base);
  if (split) return { artist: split[1]!.trim(), title: split[2]!.trim() };
  return { title: base || '未命名曲目', artist: '' };
}

/** 读音频文件的时长（VBR 的一些格式读不到就算了，不阻塞流程） */
function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const finish = (value: number): void => {
      if (settled) return;
      settled = true;
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };

    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => finish(audio.duration), { once: true });
    audio.addEventListener('error', () => finish(0), { once: true });
    window.setTimeout(() => finish(audio.duration), 8000);
    audio.src = url;
  });
}

/* ---------------- 读写仓库 ---------------- */

function normalizeSong(raw: Record<string, unknown>): DraftSong {
  return {
    id: String(raw.id ?? '') || uid('song'),
    title: String(raw.title ?? ''),
    artist: String(raw.artist ?? ''),
    album: String(raw.album ?? ''),
    src: String(raw.src ?? ''),
    cover: String(raw.cover ?? ''),
    duration: Number(raw.duration) > 0 ? Number(raw.duration) : 0,
    lyrics: String(raw.lyrics ?? ''),
  };
}

function normalizePlaylist(raw: Record<string, unknown>): DraftPlaylist {
  const songs = Array.isArray(raw.songs) ? raw.songs : [];
  return {
    id: String(raw.id ?? '') || uid('list'),
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    cover: String(raw.cover ?? ''),
    songs: songs
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(normalizeSong),
  };
}

async function load(): Promise<void> {
  if (loading || !getEditSession()) return;
  loading = true;
  setStatus('读取中…');
  try {
    const file = await getFile(MUSIC_PATH);
    if (file) {
      const parsed = JSON.parse(file.text) as { playlists?: unknown };
      const list = Array.isArray(parsed.playlists) ? parsed.playlists : [];
      playlists = list
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map(normalizePlaylist);
      setStatus('已读取最新音乐库');
    } else {
      playlists = [];
      setStatus('仓库里还没有 music.json，保存时会自动创建');
    }
    loaded = true;
    dirty = false;
    render();
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '音乐库读取失败');
    // 别让面板一直停在「读取中…」
    const box = document.querySelector<HTMLElement>('[data-ma-playlists]');
    if (box && !playlists.length) {
      box.innerHTML =
        '<div class="ma-empty">读取失败，点「重新读取」再试一次；如果提示授权失效，先退出写作授权再用 GitHub 重新授权。</div>';
    }
  } finally {
    loading = false;
  }
}

/* ---------------- 渲染 ---------------- */

function coverCell(
  src: string,
  preview: string | undefined,
  attrs: string,
): string {
  const url = preview || src;
  const inner = url
    ? `<img src="${escapeHtml(url)}" alt="" loading="lazy">`
    : `<span class="text-[0.5625rem] leading-tight tracking-wide">封面</span>`;
  return `<button type="button" class="ma-row__cover" title="上传封面" ${attrs}>${inner}</button>`;
}

function songRow(song: DraftSong, pi: number, si: number): string {
  const key = `${pi}:${si}`;
  const audioName = song.audioFile
    ? song.audioFile.name
    : song.src
      ? song.src.split('/').pop() ?? song.src
      : '还没有音频文件，点右上「音频」上传';
  const audioSrc = song.audioPreview || song.src;
  const duration = formatDuration(song.duration);

  return `
    <div class="ma-row" data-row data-pi="${pi}" data-si="${si}">
      ${coverCell(song.cover, song.coverPreview, `data-ma-upload="cover" data-pi="${pi}" data-si="${si}"`)}

      <div class="ma-row__fields">
        <input class="input-pill px-2.5 py-1.5 text-xs" data-ma-field="title" data-pi="${pi}" data-si="${si}"
          value="${escapeHtml(song.title)}" placeholder="歌名" aria-label="歌名">
        <input class="input-pill px-2.5 py-1.5 text-xs" data-ma-field="artist" data-pi="${pi}" data-si="${si}"
          value="${escapeHtml(song.artist)}" placeholder="歌手" aria-label="歌手">
        <input class="input-pill px-2.5 py-1.5 text-xs" data-ma-field="album" data-pi="${pi}" data-si="${si}"
          value="${escapeHtml(song.album)}" placeholder="专辑（可选）" aria-label="专辑">
      </div>

      <div class="ma-row__actions">
        <button type="button" class="btn-pill px-2.5 py-1 text-[0.6875rem]" data-ma-upload="audio" data-pi="${pi}" data-si="${si}">
          ${song.audioFile ? '更换音频' : '音频'}
        </button>
        <button type="button" class="config-icon-btn" data-ma-remove-song data-pi="${pi}" data-si="${si}" title="删除这首歌">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"/></svg>
        </button>
      </div>

      <div class="ma-audio">
        <span class="ma-audio__name">${escapeHtml(audioName)}</span>
        ${duration ? `<span class="shrink-0">${duration}</span>` : ''}
        ${
          audioSrc
            ? `<audio class="ma-audio__player" controls preload="none" src="${escapeHtml(audioSrc)}"></audio>`
            : ''
        }
      </div>

      <details class="w-full" ${openLyrics.has(key) ? 'open' : ''} data-ma-details data-pi="${pi}" data-si="${si}">
        <summary class="mt-1 cursor-pointer text-[0.6875rem] text-base-content/45">
          歌词（LRC 时间轴 / 纯文本）${song.lyrics ? ' · 已有' : ' · 空'}
        </summary>
        <textarea class="ma-lyrics" data-ma-field="lyrics" data-pi="${pi}" data-si="${si}"
          spellcheck="false" placeholder="[00:12.34]第一句歌词&#10;[00:16.90]第二句歌词">${escapeHtml(song.lyrics)}</textarea>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" class="btn-pill px-2.5 py-1 text-[0.6875rem]" data-ma-upload="lrc" data-pi="${pi}" data-si="${si}">
            上传 .lrc 文件
          </button>
          <span class="ma-note">支持 [mm:ss.xx] 时间轴，也可以直接写纯文本（不跟唱，只滚动）</span>
        </div>
      </details>

      <input type="file" accept="audio/*" hidden data-ma-file="audio" data-pi="${pi}" data-si="${si}">
      <input type="file" accept="image/*" hidden data-ma-file="cover" data-pi="${pi}" data-si="${si}">
      <input type="file" accept=".lrc,.txt,text/plain" hidden data-ma-file="lrc" data-pi="${pi}" data-si="${si}">
    </div>`;
}

function playlistCard(playlist: DraftPlaylist, pi: number): string {
  const songs = playlist.songs.map((song, si) => songRow(song, pi, si)).join('');
  return `
    <div class="ma-playlist" data-card data-pi="${pi}">
      <div class="ma-playlist__head">
        ${coverCell(playlist.cover, playlist.coverPreview, `data-ma-upload="playlist-cover" data-pi="${pi}"`)}
        <input class="input-pill ma-playlist__name px-2.5 py-1.5 text-xs" data-ma-field="name" data-pi="${pi}"
          value="${escapeHtml(playlist.name)}" placeholder="歌单名，例如「写代码时听」" aria-label="歌单名">
        <input class="input-pill min-w-[8rem] flex-1 px-2.5 py-1.5 text-xs" data-ma-field="description" data-pi="${pi}"
          value="${escapeHtml(playlist.description)}" placeholder="一句话介绍（可选）" aria-label="歌单介绍">
        <button type="button" class="btn-pill px-3 py-1.5 text-xs" data-ma-add-song data-pi="${pi}">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/></svg>
          <span>添加歌曲</span>
        </button>
        <button type="button" class="config-icon-btn" data-ma-remove-playlist data-pi="${pi}" title="删除整个歌单">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"/></svg>
        </button>
      </div>
      <div class="flex flex-col">
        ${songs || '<p class="ma-note px-1 py-2">这个歌单还是空的，点「添加歌曲」开始。</p>'}
      </div>
      <input type="file" accept="image/*" hidden data-ma-file="playlist-cover" data-pi="${pi}">
    </div>`;
}

function render(): void {
  const box = document.querySelector<HTMLElement>('[data-ma-playlists]');
  if (!box) return;

  if (!playlists.length) {
    box.innerHTML = `
      <div class="ma-empty">
        还没有歌单。<br>
        点左上「新建歌单」，再往里「添加歌曲」，选好音频文件后点「保存并提交」就行。
      </div>`;
    return;
  }

  box.innerHTML = playlists.map(playlistCard).join('');
}

/* ---------------- 事件 ---------------- */

function songAt(pi: number, si: number): DraftSong | undefined {
  return playlists[pi]?.songs[si];
}

async function handleFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const pi = Number(input.dataset.pi);
  const si = Number(input.dataset.si);
  const kind = input.dataset.maFile;
  const playlist = playlists[pi];
  if (!playlist) return;

  if (kind === 'playlist-cover') {
    if (!file.type.startsWith('image/')) {
      showToast('封面要选图片文件');
      return;
    }
    if (playlist.coverPreview) URL.revokeObjectURL(playlist.coverPreview);
    playlist.coverFile = file;
    playlist.coverPreview = URL.createObjectURL(file);
    markDirty();
    render();
    return;
  }

  const song = songAt(pi, si);
  if (!song) return;

  if (kind === 'audio') {
    if (file.size > MAX_AUDIO_BYTES) {
      showToast('音频太大了（超过 40MB），建议先压一下码率');
      return;
    }
    if (song.audioPreview) URL.revokeObjectURL(song.audioPreview);
    song.audioFile = file;
    song.audioPreview = URL.createObjectURL(file);

    // 顺手指一下歌名、时长
    const meta = metaFromFileName(file.name);
    if (!song.title.trim()) song.title = meta.title;
    if (!song.artist.trim() && meta.artist) song.artist = meta.artist;

    markDirty();
    render();
    setStatus('正在读取音频时长…');
    song.duration = await probeDuration(song.audioPreview);
    if (song.duration) {
      setStatus('有未提交的改动');
      render();
    } else {
      setStatus('没读到时长，不影响播放');
    }
    return;
  }

  if (kind === 'cover') {
    if (!file.type.startsWith('image/')) {
      showToast('封面要选图片文件');
      return;
    }
    if (song.coverPreview) URL.revokeObjectURL(song.coverPreview);
    song.coverFile = file;
    song.coverPreview = URL.createObjectURL(file);
    markDirty();
    render();
    return;
  }

  if (kind === 'lrc') {
    try {
      song.lyrics = await file.text();
      openLyrics.add(`${pi}:${si}`);
      markDirty();
      render();
      showToast('歌词已读入，记得保存并提交');
    } catch {
      showToast('这个歌词文件读不出来');
    }
  }
}

async function save(): Promise<void> {
  if (!getEditSession()) {
    showToast('请先授权（页面顶部「用 GitHub 授权」）');
    return;
  }

  const stamp = Date.now();
  const changes: FileChange[] = [];
  let dropped = 0;
  let missingAudio = 0;

  setStatus('准备提交…');

  for (const playlist of playlists) {
    // 歌单封面
    if (playlist.coverFile) {
      const path = `${COVER_DIR}/${stamp}-cover-${safeFileName(playlist.coverFile.name)}`;
      changes.push({ path, binary: await playlist.coverFile.arrayBuffer() });
      playlist.cover = `/${path.replace(/^public\//, '')}`;
      playlist.coverFile = undefined;
    }

    for (const song of playlist.songs) {
      if (song.audioFile) {
        const path = `${AUDIO_DIR}/${stamp}-${safeFileName(song.audioFile.name)}`;
        setStatus(`上传中：${song.title || song.audioFile.name}`);
        changes.push({ path, binary: await song.audioFile.arrayBuffer() });
        song.src = `/${path.replace(/^public\//, '')}`;
        song.audioFile = undefined;
      }

      if (song.coverFile) {
        const path = `${COVER_DIR}/${stamp}-${safeFileName(song.coverFile.name)}`;
        changes.push({ path, binary: await song.coverFile.arrayBuffer() });
        song.cover = `/${path.replace(/^public\//, '')}`;
        song.coverFile = undefined;
      }

      if (!song.src) {
        missingAudio += 1;
        song.title = song.title || '待补充';
      }
    }
  }

  // 没有音频的条目直接丢掉（否则线上会有一首点不开的歌）
  const payload = {
    playlists: playlists
      .map((playlist) => ({
        id: playlist.id,
        name: playlist.name.trim() || '未命名歌单',
        description: playlist.description.trim() || undefined,
        cover: playlist.cover || undefined,
        songs: playlist.songs
          .filter((song) => {
            if (song.src) return true;
            dropped += 1;
            return false;
          })
          .map((song) => ({
            id: song.id,
            title: song.title.trim() || '未命名曲目',
            artist: song.artist.trim() || '未知艺术家',
            album: song.album.trim() || undefined,
            src: song.src,
            cover: song.cover || undefined,
            duration: song.duration > 0 ? Math.round(song.duration) : undefined,
            lyrics: song.lyrics.trim() || undefined,
          })),
      }))
      // 一个歌单都没有歌就别留在配置里
      .filter((playlist) => playlist.songs.length > 0),
  };

  changes.push({
    path: MUSIC_PATH,
    text: `${JSON.stringify(payload, null, 2)}\n`,
  });

  setStatus('提交中…');
  try {
    await commitFiles(changes, 'music: 更新音乐库（音频 / 封面 / 歌词）');
    dirty = false;
    loaded = true;
    setStatus('已提交，等自动部署完成后生效');
    const notes: string[] = [];
    if (dropped > 0) notes.push(`已跳过 ${dropped} 首还没选音频的歌`);
    if (missingAudio > 0 && dropped === 0) notes.push('提示：有歌还没选音频，已跳过');
    showToast(
      notes.length ? `音乐库已提交（${notes.join('；')}），约 1 分钟后生效` : '音乐库已提交，约 1 分钟后生效',
    );
    render();
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '提交失败');
  }
}

function bindDelegates(): void {
  if (boundDelegates) return;
  boundDelegates = true;

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!document.querySelector('[data-music-admin]')) return;

      if (target.closest('[data-ma-add-playlist]')) {
        playlists.push({
          id: uid('list'),
          name: `歌单 ${playlists.length + 1}`,
          description: '',
          cover: '',
          songs: [],
        });
        markDirty();
        render();
        return;
      }

      if (target.closest('[data-ma-save]')) {
        void save();
        return;
      }

      if (target.closest('[data-ma-reload]')) {
        if (dirty && !window.confirm('有未提交的改动，确定重新读取吗？')) return;
        loaded = false;
        openLyrics.clear();
        void load();
        return;
      }

      const addSong = target.closest<HTMLElement>('[data-ma-add-song]');
      if (addSong) {
        const playlist = playlists[Number(addSong.dataset.pi)];
        if (!playlist) return;
        playlist.songs.push({
          id: uid('song'),
          title: '',
          artist: '',
          album: '',
          src: '',
          cover: '',
          duration: 0,
          lyrics: '',
        });
        markDirty();
        render();
        return;
      }

      const removePlaylist = target.closest<HTMLElement>('[data-ma-remove-playlist]');
      if (removePlaylist) {
        const pi = Number(removePlaylist.dataset.pi);
        const playlist = playlists[pi];
        if (!playlist) return;
        if (!window.confirm(`删除歌单「${playlist.name || '未命名'}」及其全部歌曲？`)) return;
        playlists.splice(pi, 1);
        markDirty();
        render();
        return;
      }

      const removeSong = target.closest<HTMLElement>('[data-ma-remove-song]');
      if (removeSong) {
        const pi = Number(removeSong.dataset.pi);
        const si = Number(removeSong.dataset.si);
        playlists[pi]?.songs.splice(si, 1);
        markDirty();
        render();
        return;
      }

      const upload = target.closest<HTMLElement>('[data-ma-upload]');
      if (upload) {
        const kind = upload.dataset.maUpload;
        const pi = upload.dataset.pi ?? '0';
        const si = upload.dataset.si ?? '0';
        const selector =
          kind === 'playlist-cover'
            ? `[data-ma-file="playlist-cover"][data-pi="${pi}"]`
            : `[data-ma-file="${kind}"][data-pi="${pi}"][data-si="${si}"]`;
        const input = document.querySelector<HTMLInputElement>(selector);
        input?.click();
      }
    },
    true,
  );

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.dataset.maFile) return;
    void handleFile(target);
  });

  document.addEventListener('input', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || !target.dataset?.maField) return;
    if (!document.querySelector('[data-music-admin]')) return;

    const pi = Number(target.dataset.pi);
    const si = Number(target.dataset.si);
    const field = target.dataset.maField;
    const value = (target as HTMLInputElement | HTMLTextAreaElement).value;

    if (field === 'name' || field === 'description') {
      const playlist = playlists[pi];
      if (!playlist) return;
      if (field === 'name') playlist.name = value;
      else playlist.description = value;
    } else {
      const song = songAt(pi, si);
      if (!song) return;
      if (field === 'title') song.title = value;
      else if (field === 'artist') song.artist = value;
      else if (field === 'album') song.album = value;
      else if (field === 'lyrics') {
        song.lyrics = value;
        if (value.trim()) openLyrics.add(`${pi}:${si}`);
      }
    }
    markDirty();
  });

  // 记住哪些歌词块是展开的，重绘后还原
  document.addEventListener(
    'toggle',
    (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      if (!details.hasAttribute('data-ma-details')) return;
      const key = `${details.dataset.pi}:${details.dataset.si}`;
      if (details.open) openLyrics.add(key);
      else openLyrics.delete(key);
    },
    true,
  );

  onEditAuthChange(() => {
    if (document.querySelector('[data-music-admin]')) void load();
  });
}

/* ---------------- 入口 ---------------- */

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-music-admin]');
  if (!root) return;

  bindDelegates();

  if (getEditSession() && !loaded && !loading) void load();

  // 从音乐页的「管理音乐库」跳过来时直接展开这个板块
  if (window.location.hash === '#music') {
    document.querySelector<HTMLElement>('[data-config-tab="music"]')?.click();
  }
}

onPageLoad(init);
