/**
 * 占位素材生成脚本
 * ============================================================
 * 生成纯 SVG 的占位图（Banner / 头像 / 文章封面 / 照片墙占位）。
 * 好处：几 KB 一个、任意分辨率不糊、离线可用、随时可换。
 *
 * 用法：npm run gen:assets
 *
 * 换成自己的图：直接把同名文件覆盖掉即可，
 *   例如把自己的横幅存成 public/banner/1.jpg，
 *   再把 config/site.json 里 banner.images 改成 "/banner/1.jpg"。
 * ============================================================
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_NAME = "MelodyZzX's Blog";

const write = async (relPath, content) => {
  const full = resolve(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  console.log(`✓ ${relPath}`);
};

/* ---------------- Banner：4 套配色 ---------------- */

const bannerPalettes = [
  { from: '#7ed6c1', to: '#4f8ef7', accent: '#ffffff', name: '薄荷蓝' },
  { from: '#fbc2eb', to: '#a6c1ee', accent: '#ffffff', name: '樱花紫' },
  { from: '#ffd89b', to: '#f7797d', accent: '#ffffff', name: '晚霞橙' },
  { from: '#d4fc79', to: '#1fa2a6', accent: '#ffffff', name: '青草绿' },
];

const bannerSvg = ({ from, to, accent }, index) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" fill="none" role="img" aria-label="${SITE_NAME} 横幅占位图 ${index}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="675" gradientUnits="userSpaceOnUse">
      <stop stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(920 150) rotate(125) scale(420 420)" gradientUnits="userSpaceOnUse">
      <stop stop-color="${accent}" stop-opacity=".55"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <rect width="1200" height="675" fill="url(#glow)"/>
  <g opacity=".18" fill="none" stroke="${accent}" stroke-width="1.5">
    <circle cx="180" cy="560" r="120"/>
    <circle cx="180" cy="560" r="180"/>
    <circle cx="1050" cy="120" r="90"/>
    <circle cx="1050" cy="120" r="150"/>
  </g>
  <g opacity=".22" stroke="${accent}" stroke-width="1">
    ${Array.from({ length: 11 }, (_, i) => `<path d="M${i * 120} 0V675"/>`).join('')}
    ${Array.from({ length: 6 }, (_, i) => `<path d="M0 ${i * 120}H1200"/>`).join('')}
  </g>
  <text x="600" y="330" text-anchor="middle" font-family="'M PLUS Rounded 1c', 'PingFang SC', system-ui, sans-serif" font-size="64" font-weight="700" fill="${accent}" opacity=".96">${SITE_NAME.replace(/'/g, '&apos;')}</text>
  <text x="600" y="382" text-anchor="middle" font-family="'M PLUS Rounded 1c', 'PingFang SC', system-ui, sans-serif" font-size="20" fill="${accent}" opacity=".7">banner placeholder ${index} · 用你自己的图覆盖 public/banner/${index}.svg</text>
</svg>
`;

/* ---------------- 头像 ---------------- */

const profileSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400" fill="none" role="img" aria-label="头像占位图">
  <defs>
    <linearGradient id="p" x1="40" y1="20" x2="380" y2="390" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8ec5ff"/>
      <stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
  </defs>
  <rect width="400" height="400" rx="96" fill="url(#p)"/>
  <circle cx="300" cy="90" r="70" fill="#ffffff" opacity=".16"/>
  <text x="200" y="248" text-anchor="middle" font-family="'M PLUS Rounded 1c', system-ui, sans-serif" font-size="150" font-weight="700" fill="#ffffff" opacity=".92">MZ</text>
</svg>
`;

/* ---------------- 文章封面：3 套 ---------------- */

const coverPalettes = [
  ['#a8edea', '#5f72bd'],
  ['#f6d365', '#fda085'],
  ['#c2e9fb', '#a1c4fd'],
];

const coverSvg = ([from, to], index) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450" fill="none" role="img" aria-label="文章封面占位图 ${index}">
  <defs>
    <linearGradient id="c" x1="0" y1="0" x2="800" y2="450" gradientUnits="userSpaceOnUse">
      <stop stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="800" height="450" fill="url(#c)"/>
  <g opacity=".2" fill="#fff">
    <circle cx="120" cy="360" r="140"/>
    <circle cx="700" cy="80" r="100"/>
  </g>
  <g opacity=".14" stroke="#fff" stroke-width="2" fill="none">
    <path d="M400 60 700 380H100Z"/>
  </g>
</svg>
`;

/* ---------------- 照片墙占位：160 张、七种比例 ----------------
   数量够多、比例够杂，才好检验瀑布墙的列对齐效果、二维平移和「点击推挤」；
   换成自己的照片后，在 /config → 照片墙 里批量删掉这些示例即可。 */

const galleryRatios = [
  [1200, 900],
  [900, 1200],
  [1000, 1000],
  [1200, 800],
  [800, 1200],
  [1280, 720],
  [720, 1280],
];

const galleryPalettes = [
  ['#fccb90', '#d57eeb'],
  ['#e0c3fc', '#8ec5fc'],
  ['#f093fb', '#f5576c'],
  ['#84fab0', '#8fd3f4'],
  ['#a1c4fd', '#c2e9fb'],
  ['#ffecd2', '#fcb69f'],
  ['#c1dfc4', '#deecdd'],
  ['#f6d365', '#fda085'],
];

const gallerySvg = ({ w, h, index, from, to }) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" role="img" aria-label="照片墙占位图 ${index}">
  <defs>
    <linearGradient id="a${index}" x1="0" y1="0" x2="${w}" y2="${h}" gradientUnits="userSpaceOnUse">
      <stop stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#a${index})"/>
  <circle cx="${w * 0.76}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.2}" fill="#fff" opacity=".16"/>
  <circle cx="${w * 0.2}" cy="${h * 0.82}" r="${Math.min(w, h) * 0.12}" fill="#fff" opacity=".1"/>
  <text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.12)}" font-weight="700" fill="#ffffff" opacity=".8">${index}</text>
</svg>
`;

/* ---------------- 执行 ---------------- */

for (const [i, palette] of bannerPalettes.entries()) {
  await write(`public/banner/${i + 1}.svg`, bannerSvg(palette, i + 1));
}

await write('public/profile.svg', profileSvg());

for (const [i, palette] of coverPalettes.entries()) {
  await write(`public/images/cover-${i + 1}.svg`, coverSvg(palette, i + 1));
}

for (let i = 0; i < 160; i += 1) {
  const [w, h] = galleryRatios[i % galleryRatios.length];
  const [from, to] = galleryPalettes[i % galleryPalettes.length];
  const index = i + 1;
  await write(
    `public/image/gallery/g-${String(index).padStart(2, '0')}.svg`,
    gallerySvg({ w, h, index, from, to }),
  );
}

console.log('\n占位素材已生成完毕。换成自己的图：直接覆盖同名文件即可。');
