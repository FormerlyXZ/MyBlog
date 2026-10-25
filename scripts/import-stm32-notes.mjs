#!/usr/bin/env node
/**
 * 语雀笔记 → 博客「系列文章」导入器
 * ============================================================
 * 把 C:\Users\FormerlyXZ\Downloads\yuque-dl-main\STM32单片机学习笔记 导成
 * src/content/posts/stm32/ 下的 1 个目录页 + 10 个章节 md，并顺手做三件事：
 *
 *   ① 清洗语雀痕迹
 *      · 去掉 <font style="…"> 内联样式（源文件里有 985 处）
 *      · 还原被转义的 \_ \* \[ \] 等（否则加粗显示不出来）
 *      · 删掉每篇末尾的「> 更新: …」「> 原文: <yuque 链接>」
 *      · 一级标题降为正文小节标题（H1→H2，其余各级顺移，保证一个文件只有一个 H1）
 *   ② 合并：一章里的若干「讲」按顺序并成一个 md，章 = 一篇
 *   ③ 图片：207 张 PNG 转 WebP（宽 >1600 缩放），统一放
 *      public/images/series/stm32/chNN/，正文里的相对路径改写成 /images/…
 *
 * 时间统一写今天（2026-10-25）；章节顺序靠 frontmatter 的 seriesOrder，
 * 不依赖日期，所以以后想改顺序只要改数字。
 *
 * 用法（在博客根目录）：
 *   node scripts/import-stm32-notes.mjs            # 直接导入
 *   node scripts/import-stm32-notes.mjs --dry-run  # 只统计，不写文件
 * ============================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const SRC = String.raw`C:\Users\FormerlyXZ\Downloads\yuque-dl-main\STM32单片机学习笔记`;
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'src', 'content', 'posts', 'stm32');
const IMG_DIR = path.join(ROOT, 'public', 'images', 'series', 'stm32');

const SERIES_SLUG = 'stm32';
const SERIES_TITLE = 'STM32 单片机学习笔记';
/**
 * 系列导读页的封面。故意放在 public/covers/（不在本脚本清理的
 * public/images/series/stm32/ 里面），重新导入不会被删掉。
 */
const SERIES_COVER = '/covers/stm32-series.webp';
const TODAY = '2026-10-25';
const DRY = process.argv.includes('--dry-run');

/** 章节定义：目录名 → 输出元数据（顺序 = 最终 seriesOrder） */
const CHAPTERS = [
  {
    dir: '第一章_2eEwK0tc_zLNzfAz',
    file: '01-preparation',
    title: '第一章 准备：环境搭建与芯片认识',
    description: 'Keil MDK 环境搭建、STM32F103 的基本信息与引脚分布，第一个程序跑通。',
    tags: ['开发环境', 'Keil', '引脚'],
  },
  {
    dir: '第二章_9ua2K25tzeb5slSr',
    file: '02-gpio',
    title: '第二章 GPIO：输出输入模式与 LED、按钮实验',
    description: 'GPIO 的 4 种输出模式、IO 最大输出速度、4 种输入模式，以及闪灯与按钮实验。',
    tags: ['GPIO', 'LED'],
  },
  {
    dir: '第三章_nUn3cKiQhpWISAdg',
    file: '03-usart',
    title: '第三章 串口：通信协议与 USART 收发',
    description: '串口通信协议、USART 模块用法、IO 引脚初始化、发送与接收数据、格式化打印与常用功能封装。',
    tags: ['串口', 'USART'],
  },
  {
    dir: '第四章_0xTtPL_DloTr8-SX',
    file: '04-i2c',
    title: '第四章 I2C：协议、读写数据与 OLED 显示',
    description: 'I2C 电路结构与通信协议、模块使用方法、读 / 写数据、软 I2C、功能封装，最后驱动 OLED 显示器。',
    tags: ['I2C', 'OLED'],
  },
  {
    dir: '第五章_QLXe57kARgEMTXaX',
    file: '05-spi',
    title: '第五章 SPI：协议、按钮驱动与 W25Q64 实验',
    description: 'SPI 电路结构与协议、按钮驱动程序、IO 与 SPI 模块初始化、数据收发，以及 W25Q64 读写实验。',
    tags: ['SPI', 'W25Q64'],
  },
  {
    dir: '第六章_sTHyfcI-B46llCgg',
    file: '06-interrupt',
    title: '第六章 中断：概念、优先级与串口中断实验',
    description: '中断的概念、NVIC 中断优先级，以及用串口中断重写接收流程。',
    tags: ['中断', 'NVIC'],
  },
  {
    dir: '第七章_FBwRqQnMbsxrvdDM',
    file: '07-exti',
    title: '第七章 EXTI：外部中断原理与按钮实验',
    description: 'EXTI 外部中断的工作原理、AFIO 与 EXTI 配置，并用外部中断重做按钮实验。',
    tags: ['EXTI', '外部中断'],
  },
  {
    dir: '第八章_2yp1WCOG1lBYZ2Dt',
    file: '08-rcc',
    title: '第八章 时钟：时钟树与编程配置',
    description: 'STM32 时钟树结构，以及用 RCC 相关函数把系统时钟配到 72MHz 的编程方法。',
    tags: ['时钟', 'RCC'],
  },
  {
    dir: '第九章_1jVXF0CKtmFvtu7l',
    file: '09-timer',
    title: '第九章 定时器：时基单元、PWM 与输入捕获',
    description: '时基单元与自制延迟函数、输出比较与呼吸灯、输入捕获、超声波测距、从模式控制器、PWM 参数测量。',
    tags: ['定时器', 'PWM'],
  },
  {
    dir: '第十章_63boZ-5g7EGvTWXQ',
    file: '10-adc',
    title: '第十章 ADC：逐次逼近、采样时间与多通道转换',
    description: '逐次逼近型 ADC 原理、ADC 结构框图、采样与转换时间、常规单通道转换、定时器触发与扫描模式。',
    tags: ['ADC'],
  },
];

