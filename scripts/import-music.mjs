#!/usr/bin/env node
/**
 * 本地音乐批量导入
 * ============================================================
 * 把电脑里的无损/大文件音乐转成网页友好的 AAC（.m4a）+ 抠出内嵌封面，
 * 放进 public/music/，并生成 config/music.json。
 *
 * 用法（在项目根目录）：
 *   node scripts/import-music.mjs "C:\Users\你\Music"
 *   node scripts/import-music.mjs "C:\Users\你\Music" --playlist "我的收藏"
 *   node scripts/import-music.mjs "C:\Users\你\Music" --bitrate 192k --dry-run
 *
 * 需要 ffmpeg / ffprobe 在 PATH 里（winget install Gyan.FFmpeg）。
 *
 * 它做的事：
 *   ① 递归扫描音频文件（flac / mp3 / m4a / wav / ape / ogg / wma …）
 *   ② 同名同歌手的重复曲目自动去重（多个目录里放同一首只留一个）
 *   ③ ffprobe 读时长、标签（标题 / 歌手 / 专辑 / 歌词）
 *   ④ 内嵌封面抠成 jpg 存 public/music/covers/
 *   ⑤ ffmpeg 转 AAC 存 public/music/audio/
 *   ⑥ 写出 config/music.json（默认全部塞进一个歌单，之后可在
 *      「站点配置 → 音乐库」里再分）
 *
 * 原文件不会被改动。
 * ============================================================
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const AUDIO_EXT = new Set([
  '.flac',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ape',
  '.ogg',
  '.opus',
  '.wma',
  '.aiff',
  '.aif',
]);

const ROOT = process.cwd();
const OUT_AUDIO = path.join(ROOT, 'public/music/audio');
const OUT_COVER = path.join(ROOT, 'public/music/covers');
const MUSIC_JSON = path.join(ROOT, 'config/music.json');

/* ---------------- 参数 ---------------- */

const args = process.argv.slice(2);
const source = args.find((item) => !item.startsWith('--'));
if (!source) {
  console.error('用法：node scripts/import-music.mjs <音乐文件夹> [--playlist 名称] [--bitrate 160k] [--dry-run]');
  process.exit(1);
}

const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : true;
};

const playlistName = String(flag('playlist', '我的收藏'));
const bitrate = String(flag('bitrate', '160k'));
const dryRun = Boolean(flag('dry-run', false));
/** 太长的文件（串烧、电台、BGM 循环）默认跳过：体积大又不像是「一首歌」 */
const maxDuration = Number(flag('max-duration', 900)) || 900;
const coverQuality = 2; // ffmpeg mjpeg qscale：2 ≈ 高质量

