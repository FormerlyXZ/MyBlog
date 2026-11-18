/**
 * 给 dist 里每个 HTML 盖上本次构建戳
 * ============================================================
 * 为什么需要：EdgeOne Pages 的边缘索引似乎只登记「本次部署上传过」的文件，
 * 没变过的老文件虽然按完整路径（/about/index.html）能取到，
 * 但「/目录/ → 目录/index.html」这层映射会丢，于是全站 404。
 *
 * 每篇 HTML 末尾追加一行注释，构建产物就每次都不同，
 * 于是每次部署都会把它们全部重新上传、重新登记。
 *
 * 只在 npm run build 里跑（astro build 之后、pagefind 之前）。
 * 注释写在 </html> 之后，不影响渲染、不影响 pagefind 抓正文。
 * ============================================================
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = 'dist';
const STAMP = new Date().toISOString();

/** 递归收集所有 .html */
async function collect(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const files = await collect(ROOT);
let stamped = 0;

for (const file of files) {
  const text = await readFile(file, 'utf8');
  // 已经盖过就替换，避免连续本地构建把注释堆起来
  const cleaned = text.replace(/\n<!-- build:[\s\S]*?-->\s*$/, '');
  await writeFile(file, `${cleaned}\n<!-- build:${STAMP} -->\n`, 'utf8');
  stamped += 1;
}

console.log(`[stamp] ${stamped} 个 HTML 已盖上构建戳 ${STAMP}`);
console.log(`[stamp] 例：${relative(ROOT, files[0] ?? ROOT)}`);