/* ------------------------------------------------------------------
 * 文本清洗
 * ------------------------------------------------------------------ */

/** 语雀把「更新 / 原文」这类尾巴写成了引用块，逐行删掉 */
const FOOTER_RE = /^>\s*(更新|原文)\s*[:：]/;

/** 标题：H1 → H2，其余各级顺移一级（最多 H6） */
function shiftHeading(line) {
  const match = line.match(/^(#{1,6})(\s+)(.*)$/);
  if (!match) return line;
  const depth = Math.min(6, match[1].length + 1);
  return `${'#'.repeat(depth)}${match[2]}${match[3]}`;
}

/** 还原 markdown 转义（语雀会把中文里的 * _ [ ] 都转义，导致加粗 / 斜体失效） */
function unescapeMd(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
}

/** 去掉 <font style="…"> 这类内联样式标签，只留文字 */
function stripFontTags(text) {
  return text.replace(/<\/?font\b[^>]*>/gi, '');
}

/** URL 里残留的 %20 之类还原成人能读的字符（书名号里的文件名） */
function decodePercent(text) {
  return text.replace(/%20/g, ' ');
}

/* ------------------------------------------------------------------
 * 读取一章：按 index.md 的顺序，把若干「讲」并成一份
 * ------------------------------------------------------------------ */

/** 从 index.md 里读出某章下面的 .md 相对路径（保持语雀里的顺序） */
function orderFromIndex(chapterDir) {
  const indexPath = path.join(SRC, 'index.md');
  if (!fs.existsSync(indexPath)) return [];
  const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/);
  const wanted = `${chapterDir}/`;
  const files = [];
  for (const line of lines) {
    const match = line.match(/\]\(([^)]+\.md)\)/);
    if (!match) continue;
    const rel = decodeURIComponent(match[1]);
    if (rel.startsWith(wanted)) files.push(rel);
  }
  return files;
}

/** 兜底：直接扫目录，按文件名前面的数字排序 */
function scanChapter(chapterDir) {
  const dir = path.join(SRC, chapterDir);
  if (!fs.existsSync(dir)) {
    console.warn(`  ⚠ 目录不存在：${chapterDir}`);
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => {
      const na = parseFloat(a) || 0;
      const nb = parseFloat(b) || 0;
      return na - nb;
    })
    .map((name) => `${chapterDir}/${name}`);
}

/* ------------------------------------------------------------------
 * 图片：转 WebP + 去重
 * ------------------------------------------------------------------ */

const imageCache = new Map(); // 源文件绝对路径 → 输出 URL
const imageByHash = new Map(); // 内容 md5 → 输出 URL（语雀里同一张截图可能被贴两处）
let imageCount = 0;
let imageBytesIn = 0;
let imageBytesOut = 0;
let imageReused = 0;

