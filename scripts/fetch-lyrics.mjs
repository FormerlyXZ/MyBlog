#!/usr/bin/env node
/**
 * 用 ZonyLrcTools 自动匹配下载 LRC 歌词 → config/music.json
 * ============================================================
 * 整个流程三步走，脚本一次做完：
 *   1) 把 public/music/audio 里的音频硬链接（同盘）或复制到临时目录；
 *   2) 调用 ZonyLrcTools.Cli.exe download -d <临时目录> -l 让工具按
 *      音频内嵌的 title/artist 标签去网易云 / QQ / 酷狗 / 酷我匹配歌词；
 *   3) 清洗（去掉「作词/作曲/编曲…」这些被塞进时间轴的制作人信息、
 *      去掉 <成员名> 这类演唱者标记），按音频文件名回填到对应歌曲的
 *      songs[].lyrics 字段。站点歌词就是内联在这里的。
 *
 * 用法：
 *   node scripts/fetch-lyrics.mjs                      # 下载 + 清洗 + 全量替换
 *   node scripts/fetch-lyrics.mjs --dry-run            # 只打印结果，不写文件
 *   node scripts/fetch-lyrics.mjs --only-missing       # 只给还没有歌词的歌补
 *   node scripts/fetch-lyrics.mjs --from "E:\lrcdir"   # 复用已下载好的目录，跳过下载
 *   node scripts/fetch-lyrics.mjs --keep-credits       # 保留 作词/作曲 那几行
 *   node scripts/fetch-lyrics.mjs --threads 4          # 下载线程数（默认 4）
 *   node scripts/fetch-lyrics.mjs --keep-stage         # 保留临时目录（默认跑完就删）
 *   node scripts/fetch-lyrics.mjs --tool "D:\ZonyLrcTools.Cli.exe"
 *
 * 工具路径查找顺序：--tool > 环境变量 ZONY_LRC_TOOL >
 * %USERPROFILE%\tools\ZonyLrcTools* > %USERPROFILE%\Downloads\ZonyLrcTools*
 * ============================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'music.json');
const AUDIO_DIR = path.join(ROOT, 'public', 'music', 'audio');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus']);

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const DRY = flag('dry-run');
const ONLY_MISSING = flag('only-missing');
const KEEP_CREDITS = flag('keep-credits');
const THREADS = String(Number(value('threads', 4)) || 4);
const FROM = value('from', null);

/* ---------------- 找工具 ---------------- */

function findTool() {
  const explicit = value('tool', process.env.ZONY_LRC_TOOL);
  if (explicit) {
    const full = path.resolve(explicit);
    if (fs.existsSync(full)) return full;
    console.error(`--tool 指定的程序不存在：${full}`);
    process.exit(1);
  }

  const home = os.homedir();
  const roots = [
    path.join(home, 'tools'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    ROOT,
    path.join(ROOT, 'tools'),
  ];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // 目录本身就是工具目录的情况
    const direct = path.join(root, 'ZonyLrcTools.Cli.exe');
    if (fs.existsSync(direct)) found.push(direct);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/zony/i.test(entry.name)) continue;
      const exe = path.join(root, entry.name, 'ZonyLrcTools.Cli.exe');
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  if (!found.length) {
    console.error(
      '找不到 ZonyLrcTools.Cli.exe。\n' +
        '用 --tool 指定，或设置环境变量 ZONY_LRC_TOOL，或把工具解压到 %USERPROFILE%\\tools\\ZonyLrcTools\\。\n' +
        '下载：https://soft.myzony.com',
    );
    process.exit(1);
  }
  return found[0];
}

/* ---------------- 准备待扫描的音频 ---------------- */

/** 同盘用硬链接（0 拷贝），跨盘退回复制 */
function linkOrCopy(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

function stage(audioFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melodyx-lrc-'));
  for (const file of audioFiles) {
    linkOrCopy(file, path.join(dir, path.basename(file)));
  }
  return dir;
}

/** 自己建的临时目录，跑完删掉；下载失败时留着，方便下次 --from 复用 */
let stageDir = null;
let keepStage = false;
function cleanupStage() {
  if (!stageDir || keepStage || flag('keep-stage')) return;
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉无所谓 */
  }
}
process.on('exit', cleanupStage);

/* ---------------- 歌词清洗 ---------------- */

/**
 * 网易云会把「作词 : 某某」「录音室 : 白金」这类制作人信息也挂上时间轴
 * （开头一批、结尾一批），这些不是歌词行。判断方式是看冒号前的标签：
 *   ① 标签本身是已知的岗位 / 乐器词（CREDIT_TERMS）；
 *   ② 标签以「师 / 室 / 棚 / 助理 / 统筹 / 编写 …」这类后缀收尾。
 * 用白名单而不是「有冒号就删」—— 像《牵丝戏》里 `Aki：兰花指捻红尘似水`
 * 这种对唱歌手标记是**真歌词**，不能误伤。
 */