/* ---------------- 小工具 ---------------- */

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} 退出码 ${code}\n${stderr.slice(-800)}`));
    });
  });
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** 文件名 → 文件名安全的 slug（保留中文，去掉 URL 里闹心的符号） */
function slugify(value) {
  return (
    value
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/[\s]+/g, '-')
      .replace(/[，。、,.'"“”‘’（）()《》【】\[\]{}!！?？~～·—–_]+/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'track'
  );
}

/** 「歌名 - 歌手」的常见命名拆开 */
function parseName(baseName) {
  const cleaned = baseName.replace(/^\d+[\s._-]*/, '').trim();
  const match = /^(.{1,80}?)\s*[-–—_]\s*(.{1,80})$/.exec(cleaned);
  if (match) return { title: match[1].trim(), artist: match[2].trim() };
  return { title: cleaned, artist: '' };
}

function pickTag(tags, keys) {
  for (const key of keys) {
    const value = tags?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-print_format',
    'json',
    file,
  ]);
  const data = JSON.parse(stdout);
  const format = data.format ?? {};
  const tags = format.tags ?? {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  return {
    duration: Number(format.duration) || 0,
    tags,
    hasCover: streams.some((stream) => stream.codec_type === 'video'),
    audioCodec: streams.find((stream) => stream.codec_type === 'audio')?.codec_name ?? '',
  };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!fs.existsSync(source)) {
    console.error(`找不到文件夹：${source}`);
    process.exit(1);
  }

  try {
    await run('ffmpeg', ['-version']);
    await run('ffprobe', ['-version']);
  } catch {
    console.error('没找到 ffmpeg / ffprobe，先装一个：winget install Gyan.FFmpeg');
    process.exit(1);
  }

  fs.mkdirSync(OUT_AUDIO, { recursive: true });
  fs.mkdirSync(OUT_COVER, { recursive: true });

  const files = walk(source).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  console.log(`扫到 ${files.length} 个音频文件`);

  const usedSlugs = new Set();
  const seen = new Map(); // 去重 key
  const songs = [];

  for (const [index, file] of files.entries()) {
    const relative = path.relative(source, file);
    let info;
    try {
      info = await probe(file);
    } catch (error) {
      console.warn(`  ! 跳过（读不了元信息）：${relative}\n    ${error.message.split('\n')[0]}`);
      continue;
    }

    const baseName = path.basename(file, path.extname(file));
    const fromName = parseName(baseName);
    const title = pickTag(info.tags, ['title', 'TITLE', 'Title']) || fromName.title;
    const artist = pickTag(info.tags, ['artist', 'ARTIST', 'Album_Artist', 'album_artist']) || fromName.artist || '未知艺术家';
    const album = pickTag(info.tags, ['album', 'ALBUM']);
    const lyrics = pickTag(info.tags, ['lyrics', 'LYRICS', 'unsyncedlyrics', 'UNSYNCEDLYRICS']);

    if (info.duration > maxDuration) {
      console.log(
        `  · 跳过（${Math.round(info.duration / 60)} 分钟，超过 --max-duration ${Math.round(maxDuration / 60)} 分钟）：${relative}`,
      );
      continue;
    }

    // 去重：歌名 + 歌手相同只留第一次出现的那份（按路径排序，根目录优先）
    const dedupeKey = `${title.toLowerCase()}|${artist.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      console.log(`  · 重复，跳过：${relative}  （已有 ${seen.get(dedupeKey)}）`);
      continue;
    }
    seen.set(dedupeKey, relative);

    let slug = slugify(`${artist === '未知艺术家' ? '' : `${artist}-`}${title}`) || `track-${index + 1}`;
    while (usedSlugs.has(slug)) slug = `${slug}-2`;
    usedSlugs.add(slug);

    const audioRel = `/music/audio/${slug}.m4a`;
    const coverRel = `/music/covers/${slug}.jpg`;
    const audioOut = path.join(OUT_AUDIO, `${slug}.m4a`);
    const coverOut = path.join(OUT_COVER, `${slug}.jpg`);

    let cover = '';
    if (info.hasCover) {
      try {
        if (!dryRun) {
          await run('ffmpeg', [
            '-y',
            '-v',
            'error',
            '-i',
            file,
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-q:v',
            String(coverQuality),
            coverOut,
          ]);
        }
        cover = coverRel;
      } catch {
        console.warn(`  ! 封面抠不出来：${relative}`);
      }
    }

    if (!dryRun) {
      await run('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-i',
        file,
        '-vn',
        '-c:a',
        'aac',
        '-b:a',
        bitrate,
        '-movflags',
        '+faststart',
        audioOut,
      ]);
    }

    const stat = dryRun ? { size: 0 } : fs.statSync(audioOut);
    songs.push({
      id: `song-${slug}`,
      title,
      artist,
      album: album || undefined,
      src: audioRel,
      cover: cover || undefined,
      duration: Math.round(info.duration),
      lyrics: lyrics || undefined,
      _debug: { relative, sizeMB: (stat.size / 1048576).toFixed(1) },
    });

    console.log(
      `  ✓ ${title} — ${artist}  ${Math.round(info.duration)}s  ${(stat.size / 1048576).toFixed(1)}MB  ${cover ? '含封面' : '无封面'}`,
    );
  }

  if (!songs.length) {
    console.error('一首都没导进来。');
    process.exit(1);
  }

  const payload = {
    playlists: [
      {
        id: 'pl-favorites',
        name: playlistName,
        description: undefined,
        cover: songs.find((song) => song.cover)?.cover,
        songs: songs.map(({ _debug, ...song }) => song),
      },
    ],
  };

  const totalMB = songs.reduce((sum, song) => sum + Number(song._debug.sizeMB), 0).toFixed(1);

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    console.log(`\n[dry-run] 一共 ${songs.length} 首，预计占用 ${totalMB}MB`);
    return;
  }

  fs.writeFileSync(MUSIC_JSON, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n完成：${songs.length} 首，共 ${totalMB}MB`);
  console.log(`  音频 → public/music/audio/`);
  console.log(`  封面 → public/music/covers/`);
  console.log(`  配置 → config/music.json（歌单「${playlistName}」）`);
  console.log('\n接着 npm run build 就能看到效果；要上线就提交并推送。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