function hashFile(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

async function convertImage(absSrc, chapterNo, seq) {
  if (imageCache.has(absSrc)) {
    imageReused += 1;
    return imageCache.get(absSrc);
  }
  if (!fs.existsSync(absSrc)) return null;

  // 内容完全相同的图片只留一份，正文里复用同一个地址
  const digest = hashFile(absSrc);
  const known = imageByHash.get(digest);
  if (known) {
    imageReused += 1;
    imageCache.set(absSrc, known);
    return known;
  }

  const outName = `${String(seq).padStart(2, '0')}.webp`;
  const outDir = path.join(IMG_DIR, `ch${chapterNo}`);
  const outAbs = path.join(outDir, outName);
  const url = `/images/series/${SERIES_SLUG}/ch${chapterNo}/${outName}`;

  imageBytesIn += fs.statSync(absSrc).size;

  if (!DRY) {
    fs.mkdirSync(outDir, { recursive: true });
    await sharp(absSrc)
      .resize({ width: 1600, withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toFile(outAbs);
    imageBytesOut += fs.statSync(outAbs).size;
  }

  imageCount += 1;
  imageCache.set(absSrc, url);
  imageByHash.set(digest, url);
  return url;
}

const IMG_RE = /!\[([^\]]*)\]\(\.\/img\/([^/]+)\/([^)\s]+)\)/g;

/**
 * 一行里可能有多张图，甚至图片被塞在标题里（语雀常见），
 * 所以整行扫一遍，能换几个换几个。
 */
async function replaceImages(line, absPath, chapterNo, state) {
  const matches = [...line.matchAll(IMG_RE)];
  if (!matches.length) return line;

  let result = line;
  for (const match of matches) {
    const [full, , docId, fileName] = match;
    const absSrc = path.join(path.dirname(absPath), 'img', docId, fileName);
    state.imageSeq += 1;
    const url = await convertImage(absSrc, chapterNo, state.imageSeq);
    if (url) {
      result = result.split(full).join(`![](${url})`);
    } else {
      console.warn(`  ⚠ 图片缺失，已跳过：${path.relative(SRC, absSrc)}`);
      result = result.split(full).join('');
    }
  }

  // 「#### ![](x.webp)」这种把图片当标题用的，标题本身就是图片文件名，没意义，降成普通图片
  result = result.replace(/^#{1,6}\s+(?=!\[\]\()/, '');

  return result;
}

/* ------------------------------------------------------------------
 * 处理一个 md 文件 → 清洗后的正文行
 * ------------------------------------------------------------------ */

async function cleanFile(relPath, chapterNo, state) {
  const absPath = path.join(SRC, relPath);
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/);

  const out = [];
  let inFence = false;
  let seenFirstHeading = false;

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    // 代码块内部原样保留（不做转义还原、不删标签）
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // 语雀文末的「更新 / 原文」
    if (FOOTER_RE.test(line)) continue;

    // 图片：![alt](./img/<docId>/<file>) → /images/series/stm32/chNN/NN.webp
    if (line.includes('./img/')) {
      line = await replaceImages(line, absPath, chapterNo, state);
      if (!line.trim()) continue;
      out.push(line);
      continue;
    }

    line = stripFontTags(line);
    line = decodePercent(line);
    line = unescapeMd(line);

    // 第一篇的一级标题降级成小节标题；其余标题整体下移一级
    if (/^#{1,6}\s+/.test(line) && !seenFirstHeading) {
      seenFirstHeading = true;
      out.push(shiftHeading(line));
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      line = shiftHeading(line);
    }

    out.push(line);
  }

  // 收尾：去掉开头多余空行与结尾多余空行
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();

  return out;
}

/* ------------------------------------------------------------------
 * 写一个章节 md
 * ------------------------------------------------------------------ */

function yamlList(list) {
  return `[${list.map((item) => JSON.stringify(item)).join(', ')}]`;
}

async function buildChapter(chapter, chapterNo) {
  const ordered = orderFromIndex(chapter.dir);
  const files = ordered.length ? ordered : scanChapter(chapter.dir);
  const state = { imageSeq: 0 };

  console.log(`\n第 ${chapterNo} 章：${chapter.title}`);
  console.log(`  合并 ${files.length} 篇：${files.map((f) => path.basename(f).split('_')[0]).join('、')}`);

  const blocks = [];
  for (const rel of files) {
    const lines = await cleanFile(rel, chapterNo, state);
    if (lines.length) blocks.push(lines.join('\n'));
  }

  const body = blocks.join('\n\n');
  const cover = body.match(/!\[\]\((\/images\/[^)]+)\)/)?.[1];

  const front = [
    '---',
    `title: ${JSON.stringify(chapter.title)}`,
    `description: ${JSON.stringify(chapter.description)}`,
    `date: ${TODAY}`,
    ...(cover ? [`image: ${JSON.stringify(cover)}`] : []),
    'categories: ["学习笔记"]',
    `tags: ${yamlList(['STM32', '嵌入式', '学习笔记', ...chapter.tags])}`,
    `series: ${SERIES_SLUG}`,
    `seriesOrder: ${chapterNo}`,
    '---',
    '',
  ].join('\n');

  const target = path.join(OUT_DIR, `${chapter.file}.md`);
  if (!DRY) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(target, `${front}${body}\n`, 'utf8');
  }

  return { files: files.length, images: state.imageSeq, chars: body.length, cover };
}