const CREDIT_TERMS = new Set(
  [
    // 中文岗位
    '作词', '作曲', '编曲', '词', '曲', '词曲', '制作人', '监制', '出品', '发行',
    '企划', '企划营销', '统筹', '制作统筹', '制作助理', '制作协力', '制作团队',
    '制作行政统筹', '宣传', '文案', '美术', '设计', '导演', '后期', '母带',
    '母带后期', '缩混', '录音', '混音', '配唱', '人声', '演唱', '原唱', '版权',
    // 中文岗位尾巴更长的一类（录音室 / 混音工程师 …）
    '录音师', '录音室', '录音棚', '录音工程师', '录音工程室', '助理录音师',
    '混音师', '混音室', '混音工程师', '混音工程室', '混音录音室', '母带工程师',
    // 乐器 / 编配
    '和声', '和声编写', '和声演唱', '背景和声', '吉他', '低音吉他', '贝斯', '鼓',
    '架子鼓', '键盘', '钢琴', '弦乐', '弦乐编写', '弦乐四重奏', '箫', '笛', '二胡',
    // 英文岗位
    'OP', 'SP', 'ISRC', 'A&R', 'PRODUCER', 'COMPOSER', 'LYRICIST', 'ARRANGER',
    'MIXING', 'MASTERING', 'RECORDING', 'VOCALS', 'PIANO', 'STRINGS', 'KEYBOARD',
    'KEYBOARDS & PROGRAMMING', 'GUITAR', 'GUITARS', 'BASS', 'DRUM', 'DRUMS',
    'PERCUSSION', 'MUSICIANS', 'PRODUCTION COORDINATION',
    'RECORDING ENGINEERS', 'MIXING ENGINEER', 'RECORDING STUDIO', 'MIXING STUDIO',
    'BACKGROUND VOCAL ARRANGEMENT', 'BACKGROUND VOCALS',
  ].map((word) => word.toUpperCase()),
);

const CREDIT_SUFFIX = /(师|室|棚|助理|统筹|协力|团队|编写|制作人|监制|策划|营销|协调|后期|四重奏|演奏)$/;

const CREDIT_MAX_LEN = 96;

/** 「标签 : 内容」里，标签算不算制作人信息 */
function isCreditLabel(label) {
  const name = label.normalize('NFKC').trim();
  if (!name || name.length > 32) return false;
  if (CREDIT_TERMS.has(name.toUpperCase())) return true;
  return name.length <= 12 && CREDIT_SUFFIX.test(name);
}

/** 「标签 : 内容」形式的制作人信息行 */
function isCredit(content) {
  if (content.length > CREDIT_MAX_LEN) return false;
  const match = /^([^:：]{1,32})[:：]/.exec(content.normalize('NFKC'));
  return match ? isCreditLabel(match[1]) : false;
}

/** 版权 / 制作声明行：ISRC 码、出版公司、Engineered by …、Recorded at … */
const COPYRIGHT_LINE =
  /(ISRC\b|©|℗|\bPublishing\b|\bLtd\.?$|\bInc\.?$|\b(?:Engineered|Recorded|Mixed|Mastered|Arranged|Conducted|Composed|Written|Produced)\s+(?:by|at|&)\b)/i;

/** 只在结尾连续出现的软信号（英文歌里也可能有这些词，所以只在末尾剥） */
const COPYRIGHT_TAIL = /(\bRecords\b|\bBranch\b|\bStudios?\b)/i;

/** 行内 / 行首的 <백현>、<디오>、[찬열] 这种演唱者标记（韩团歌词常见） */
const MEMBER_TAG = /[<【]\s*[^<>【】\s]{1,16}\s*[>】]/g;

const TIME_TAG = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;

/** 只留「有时间轴 + 是歌词」的行，返回清洗后的文本和统计 */
function cleanLrc(raw, song) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let credits = 0;
  let tags = 0;
  let header = 0;
  let footer = 0;

  // 记录原先的顺序（时间轴本身可能乱序）
  const entries = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || !TIME_TAG.test(line)) continue;

    const tagsInLine = line.match(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g) ?? [];
    const prefix = tagsInLine.join('');
    let content = line.slice(prefix.length).trim();

    if (!content) continue;

    if (isCredit(content) || COPYRIGHT_LINE.test(content)) {
      credits++;
      if (KEEP_CREDITS) entries.push({ prefix, content });
      continue;
    }

    // 「歌名 - 歌手」这种头部信息行
    const plain = content.replace(/\s+/g, '');
    const titlePlain = String(song.title ?? '').replace(/\s+/g, '');
    const artistPlain = String(song.artist ?? '').replace(/\s+/g, '');
    if (
      (artistPlain && plain === `${titlePlain}-${artistPlain}`) ||
      plain === titlePlain ||
      (artistPlain && plain === artistPlain)
    ) {
      header++;
      continue;
    }

    // 只收拾掉标记本身和它旁边的空格，别动原文/译文之间的分隔空格
    const stripped = content
      .replace(MEMBER_TAG, '')
      .replace(/([（(])\s+/g, '$1')
      .replace(/\s+([）)])/g, '$1')
      .trim();
    if (stripped !== content) {
      const marked = content.match(MEMBER_TAG);
      tags += marked ? marked.length : 1;
      content = stripped;
      if (!content) continue;
    }

    entries.push({ prefix, content });
  }

  // 结尾的版权声明（唱片 / 出版公司、ISRC 码）—— 只从末尾连续剥，
  // 免得误伤英文歌里带 records / branch 之类的真歌词。
  while (entries.length && COPYRIGHT_TAIL.test(entries[entries.length - 1].content)) {
    if (KEEP_CREDITS) break;
    entries.pop();
    footer++;
  }

  const out = entries.map((item) => `${item.prefix}${item.content}`);
  return { text: out.join('\n').trim(), credits: credits + footer, tags, header };
}

