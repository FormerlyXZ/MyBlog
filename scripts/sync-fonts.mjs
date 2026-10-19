/**
 * 字体同步脚本
 * ============================================================
 * 把 @fontsource 包里的 woff2 子集复制到 public/fonts/，
 * 网站运行时只加载本地文件，不请求任何外部 CDN。
 *
 * 用法：npm run sync:fonts
 *
 * 为什么不用 fontsource 自带的 CSS？
 *   自带 CSS 会把 100+ 个 CJK 分片全写进样式表，我们只需要拉丁子集
 *   （中文字符回落到系统字体，观感几乎无差，但能省下几百 KB）。
 *
 * 想补中文字体（如 ZCOOL KuaiLe 给 Banner 用）：
 *   把 woff2 丢进 public/fonts/，再到 src/styles/fonts.css 里取消对应注释。
 * ============================================================
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** [来源包内路径, 输出文件名] */
const FILES = [
  [
    'node_modules/@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-400-normal.woff2',
    'm-plus-rounded-1c-400.woff2',
  ],
  [
    'node_modules/@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-700-normal.woff2',
    'm-plus-rounded-1c-700.woff2',
  ],
  [
    'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
    'jetbrains-mono-400.woff2',
  ],
];

const outDir = resolve(root, 'public/fonts');
await mkdir(outDir, { recursive: true });

for (const [from, to] of FILES) {
  await copyFile(resolve(root, from), resolve(outDir, to));
  console.log(`✓ ${to}`);
}

console.log(`\n字体已同步到 public/fonts/（${FILES.length} 个文件）`);