/* ------------------------------------------------------------------
 * 系列目录页（说明 + 学习路线；章节列表由页面组件自动生成）
 * ------------------------------------------------------------------ */

function buildIndexPage(cover) {
  const body = `这是我学习 STM32F103（Keil MDK + 标准库）的完整笔记，从环境搭建一直记到 ADC。
整份笔记按「章」组织：一篇就是一章，左侧可以切换章节，右边是本章的目录。

## 这份笔记怎么用

- **按顺序读**：从第一章的环境搭建开始，后面的实验都建立在前面的代码之上；
- **当工具书查**：每个外设的章节基本遵循「原理 → 寄存器/结构体 → 初始化 → 读写实验」的节奏，
  忘了哪个外设直接跳进去看对应那章；
- **代码都在正文里**：每处功能都有完整的 \`c\` 代码块，可以直接复制到自己工程里。

## 硬件与软件环境

| 项目 | 说明 |
| --- | --- |
| 开发板 | STM32F103C8T6 最小系统板（核心板） |
| 下载器 | ST-LINK V2 |
| 开发环境 | Keil MDK 5（需装 STM32F1 支持包 + ST-LINK 驱动） |
| 库 | STM32 标准外设库（StdPeriph Library） |

## 章节概览

| 章 | 主题 | 实验 |
| --- | --- | --- |
| 第一章 | 准备 | Keil 环境、芯片与引脚认识 |
| 第二章 | GPIO | LED 闪灯、按钮输入 |
| 第三章 | 串口 USART | 收发数据、格式化打印、printf 封装 |
| 第四章 | I2C | 读写寄存器、软 I2C、OLED 显示 |
| 第五章 | SPI | 数据收发、W25Q64 读写 |
| 第六章 | 中断 | NVIC 优先级、串口中断接收 |
| 第七章 | EXTI | 外部中断按钮实验 |
| 第八章 | 时钟 RCC | 时钟树与 72MHz 配置 |
| 第九章 | 定时器 | 时基、PWM 呼吸灯、输入捕获、超声波测距、PWM 参数测量 |
| 第十章 | ADC | 单通道转换、定时器触发、扫描模式 |
`;

  const front = [
    '---',
    `title: ${JSON.stringify(SERIES_TITLE)}`,
    `description: ${JSON.stringify('Keil STM32 学习笔记：从环境搭建、GPIO、串口、I2C、SPI 到中断、时钟、定时器与 ADC，一章一篇，带完整代码。')}`,
    `date: ${TODAY}`,
    `image: ${JSON.stringify(SERIES_COVER)}`,
    'categories: ["学习笔记"]',
    'tags: ["STM32", "嵌入式", "学习笔记", "单片机"]',
    `series: ${SERIES_SLUG}`,
    `seriesTitle: ${JSON.stringify(SERIES_TITLE)}`,
    'seriesOrder: 0',
    '---',
    '',
  ].join('\n');

  if (!DRY) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'index.md'), `${front}${body}`, 'utf8');
  }
}

/* ------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到源目录：${SRC}`);
    process.exit(1);
  }

  console.log(`源目录：${SRC}`);
  console.log(`输出：${path.relative(ROOT, OUT_DIR)}`);
  if (DRY) console.log('（--dry-run：只统计，不写任何文件）\n');

  // 每次导入先清空上次的产物，避免改名 / 重新编号后留下孤儿文件
  if (!DRY) {
    for (const dir of [OUT_DIR, IMG_DIR]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  let totalFiles = 0;
  let totalChars = 0;
  let totalImages = 0;
  let firstCover = undefined;

  for (let i = 0; i < CHAPTERS.length; i += 1) {
    const chapter = CHAPTERS[i];
    const chapterNo = i + 1;
    const stat = await buildChapter(chapter, chapterNo);
    totalFiles += stat.files;
    totalChars += stat.chars;
    totalImages += stat.images;
    if (!firstCover && stat.cover) firstCover = stat.cover;
  }

  buildIndexPage(firstCover);

  console.log('\n================ 汇总 ================');
  console.log(`合并 ${totalFiles} 篇 → ${CHAPTERS.length} 章 + 1 个目录页`);
  console.log(`正文字符：${totalChars}`);
  console.log(`图片：${imageCount} 张转 WebP（复用 ${imageReused} 张重复图）`);
  if (!DRY) {
    console.log(`图片体积：${(imageBytesIn / 1048576).toFixed(1)} MB → ${(imageBytesOut / 1048576).toFixed(1)} MB`);
  }
  console.log(`输出目录：${path.relative(ROOT, OUT_DIR)}`);
  console.log(`图片目录：${path.relative(ROOT, IMG_DIR)}`);
  console.log('======================================');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
