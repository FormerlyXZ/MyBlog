/**
 * 音乐库数据层
 * ============================================================
 * 数据来源：config/music.json（构建输入，改完要重新 build）
 * 音频 / 封面 / 歌词全部是**站内本地文件**，不调用任何第三方接口：
 *
 *   public/music/audio/xxx.mp3      音频
 *   public/music/covers/xxx.jpg     封面
 *   public/music/lyrics/xxx.lrc     歌词（可选，也可以把 LRC 文本直接写进 JSON）
 *
 * 结构：
 *   {
 *     playlists: [
 *       {
 *         id, name, description?, cover?,
 *         songs: [{ id, title, artist, album?, src, cover?, duration?, lyrics? }]
 *       }
 *     ]
 *   }
 *
 * 站长在「站点配置 → 音乐库」上传，提交到 GitHub 后自动部署，这里只负责读。
 * ============================================================
 */

import musicJson from '../../config/music.json';

export interface MusicSong {
  /** 全局唯一 id，播放器靠它记「上次听到哪首」 */
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** 站内绝对路径，如 /music/audio/1699999999-song.mp3 */
  src: string;
  cover?: string;
  /** 时长（秒），用于列表右侧显示；0 / 缺省时以播放器实测为准 */
  duration?: number;
  /** LRC 文本（含时间轴）或纯文本歌词，一行一句 */
  lyrics?: string;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  description?: string;
  cover?: string;
  songs: MusicSong[];
}

export interface MusicConfig {
  playlists: MusicPlaylist[];
}

/* ---------------- 读取 + 容错 ---------------- */

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 把 JSON 梳理成干净的结构：
 * 缺字段补默认值、没有音频地址的歌直接丢掉（避免播放时 404）、id 重复就重编。
 */
export function normalizeMusic(raw: unknown): MusicConfig {
  const source = raw as { playlists?: unknown } | null;
  const list = Array.isArray(source?.playlists) ? source.playlists : [];
  const seenIds = new Set<string>();

  const uniqueId = (value: unknown, prefix: string, index: number): string => {
    let id = str(value).trim();
    if (!id || seenIds.has(id)) id = `${prefix}-${index + 1}`;
    let final = id;
    let bump = 1;
    while (seenIds.has(final)) final = `${id}-${++bump}`;
    seenIds.add(final);
    return final;
  };

  const playlists: MusicPlaylist[] = [];

  list.forEach((rawPlaylist, playlistIndex) => {
    const playlist = rawPlaylist as Record<string, unknown> | null;
    if (!playlist || typeof playlist !== 'object') return;

    const rawSongs = Array.isArray(playlist.songs) ? playlist.songs : [];
    const songs: MusicSong[] = [];

    rawSongs.forEach((rawSong, songIndex) => {
      const song = rawSong as Record<string, unknown> | null;
      if (!song || typeof song !== 'object') return;

      const src = str(song.src).trim();
      if (!src) return; // 没有音频文件的条目不算一首歌

      songs.push({
        id: uniqueId(song.id, 'song', songIndex),
        title: str(song.title).trim() || `未命名曲目 ${songIndex + 1}`,
        artist: str(song.artist).trim() || '未知艺术家',
        album: str(song.album).trim() || undefined,
        src,
        cover: str(song.cover).trim() || undefined,
        duration: Number(song.duration) > 0 ? Number(song.duration) : undefined,
        lyrics: str(song.lyrics).trim() || undefined,
      });
    });

    playlists.push({
      id: uniqueId(playlist.id, 'list', playlistIndex),
      name: str(playlist.name).trim() || `歌单 ${playlistIndex + 1}`,
      description: str(playlist.description).trim() || undefined,
      cover: str(playlist.cover).trim() || undefined,
      songs,
    });
  });

  return { playlists };
}

/** 构建期读到的音乐库 */
export const MUSIC: MusicConfig = normalizeMusic(musicJson);

/** 全部歌曲数（含空歌单） */
export const MUSIC_SONG_COUNT = MUSIC.playlists.reduce((sum, list) => sum + list.songs.length, 0);

/** 有歌才显示播放器 / 入口 */
export const MUSIC_READY = MUSIC_SONG_COUNT > 0;

/** 按 id 找歌（跨歌单） */
export function findSong(id: string): { song: MusicSong; playlist: MusicPlaylist } | null {
  for (const playlist of MUSIC.playlists) {
    const song = playlist.songs.find((item) => item.id === id);
    if (song) return { song, playlist };
  }
  return null;
}

/* ---------------- 给浏览器的数据 ---------------- */

/** 音乐页 / 播放器都只需要这些字段 */
export interface ClientSong {
  id: string;
  title: string;
  artist: string;
  album?: string;
  src: string;
  cover?: string;
  duration?: number;
  lyrics?: string;
}

/** 播放器全局 payload（不含歌词，体积小，全站每页都要带） */
export function toClientMusic(config: MusicConfig, options: { withLyrics?: boolean } = {}): MusicConfig {
  const { withLyrics = false } = options;
  return {
    playlists: config.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      cover: playlist.cover,
      songs: playlist.songs.map((song) => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        src: song.src,
        cover: song.cover,
        duration: song.duration,
        ...(withLyrics ? { lyrics: song.lyrics } : {}),
      })),
    })),
  };
}

/**
 * 序列化成能安全塞进 <script type="application/json"> 的字符串。
 * 重点是把 < 转义 —— 歌词里出现 "</script>" 也不会把页面拆坏。
 */
export function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 秒 → m:ss */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
