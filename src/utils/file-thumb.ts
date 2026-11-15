/**
 * 非图片文件的缩略图（PDF / 音频 / 视频 / 压缩包…）
 * ============================================================
 * 图床里除了图片还有一堆别的东西：PDF、mp3、mp4、zip、源码。
 * 这些没有能直接显示的像素，原来只有一个灰灰的扩展名文字，很难认。
 *
 * 这里用纯 SVG 现场画一张「文件卡片」：
 *   浅色底 + 白纸 + 折角 + 类型图形 + 底部色块标签。
 * 全部是矢量，161px 的格子和大图预览用的是同一张图，
 * 不额外请求任何图标资源，也不用联外网。
 *
 * 同一类型缓存一份，几百个文件也只会生成十来张图。
 * ============================================================
 */

/** 图形类型：决定画什么 */
type GlyphKind = 'text' | 'grid' | 'slide' | 'audio' | 'video' | 'archive' | 'code' | 'fallback';

interface Kind {
  /** 主色：折角、图形、标签块都用它 */
  color: string;
  glyph: GlyphKind;
}

/** 常见扩展名 → 类型。没列到的落到 fallback（灰色纸）。 */
const EXT_KINDS: Record<string, Kind> = {
  pdf: { color: '#e5484d', glyph: 'text' },

  doc: { color: '#3b82f6', glyph: 'text' },
  docx: { color: '#3b82f6', glyph: 'text' },
  odt: { color: '#3b82f6', glyph: 'text' },
  rtf: { color: '#3b82f6', glyph: 'text' },
  txt: { color: '#3b82f6', glyph: 'text' },
  md: { color: '#3b82f6', glyph: 'text' },
  markdown: { color: '#3b82f6', glyph: 'text' },

  xls: { color: '#12a150', glyph: 'grid' },
  xlsx: { color: '#12a150', glyph: 'grid' },
  csv: { color: '#12a150', glyph: 'grid' },
  tsv: { color: '#12a150', glyph: 'grid' },
  numbers: { color: '#12a150', glyph: 'grid' },

  ppt: { color: '#f76b15', glyph: 'slide' },
  pptx: { color: '#f76b15', glyph: 'slide' },
  key: { color: '#f76b15', glyph: 'slide' },

  mp3: { color: '#8b5cf6', glyph: 'audio' },
  m4a: { color: '#8b5cf6', glyph: 'audio' },
  wav: { color: '#8b5cf6', glyph: 'audio' },
  flac: { color: '#8b5cf6', glyph: 'audio' },
  aac: { color: '#8b5cf6', glyph: 'audio' },
  ogg: { color: '#8b5cf6', glyph: 'audio' },
  opus: { color: '#8b5cf6', glyph: 'audio' },
  lrc: { color: '#8b5cf6', glyph: 'audio' },

  mp4: { color: '#e93d82', glyph: 'video' },
  webm: { color: '#e93d82', glyph: 'video' },
  mov: { color: '#e93d82', glyph: 'video' },
  mkv: { color: '#e93d82', glyph: 'video' },
  avi: { color: '#e93d82', glyph: 'video' },
  m4v: { color: '#e93d82', glyph: 'video' },

  zip: { color: '#f59e0b', glyph: 'archive' },
  rar: { color: '#f59e0b', glyph: 'archive' },
  '7z': { color: '#f59e0b', glyph: 'archive' },
  gz: { color: '#f59e0b', glyph: 'archive' },
  tar: { color: '#f59e0b', glyph: 'archive' },
  bz2: { color: '#f59e0b', glyph: 'archive' },
  xz: { color: '#f59e0b', glyph: 'archive' },

  js: { color: '#0ea5e9', glyph: 'code' },
  mjs: { color: '#0ea5e9', glyph: 'code' },
  ts: { color: '#0ea5e9', glyph: 'code' },
  jsx: { color: '#0ea5e9', glyph: 'code' },
  tsx: { color: '#0ea5e9', glyph: 'code' },
  json: { color: '#0ea5e9', glyph: 'code' },
  html: { color: '#0ea5e9', glyph: 'code' },
  css: { color: '#0ea5e9', glyph: 'code' },
  astro: { color: '#0ea5e9', glyph: 'code' },
  py: { color: '#0ea5e9', glyph: 'code' },
  go: { color: '#0ea5e9', glyph: 'code' },
  rs: { color: '#0ea5e9', glyph: 'code' },
  sh: { color: '#0ea5e9', glyph: 'code' },
  yml: { color: '#0ea5e9', glyph: 'code' },
  yaml: { color: '#0ea5e9', glyph: 'code' },
  toml: { color: '#0ea5e9', glyph: 'code' },
  lock: { color: '#0ea5e9', glyph: 'code' },
};

/** MIME 兜底：扩展名不认识时看 type */
const TYPE_KINDS: { prefix: string; kind: Kind }[] = [
  { prefix: 'application/pdf', kind: { color: '#e5484d', glyph: 'text' } },
  { prefix: 'audio/', kind: { color: '#8b5cf6', glyph: 'audio' } },
  { prefix: 'video/', kind: { color: '#e93d82', glyph: 'video' } },
  { prefix: 'text/', kind: { color: '#3b82f6', glyph: 'text' } },
  { prefix: 'application/zip', kind: { color: '#f59e0b', glyph: 'archive' } },
  { prefix: 'application/x-tar', kind: { color: '#f59e0b', glyph: 'archive' } },
];

