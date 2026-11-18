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

/* ---------------------------------------------------------------- */
/* 目录索引补丁：给每个页面目录加一个伴生文件                          */
/* ---------------------------------------------------------------- */

/**
 * EdgeOne Pages 实测规则（2026-11 验证）：
 *
 *   /目录/  →  目录/index.html      只有「目录里除了 index.html 还有别的文件」时才成立
 *
 * 实测：
 *   p-small/  只放 index.html                     → 404
 *   q-two/    index.html + 一个 txt                → 200
 *   q-sub/    index.html + 一个子目录              → 404（子目录不算）
 *
 * 也就是说只含单个 index.html 的目录，干净 URL 一律 404。
 * Astro 的每个页面恰好就是一个目录 + 一个 index.html，于是全站只有首页能打开。
 * 这里给每个页面目录写一个 page.txt 当伴生文件，把这条规则喂饱。
 */
const SIBLING = 'page.txt';
const SIBLING_TEXT = '这张文件是给静态托管平台看的占位伴生文件：\n它让「目录里有除 index.html 之外的文件」，边缘才会把 /目录/ 映射到 index.html。\n没有它，EdgeOne Pages 会对 /目录/ 返回 404。可以忽略、不要删。\n';

const dirs = new Set();
for (const file of files) {
  // 只处理 <目录>/index.html 这种页面；dist/index.html（首页）本来就正常
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel === 'index.html') continue;
  if (!rel.endsWith('/index.html')) continue;
  dirs.add(rel.slice(0, -'/index.html'.length));
}

let patched = 0;
for (const dir of dirs) {
  await writeFile(join(ROOT, dir, SIBLING), SIBLING_TEXT, 'utf8');
  patched += 1;
}

console.log(`[sibling] ${patched} 个页面目录已补上 ${SIBLING}`);
