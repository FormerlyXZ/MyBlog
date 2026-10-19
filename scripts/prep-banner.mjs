/**
 * Banner 图片流水线（可重复跑，全程自动，不需要手填裁切坐标）
 * ============================================================
 * 输入：uploads/banner-src/ 里丢进来的原始图（后缀不可靠，一律按内容解码）
 * 输出：public/banner/banner-*.jpg —— 1920×1080 渐进式 JPEG / 每张 ≤400KB
 *
 * 三步都是「不处理就会难看」的，且全部自动化：
 *   ① trim()：裁掉动画截图自带的 1–3px 黑边（只吃掉纯色边缘，不动画面）
 *   ② fit:'cover' + position:'attention'：自动找画面「有内容」的区域当中心，
 *      竖图裁成 16:9 也不会把人脸切掉（不需要手工量坐标）
 *   ③ 统一补/降到 1920×1080；放大的补一刀轻锐化，避免 CSS 再放大时的糊感
 *
 * 这样所有横幅都是同一个 16:9 —— 横幅框再用 --banner-ratio 按比例定高，
 * 于是「宽多少、高多少」，不裁不变形（见 docs/redesign-plan.md §10.13）。
 *
 * 用法：node scripts/prep-banner.mjs
 * 预览：.playwright-mcp/banner-preview.jpg（左列桌面 2.28:1 / 右列手机 1.16:1 的实际构图）
 * ============================================================
 */
import sharp from 'sharp';
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';

const SRC_DIR = 'uploads/banner-src';
const OUT_DIR = 'public/banner';
const W = 1920;
const H = 1080;

/** 原始文件名 → 输出名（统一 banner- 开头） */
const NAMES = {
  '1780214324208.png': 'banner-rod.jpg',
  '1780471016262.png': 'banner-snow.jpg',
  '1780493805670.png': 'banner-crossing.jpg',
  'Image_1778927682326_407.png': 'banner-cap.jpg',
};

if (!existsSync(SRC_DIR)) {
  console.error(`找不到 ${SRC_DIR}/，请把原始图片放进去再跑。`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

/** 没登记过的文件 → banner-<文件名>.jpg（去掉不安全字符，避免中文/空格进 URL） */
function outNameOf(file) {
  if (NAMES[file]) return NAMES[file];
  const base = file
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `banner-${base || 'image'}.jpg`;
}

const files = readdirSync(SRC_DIR).filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f));
if (!files.length) {
  console.error(`${SRC_DIR}/ 里没有图片。`);
  process.exit(1);
}

const results = [];

for (const file of files) {
  const srcPath = `${SRC_DIR}/${file}`;
  const outPath = `${OUT_DIR}/${outNameOf(file)}`;

  const input = sharp(srcPath, { failOn: 'none' });
  const meta = await input.metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;

  // ① 自动裁掉纯色边缘（截图黑边）；裁完的尺寸拿来做缩放系数
  const trimmed = await sharp(srcPath, { failOn: 'none' }).trim({ threshold: 12 }).toBuffer({
    resolveWithObject: true,
  });
  const trimW = trimmed.info.width;
  const trimH = trimmed.info.height;

  // ② 自动取景：attention 会挑「细节/对比最强」的窗口当中心
  let pipeline = sharp(trimmed.data).resize({
    width: W,
    height: H,
    fit: 'cover',
    position: 'attention',
    kernel: 'lanczos3',
  });

  // ③ 只有放大时才锐化（缩小的图本身就够锐，再锐会出白边）
  const upscale = W / trimW;
  if (upscale > 1.15) pipeline = pipeline.sharpen({ sigma: 0.7, m1: 0.4, m2: 0.5 });

  await pipeline
    .jpeg({ quality: 82, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' })
    .toFile(outPath);

  results.push({
    out: `${outNameOf(file)}`,
    from: `${srcW}x${srcH}`,
    trimmed: `${trimW}x${trimH}`,
    upscale: upscale.toFixed(2),
    size: `${(statSync(outPath).size / 1024).toFixed(0)}KB`,
  });
}

console.table(results);

/* ---------------- 预览 ----------------
   左列按桌面横幅比例（2.28:1）裁，右列按手机（1.16:1）裁，
   模拟 background-size: cover 在两种屏幕上的真实取景。 */
const PRE_W = 560;
const VIEWS = [
  { label: 'desktop', ratio: 2.28 },
  { label: 'mobile', ratio: 1.16 },
];
const outs = results.map((r) => r.out);
const tiles = [];
let y = 8;
const colW = PRE_W;

for (const [row, out] of outs.entries()) {
  const file = `${OUT_DIR}/${out}`;
  if (!existsSync(file)) continue;
  let h = 0;
  for (const [col, view] of VIEWS.entries()) {
    const th = Math.round(PRE_W / view.ratio);
    h = Math.max(h, th);
    tiles.push({
      input: await sharp(file)
        .resize({ width: PRE_W, height: th, fit: 'cover', position: 'center' })
        .toBuffer(),
      left: 8 + col * (colW + 8),
      top: y,
    });
  }
  y += h + 8;
}

await sharp({
  create: {
    width: 8 + VIEWS.length * (colW + 8),
    height: y,
    channels: 4,
    background: '#1b1b1b',
  },
})
  .composite(tiles)
  .jpeg({ quality: 82 })
  .toFile('.playwright-mcp/banner-preview.jpg');

console.log('预览：.playwright-mcp/banner-preview.jpg（左＝桌面 2.28:1，右＝手机 1.16:1）');
