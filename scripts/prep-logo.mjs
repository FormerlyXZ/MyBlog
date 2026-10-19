/**
 * 生成导航栏品牌图（透明背景 logo）
 * ============================================================
 * 输入：uploads/MelodyZzX高木同学.png（白底像素画：MelodyZzX 字 + 高木同学）
 * 输出：public/brand-logo.png（透明底、已裁掉四周留白）
 *       .playwright-mcp/brand-preview.png（白/灰/深三块底色的预览，检查白边有没有抠干净）
 *
 * 用法：node scripts/prep-logo.mjs
 *
 * 思路：
 *   ① 从四边向内「洪水填充」接近纯白的像素 —— 只抠掉和画面边缘连通的白色。
 *      这样字母镂空（o/e/d 的内孔，和外面是连通的）会一起被抠掉，
 *      而人物身上被描边/头发围住的白色（水手服、袜子、爱心气泡）会原样保留。
 *      注意：不能用「全图白 → 透明」，那样衬衫袜子会被打出一堆洞。
 *   ② 透明像素的 RGB 统一刷成描边色（深酒红），缩放时边缘不会渗出白边。
 *   ③ 按不透明像素的包围盒裁掉留白，宽度降到 1000px 左右（够 Retina，文件也小）。
 * ============================================================
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';

const SRC = 'uploads/MelodyZzX高木同学.png';
const OUT = 'public/brand-logo.png';
const PREVIEW = '.playwright-mcp/brand-preview.png';

/** 抠白底：min(r,g,b) 够亮且三通道差得不多 → 透明 */
const WHITE_MIN = 236;
const WHITE_SPREAD = 14;
/** 透明像素刷成的颜色（就是文字的描边色，渗出来也像描边） */
const EDGE_RGB = [0x53, 0x1a, 0x2c];

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

const isWhite = (x, y) => {
  const i = (y * width + x) * channels;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  return Math.min(r, g, b) >= WHITE_MIN && Math.max(r, g, b) - Math.min(r, g, b) <= WHITE_SPREAD;
};

/* ---- ① 从四边洪水填充：只抠「和画布边缘连通」的白 ---- */
const bg = new Uint8Array(width * height);
const queue = new Int32Array(width * height);
let tail = 0;

const push = (x, y) => {
  const p = y * width + x;
  if (bg[p] || !isWhite(x, y)) return;
  bg[p] = 1;
  queue[tail++] = p;
};

for (let x = 0; x < width; x++) {
  push(x, 0);
  push(x, height - 1);
}
for (let y = 0; y < height; y++) {
  push(0, y);
  push(width - 1, y);
}

for (let head = 0; head < tail; head++) {
  const p = queue[head];
  const x = p % width;
  const y = (p - x) / width;
  if (x > 0) push(x - 1, y);
  if (x < width - 1) push(x + 1, y);
  if (y > 0) push(x, y - 1);
  if (y < height - 1) push(x, y + 1);
}

/* ---- ② 抠掉 + 统计包围盒 ---- */
let removed = 0;
let minX = width;
let minY = height;
let maxX = -1;
let maxY = -1;

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const p = y * width + x;
    const i = p * channels;

    if (bg[p]) {
      data[i] = EDGE_RGB[0];
      data[i + 1] = EDGE_RGB[1];
      data[i + 2] = EDGE_RGB[2];
      data[i + 3] = 0;
      removed++;
      continue;
    }

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
}

const pad = 4;
const left = Math.max(0, minX - pad);
const top = Math.max(0, minY - pad);
const w = Math.min(width - left, maxX - minX + 1 + pad * 2);
const h = Math.min(height - top, maxY - minY + 1 + pad * 2);

const OUT_WIDTH = 1000;
const outHeight = Math.round((h / w) * OUT_WIDTH);

await sharp(data, { raw: { width, height, channels } })
  .extract({ left, top, width: w, height: h })
  .resize({ width: OUT_WIDTH, kernel: 'lanczos3' })
  .png({ palette: true, colors: 220, effort: 10, compressionLevel: 9 })
  .toFile(OUT);

const size = statSync(OUT).size;
console.log(`source   ${width}x${height}  抠掉 ${((removed / (width * height)) * 100).toFixed(1)}% 像素`);
console.log(`crop     ${w}x${h} @ (${left},${top})  → 比例 ${(w / h).toFixed(3)}`);
console.log(`output   ${OUT_WIDTH}x${outHeight}  ${(size / 1024).toFixed(0)} KB  → ${OUT}`);

/** 三种底色下的预览，检查有没有白边 / 镂空是否干净 */
const logo = sharp(OUT);
const meta = await logo.metadata();
const bgColors = [
  { name: 'light', color: '#f4f1ff' },
  { name: 'mid', color: '#8a8a99' },
  { name: 'dark', color: '#21222c' },
];
const tileW = meta.width;
const tileH = meta.height;
const gap = 24;
const canvas = sharp({
  create: {
    width: tileW * bgColors.length + gap * (bgColors.length + 1),
    height: tileH + gap * 2,
    channels: 4,
    background: '#ffffff',
  },
});
const composites = [];
const buf = await sharp(OUT).png().toBuffer();
for (let i = 0; i < bgColors.length; i++) {
  const x = gap + i * (tileW + gap);
  composites.push({
    input: {
      create: { width: tileW, height: tileH, channels: 4, background: bgColors[i].color },
    },
    left: x,
    top: gap,
  });
  composites.push({ input: buf, left: x, top: gap });
}
await canvas.composite(composites).png().toFile(PREVIEW);
console.log('preview  ' + PREVIEW);
