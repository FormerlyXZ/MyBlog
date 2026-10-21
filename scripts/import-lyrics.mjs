#!/usr/bin/env node
/**
 * 批量导入本地 .lrc 歌词 → config/music.json
 * ============================================================
 * 站点的歌词是**内联**在 config/music.json 的 songs[].lyrics 里的
 * （和「站点配置 → 音乐库」里直接粘贴 LRC 是同一份数据），
 * 所以这里做的事就是：扫描一个目录里的 .lrc，按「歌名 + 歌手」配对，
 * 把文本写进对应歌曲的 lyrics 字段。
 *
 * 用法：
 *   node scripts/import-lyrics.mjs                       # 默认扫 C:\Users\<你>\Music
 *   node scripts/import-lyrics.mjs --from "D:\歌词"      # 指定目录
 *   node scripts/import-lyrics.mjs --dry-run             # 只打印配对结果，不写文件
 *   node scripts/import-lyrics.mjs --force               # 覆盖已有歌词（默认只填空的）
 *
 * 文件名约定：`歌名 - 歌手.lrc`（也让 `歌名.lrc`、`歌手-歌名.lrc` 尽量匹配上，
 * 靠的是「去掉标点空格后模糊比对」，对不上只会跳过，不会写错）。
 * ============================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'music.json');

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const FROM = path.resolve(value('from', path.join(os.homedir(), 'Music')));
const DRY = flag('dry-run');
const FORCE = flag('force');

/* ---------------- 文本归一化 ---------------- */

/** 只留下「有信息量」的字符：字母、数字、各种文字；标点空格一律干掉 */
function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s''"“”‘’·・.,，。、!！?？;；:：\-–—_/\\|()（）[\]【】{}{}<>《》…~～*#&+=]/g, '')
    .trim();
}

/** 歌手字段可能用 、 , ; & / 分隔多人 */
function artistTokens(value) {
  return String(value ?? '')
    .split(/[、,;/&]|feat\.?|ft\.?/i)
    .map(norm)
    .filter(Boolean);
}

/** 文件名 → { title, artist } */
function parseName(file) {
  const base = path.basename(file).replace(/\.lrc$/i, '').trim();
  const cut = base.lastIndexOf(' - ');
  if (cut > 0) return { title: base.slice(0, cut).trim(), artist: base.slice(cut + 3).trim() };
  return { title: base, artist: '' };
}

/* ---------------- 打分配对 ---------------- */

const TITLE_EXACT = 100;
const TITLE_CONTAIN = 55;
const ARTIST_HIT = 30; // 每个对上的歌手
const ARTIST_MISS = -12;

function score(song, file) {
  const st = norm(song.title);
  const ft = norm(file.title);
  if (!st || !ft) return -1;

  let total;
  if (st === ft) total = TITLE_EXACT;
  else if (ft.length >= 2 && st.includes(ft)) total = TITLE_CONTAIN;
  else if (st.length >= 2 && ft.includes(st)) total = TITLE_CONTAIN;
  else return -1; // 歌名对不上，直接放弃（宁可漏，不可错）

  // 文件名里的歌手逐个看是否出现在歌曲歌手字段中
  const songParts = artistTokens(song.artist);
  const fileParts = artistTokens(file.artist);
  for (const part of fileParts) {
    const hit = songParts.some((own) => own === part || own.includes(part) || part.includes(own));
    total += hit ? ARTIST_HIT : ARTIST_MISS;
  }

  // 歌名完全一致 + 歌手也对上 → 加分，保证唯一命中
  return total;
}

/* ---------------- 主流程 ---------------- */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.lrc$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function readLrc(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function main() {
  if (!fs.existsSync(FROM)) {
    console.error(`找不到目录：${FROM}\n用 --from 指定歌词所在目录。`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const songs = [];
  for (const playlist of config.playlists ?? []) {
    for (const song of playlist.songs ?? []) songs.push(song);
  }
  if (!songs.length) {
    console.error('config/music.json 里没有歌曲，先导入音乐再来。');
    process.exit(1);
  }

  const files = walk(FROM);
  console.log(`歌词目录：${FROM}`);
  console.log(`扫描到 ${files.length} 个 .lrc，音乐库 ${songs.length} 首歌\n`);

  const timedLines = (text) =>
    text.split('\n').filter((line) => /\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(line)).length;

  // 先把每个文件配到歌曲上（一首歌可能命中多个文件，比如不同目录里的同一首），
  // 再给每首歌挑「时间轴最完整」的那一份，避免被残缺歌词覆盖。
  /** @type {Map<string, {song: any, candidates: {file: string, text: string, score: number, lines: number}[]}>} */
  const buckets = new Map();
  let unmatched = 0;

  for (const file of files) {
    const parsed = parseName(file);
    let best = null;
    let bestScore = -Infinity;

    for (const song of songs) {
      const s = score(song, parsed);
      if (s > bestScore) {
        bestScore = s;
        best = song;
      }
    }

    const label = path.basename(file);
    if (!best || bestScore <= 0) {
      console.log(`✗ 配对失败  ${label}`);
      unmatched++;
      continue;
    }

    const text = readLrc(file);
    if (!text) {
      console.log(`✗ 空文件    ${label}`);
      unmatched++;
      continue;
    }

    const bucket = buckets.get(best.id) ?? { song: best, candidates: [] };
    bucket.candidates.push({ file: label, text, score: bestScore, lines: timedLines(text) });
    buckets.set(best.id, bucket);
  }

  let written = 0;
  let kept = 0;
  let deduped = 0;

  for (const { song, candidates } of buckets.values()) {
    candidates.sort((a, b) => b.lines - a.lines || b.score - a.score);
    const winner = candidates[0];
    deduped += candidates.length - 1;
    for (const other of candidates.slice(1)) {
      console.log(`· 忽略重复  ${other.file}（《${song.title}》取时间轴更全的那份）`);
    }

    const state = !song.lyrics
      ? '新增'
      : song.lyrics.trim() === winner.text
        ? '内容相同'
        : '覆盖旧歌词';
    if (state !== '新增' && !FORCE) {
      console.log(`= 已有歌词  ${winner.file} → 《${song.title}》(${winner.score} 分)`);
      kept++;
      continue;
    }

    console.log(
      `✓ ${state}  ${winner.file} → 《${song.title}》  ${winner.score} 分 · ${winner.lines} 行时间轴`,
    );
    song.lyrics = winner.text;
    written++;
  }

  const missing = songs.filter((song) => !song.lyrics);
  console.log(
    `\n结果：写入 ${written} 首，保留 ${kept} 首，跳过 ${unmatched} 个文件，忽略重复 ${deduped} 份`,
  );
  console.log(`音乐库现在有 ${songs.length - missing.length}/${songs.length} 首歌带歌词`);
  if (missing.length) {
    console.log(`还没歌词：${missing.map((s) => `《${s.title}》`).join(' ')}`);
  }

  if (DRY) {
    console.log('\n--dry-run：没有写入 config/music.json');
    return;
  }
  if (!written) {
    console.log('\n没有变化，不写文件。');
    return;
  }

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`\n已写入 ${path.relative(ROOT, CONFIG_PATH)}，记得重新 build / 提交部署。`);
}

main();