/* ---------------- 主流程 ---------------- */

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const songs = [];
  for (const playlist of config.playlists ?? []) {
    for (const song of playlist.songs ?? []) songs.push(song);
  }
  if (!songs.length) {
    console.error('config/music.json 里没有歌曲，先导入音乐再来。');
    process.exit(1);
  }

  /* --- 得到歌词目录 --- */
  let lrcDir;
  if (FROM) {
    lrcDir = path.resolve(FROM);
    if (!fs.existsSync(lrcDir)) {
      console.error(`--from 指定的目录不存在：${lrcDir}`);
      process.exit(1);
    }
    console.log(`复用已下载的歌词目录：${lrcDir}`);
  } else {
    const tool = findTool();
    const toolDir = path.dirname(tool);
    const audioFiles = songs
      .map((song) => path.join(ROOT, 'public', String(song.src ?? '')))
      .filter((file) => fs.existsSync(file) && AUDIO_EXT.has(path.extname(file).toLowerCase()));

    if (!audioFiles.length) {
      console.error(`在 ${AUDIO_DIR} 里没找到可扫描的音频。`);
      process.exit(1);
    }

    lrcDir = stage(audioFiles);
    stageDir = lrcDir;
    console.log(`ZonyLrcTools：${tool}`);
    console.log(`待匹配音频 ${audioFiles.length} 个 → ${lrcDir}`);
    console.log(`开始下载歌词（线程 ${THREADS}）…`);

    try {
      // cwd 必须是工具目录：它按当前目录读 config.yaml
      execFileSync(tool, ['download', '-d', lrcDir, '-l', '-n', THREADS], {
        cwd: toolDir,
        stdio: 'inherit',
        windowsHide: true,
      });
    } catch (error) {
      keepStage = true;
      console.error(`\n调用 ZonyLrcTools 失败：${error.message}`);
      console.error(`（已经下载到的歌词留在 ${lrcDir}，可以加 --from 复用）`);
    }
  }

  /* --- 回填 --- */
  const lrcFiles = new Map();
  for (const name of fs.readdirSync(lrcDir)) {
    if (/\.lrc$/i.test(name)) lrcFiles.set(path.basename(name, path.extname(name)), path.join(lrcDir, name));
  }
  console.log(`\n目录里共有 ${lrcFiles.size} 个 .lrc，音乐库 ${songs.length} 首歌`);

  let written = 0;
  let kept = 0;
  let same = 0;
  const missing = [];
  const warnings = [];

  for (const song of songs) {
    const base = path.basename(String(song.src ?? ''), path.extname(String(song.src ?? '')));
    const file = lrcFiles.get(base);

    if (!file) {
      missing.push(song);
      continue;
    }

    const raw = fs.readFileSync(file, 'utf8');
    const clean = cleanLrc(raw, song);
    const lines = clean.text ? clean.text.split('\n').length : 0;

    if (!lines) {
      missing.push(song);
      warnings.push(`《${song.title}》的 .lrc 清洗后没有歌词行，跳过`);
      continue;
    }

    if (song.lyrics && ONLY_MISSING) {
      kept++;
      console.log(`= 保留原歌词  《${song.title}》（--only-missing）`);
      continue;
    }
    if (song.lyrics && song.lyrics.trim() === clean.text) {
      same++;
      console.log(`= 内容相同    《${song.title}》 ${lines} 行`);
      continue;
    }

    const action = song.lyrics ? '替换' : '新增';
    song.lyrics = clean.text;
    written++;

    const extras = [
      clean.credits ? `去掉制作人信息 ${clean.credits} 行` : '',
      clean.tags ? `去掉演唱者标记 ${clean.tags} 处` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`✓ ${action}  《${song.title}》 ${lines} 行${extras ? ` · ${extras}` : ''}`);
  }

  const withLyrics = songs.filter((song) => song.lyrics);
  console.log(`\n结果：写入 ${written} 首，内容相同 ${same} 首，保留 ${kept} 首`);
  console.log(`音乐库 ${withLyrics.length}/${songs.length} 首歌带歌词`);
  if (missing.length) {
    console.log(
      `\n没有匹配到歌词（${missing.length} 首）：${missing.map((s) => `《${s.title}》`).join(' ')}`,
    );
    console.log('纯音乐、live 版、韩文歌名都可能匹配不到，需要的话手动在「站点配置 → 音乐库」粘贴。');
  }
  for (const warning of warnings) console.log(`! ${warning}`);

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
