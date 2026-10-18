/**
 * 把 Sveltia CMS 的前端文件从 node_modules 复制到 public/admin/，并打一个本地化补丁。
 *
 * 为什么要自托管，不直接用 CDN？
 *   国内访问 unpkg / jsdelivr 经常抽风；编辑器的 JS 直接放进仓库最稳，版本也锁死。
 *
 * 打的是什么补丁？
 *   Sveltia 默认从 unpkg 下载界面语言包（中文界面靠它）。补丁把它改成读本站
 *   /admin/locales/xxx.json，于是后台界面完全不依赖外网 CDN。
 *
 * 用法：npm run vendor:cms
 * 升级 Sveltia 后重跑一次即可；如果补丁锚点匹配不到，脚本会报错并提醒你检查。
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, 'node_modules', '@sveltia', 'cms');
const OUT_DIR = join(ROOT, 'public', 'admin');

/** 需要一起带走的语言包（默认英文内置，中文要单独放） */
const LOCALES = ['zh-CN.json', 'zh-TW.json', 'en-US.json'];

const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'));
console.log(`Sveltia CMS 版本：${pkg.version}`);

await mkdir(OUT_DIR, { recursive: true });

// 1) 主程序
let code = await readFile(join(PKG_DIR, 'dist', 'sveltia-cms.js'), 'utf8');

// 2) 懒加载的分块（Git 接口、二维码、React），保留目录结构，去掉 .map 体积
const chunksSrc = join(PKG_DIR, 'dist', 'chunks');
const chunksOut = join(OUT_DIR, 'chunks');
await rm(chunksOut, { recursive: true, force: true });
await copyDir(chunksSrc, chunksOut);

// 3) 语言包
const localesOut = join(OUT_DIR, 'locales');
await rm(localesOut, { recursive: true, force: true });
await mkdir(localesOut, { recursive: true });
for (const name of LOCALES) {
  try {
    await copyFile(join(PKG_DIR, 'locales', name), join(localesOut, name));
  } catch {
    console.warn(`  跳过缺失的语言包：${name}`);
  }
}

// 4) 补丁：把 unpkg 语言包地址换成本站相对地址
//    原始：   a1e=`https://unpkg.com/@sveltia/cms@${QO}/locales`
//    打补丁： a1e=__SVELTIA_LOCALES_BASE__
const anchor = /https:\/\/unpkg\.com\/@sveltia\/cms@\$\{[A-Za-z0-9_$]+\}\/locales/g;
const hits = code.match(anchor) ?? [];
if (hits.length !== 1) {
  throw new Error(
    `语言包地址锚点匹配到 ${hits.length} 处（期望 1 处）。\n` +
      `Sveltia 可能改了打包方式，请打开 scripts/vendor-cms.mjs 调整 anchor 正则后再试。`,
  );
}

const preamble = [
  '/* 本地化补丁：语言包改为读取本站 /admin/locales/，不再依赖 unpkg CDN（由 scripts/vendor-cms.mjs 生成） */',
  'var __SVELTIA_LOCALES_BASE__ = new URL(',
  "  'locales',",
  '  (document.currentScript && document.currentScript.src) || document.baseURI,',
  ').href;',
  '',
].join('\n');

code = preamble + code.replace(anchor, '__SVELTIA_LOCALES_BASE__');
await writeFile(join(OUT_DIR, 'sveltia-cms.js'), code, 'utf8');

// 5) 记一笔来源，方便以后核对
await writeFile(
  join(OUT_DIR, 'VERSION.txt'),
  `@sveltia/cms ${pkg.version}\n` +
    `由 scripts/vendor-cms.mjs 生成，请勿手工编辑 sveltia-cms.js / chunks / locales。\n` +
    `升级方式：npm i -D @sveltia/cms@latest 然后 npm run vendor:cms\n`,
  'utf8',
);

console.log('已写入 public/admin/：');
for (const f of await walk(OUT_DIR)) console.log('  ' + f);

/** 递归复制目录，跳过 sourcemap */
async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.name.endsWith('.map')) continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(p.slice(base.length + 1));
  }
  return out;
}