const FALLBACK: Kind = { color: '#6b7a90', glyph: 'fallback' };

const FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/* ============================================================
   图形（都在 40×40 的框里画，框心在 80,66）
   ============================================================ */

function glyphOf(kind: GlyphKind, color: string): string {
  switch (kind) {
    // 文本 / 文档：三行字，最后一行短一截
    case 'text':
    case 'fallback':
      return `
        <rect x="60" y="52" width="40" height="4.6" rx="2.3" fill="${color}"/>
        <rect x="60" y="62" width="40" height="4.6" rx="2.3" fill="${color}"/>
        <rect x="60" y="72" width="25" height="4.6" rx="2.3" fill="${color}"/>`;

    // 表格：外框 + 两横一竖
    case 'grid':
      return `
        <g fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round">
          <rect x="60" y="48" width="40" height="34" rx="4"/>
          <path d="M60 59h40M60 70h40M74 48v34"/>
        </g>`;

    // 演示文稿：屏幕 + 支架线
    case 'slide':
      return `
        <g fill="none" stroke="${color}" stroke-width="3.6" stroke-linecap="round">
          <rect x="60" y="48" width="40" height="28" rx="4"/>
          <path d="M72 84h16"/>
        </g>`;

    // 音频：一段音波
    case 'audio':
      return `
        <g fill="${color}">
          <rect x="62" y="60" width="4.6" height="12" rx="2.3"/>
          <rect x="70" y="52" width="4.6" height="28" rx="2.3"/>
          <rect x="78" y="46" width="4.6" height="40" rx="2.3"/>
          <rect x="86" y="54" width="4.6" height="24" rx="2.3"/>
          <rect x="94" y="62" width="4.6" height="8" rx="2.3"/>
        </g>`;

    // 视频：框里一个播放三角
    case 'video':
      return `
        <g fill="none" stroke="${color}" stroke-width="3.6" stroke-linejoin="round">
          <rect x="60" y="48" width="40" height="36" rx="6"/>
        </g>
        <path d="M72 57l16 9-16 9z" fill="${color}"/>`;

    // 压缩包：拉链
    case 'archive':
      return `
        <g fill="none" stroke="${color}" stroke-width="3.4">
          <rect x="60" y="48" width="40" height="36" rx="5"/>
        </g>
        <g fill="${color}">
          <rect x="73.6" y="51" width="6.8" height="8" rx="1.6"/>
          <rect x="73.6" y="62" width="6.8" height="8" rx="1.6" fill-opacity=".55"/>
          <rect x="73.6" y="73" width="6.8" height="8" rx="1.6" fill-opacity=".35"/>
        </g>`;

    // 源码：</>
    case 'code':
      return `
        <g fill="none" stroke="${color}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M70 55l-10 11 10 11"/>
          <path d="M90 55l10 11-10 11"/>
          <path d="M84 52l-8 28"/>
        </g>`;
  }
}

/* ============================================================
   组装
   ============================================================ */

function pickKind(ext: string, mime: string): Kind {
  const byExt = EXT_KINDS[ext];
  if (byExt) return byExt;
  const hit = TYPE_KINDS.find((rule) => mime.startsWith(rule.prefix));
  return hit ? hit.kind : FALLBACK;
}

/** 标签块：上限四个字母，够认了 */
function labelOf(ext: string): string {
  if (!ext) return 'FILE';
  return ext.slice(0, 4).toUpperCase();
}

function buildSvg(kind: Kind, label: string): string {
  const { color } = kind;
  const fontSize = label.length >= 4 ? 10 : 11.5;
  const plateWidth = Math.max(30, Math.round(label.length * fontSize * 0.68 + 16));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160">
  <rect width="160" height="160" fill="#ffffff"/>
  <rect width="160" height="160" fill="${color}" fill-opacity=".09"/>
  <rect x="36" y="30" width="88" height="100" rx="9" fill="#ffffff"/>
  <rect x="36.75" y="30.75" width="86.5" height="98.5" rx="8.25" fill="none" stroke="${color}" stroke-opacity=".26" stroke-width="1.5"/>
  <path d="M124 51h-21V30z" fill="${color}" fill-opacity=".16"/>
  <path d="M103 30v21h21" fill="none" stroke="${color}" stroke-opacity=".26" stroke-width="1.5"/>
  ${glyphOf(kind.glyph, color)}
  <rect x="${80 - plateWidth / 2}" y="96" width="${plateWidth}" height="21" rx="7" fill="${color}"/>
  <text x="80" y="110.5" text-anchor="middle" font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="700" letter-spacing="0.7" fill="#ffffff">${label}</text>
</svg>`;
}

/** 类型缓存：同一类文件只画一次 */
const cache = new Map<string, string>();

/**
 * 给一个文件名 / MIME 返回可直接塞进 <img src> 的 data URI。
 * SVG 是矢量的，格子里和大图预览里共用同一份，不糊。
 */
export function fileThumbnail(name: string, mime = ''): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // 没有扩展名时 ext 会等于整个文件名，别让它跑进标签里
  const safeExt = name.includes('.') ? ext : '';
  const cacheKey = `${safeExt}|${mime.split('/')[0]}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const svg = buildSvg(pickKind(safeExt, mime), labelOf(safeExt));
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(cacheKey, url);
  return url;
}
