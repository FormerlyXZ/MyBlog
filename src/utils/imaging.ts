/**
 * 浏览器端图片压缩（上传图床前的第一道工序）
 * ============================================================
 * 为什么在浏览器压，而不是传到服务器再压：
 *   ① 省流量 —— 一张 9.6MB 的 4K 截图，压完只有 100–300KB，
 *      上传体积差 30–90 倍，宿舍网/手机热点下这比任何 CDN 都管用；
 *   ② 省额度 —— R2 免费额度按「存储 + 操作次数」算，不按流量，
 *      但传小文件也意味着列表更快、回源更少；
 *   ③ 服务器端没有依赖 —— Worker 里不能跑 sharp，能跑也不划算。
 *
 * 输出格式固定 WebP（quality 80）：
 *   同画质下比 JPEG 小 25–35%，还支持透明通道（PNG 截图不用铺白底），
 *   现代浏览器全支持解码；万一浏览器编不出 WebP（很老的 Safari），
 *   自动退回 JPEG，并把透明区域铺成白底（否则会变黑）。
 *
 * 尺寸上限默认 2560px（长边）：
 *   博客正文最宽 80rem≈1280px，2 倍屏就是 2560px，再大纯属浪费。
 * ============================================================
 */

/** 一张已经处理好的图片 */
export interface ProcessedImage {
  /** 最终的二进制数据 */
  blob: Blob;
  /** 扩展名，不带点：webp / jpg / png / gif / svg */
  ext: string;
  /** MIME 类型 */
  type: string;
  width: number;
  height: number;
  /** 原始体积（字节） */
  originalSize: number;
  /** 处理后体积（字节） */
  size: number;
  /** 是否真的重新编码过（false = 原样透传） */
  recompressed: boolean;
}

export interface CompressOptions {
  /** 长边上限，默认 2560 */
  maxSide?: number;
  /** WebP 初始质量，默认 0.8 */
  quality?: number;
  /** 目标体积：超过就继续降质量，默认 400KB */
  targetBytes?: number;
  /** 硬上限：降质量后还超就缩尺寸，默认 1.5MB */
  maxBytes?: number;
  /** 已经是 webp 且够小的就不重新编码（避免二次损失），默认 true */
  keepGoodWebp?: boolean;
}

const DEFAULTS = {
  maxSide: 2560,
  quality: 0.8,
  targetBytes: 400 * 1024,
  maxBytes: 1.5 * 1024 * 1024,
  keepGoodWebp: true,
};

/** 质量阶梯：降到 0.5 还不够就缩尺寸 */
const QUALITY_STEPS = [1, 0.86, 0.72, 0.6, 0.5];

/** 原样透传的类型（压了会坏） */
const PASSTHROUGH = new Set([
  'image/gif', // 动图，canvas 只留第一帧
  'image/svg+xml', // 矢量，栅格化反而变大且会糊
  'image/avif', // 已经比 webp 小，重编码是倒退
]);

/* ------------------------------------------------------------------ */
/* 解码                                                                */
/* ------------------------------------------------------------------ */

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // 明确要求按 EXIF 方向摆正：手机竖拍的照片不处理会躺倒
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      /* 有的浏览器不认 imageOrientation，走下面的 <img> 兜底 */
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.decoding = 'async';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('这张图片读不出来，可能是格式不被浏览器支持'));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 编码                                                                */
/* ------------------------------------------------------------------ */

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片压缩失败，换一张试试'))),
      type,
      quality,
    );
  });
}

/**
 * 把画布编成 WebP；浏览器不支持 WebP 编码时退回 JPEG。
 * 判断方式：看返回的 blob.type —— 不支持的话浏览器会悄悄给 PNG/JPEG。
 */
async function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
  quality: number,
): Promise<{ blob: Blob; ext: string; type: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('浏览器不支持图片压缩，换一个浏览器试试');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);

  const webp = await toBlob(canvas, 'image/webp', quality);
  if (webp.type === 'image/webp') {
    return { blob: webp, ext: 'webp', type: 'image/webp' };
  }

  // 编不出 WebP：重画一遍，铺白底再导 JPEG（透明区域直接画 JPEG 会变黑）
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const jpeg = await toBlob(canvas, 'image/jpeg', Math.max(quality, 0.82));
  return { blob: jpeg, ext: 'jpg', type: 'image/jpeg' };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function extFromType(type: string): string {
  const sub = type.split('/')[1] || 'bin';
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  if (sub === 'quicktime') return 'mov';
  return sub.replace(/[^a-z0-9]/gi, '');
}

/**
 * 压缩一张图。任何情况下都会返回可上传的结果：
 * 不该压的（GIF / SVG / 已经很小的 WebP）原样透传，压不动的抛明确错误。
 */
export async function compressImage(
  file: File,
  options: CompressOptions = {},
): Promise<ProcessedImage> {
  const opts = { ...DEFAULTS, ...options };
  const type = (file.type || '').toLowerCase();
  const originalSize = file.size;

  /* ---- ① 不该压的：原样带走，只补一下宽高 ---- */
  if (PASSTHROUGH.has(type)) {
    let width = 0;
    let height = 0;
    try {
      const bitmap = await decode(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      /* SVG 拿不到固有尺寸也无所谓 */
    }
    return {
      blob: file,
      ext: extFromType(type),
      type,
      width,
      height,
      originalSize,
      size: originalSize,
      recompressed: false,
    };
  }

  if (!type.startsWith('image/')) {
    throw new Error('这不是图片文件');
  }

  const bitmap = await decode(file);
  try {
    const { width: rawW, height: rawH } = bitmap;
    if (!rawW || !rawH) throw new Error('这张图片没有有效尺寸，换一张试试');

    /* ---- ② 已经是压好的 WebP：不动它 ---- */
    if (
      opts.keepGoodWebp &&
      type === 'image/webp' &&
      Math.max(rawW, rawH) <= opts.maxSide &&
      originalSize <= opts.targetBytes
    ) {
      return {
        blob: file,
        ext: 'webp',
        type,
        width: rawW,
        height: rawH,
        originalSize,
        size: originalSize,
        recompressed: false,
      };
    }

    /* ---- ③ 逐级降质量；还超标就缩尺寸 ---- */
    let scale = Math.min(1, opts.maxSide / Math.max(rawW, rawH));
    let best: { blob: Blob; ext: string; type: string } | null = null;
    let bestW = Math.round(rawW * scale);
    let bestH = Math.round(rawH * scale);

    for (let round = 0; round < 4; round += 1) {
      const outW = Math.max(1, Math.round(rawW * scale));
      const outH = Math.max(1, Math.round(rawH * scale));

      for (const factor of QUALITY_STEPS) {
        const quality = Math.min(0.95, Math.max(0.4, opts.quality * factor));
        const result = await encode(bitmap.source, outW, outH, quality);
        if (!best || result.blob.size < best.blob.size) {
          best = result;
          bestW = outW;
          bestH = outH;
        }
        if (result.blob.size <= opts.targetBytes) break;
      }

      // 达标了、或者压到目标以内，就别再缩了
      if (best.blob.size <= opts.targetBytes) break;
      // 没达标但已经在硬上限内、且再缩会明显掉画质 → 收手
      if (best.blob.size <= opts.maxBytes && scale < 0.5) break;
      scale *= 0.85;
      if (scale < 0.15) break;
    }

    if (!best) throw new Error('图片压缩失败，换一张试试');

    // 压完反而更大（极少：本来就压榨过的 png）→ 保留原图
    if (best.blob.size >= originalSize && type === 'image/webp') {
      return {
        blob: file,
        ext: 'webp',
        type,
        width: rawW,
        height: rawH,
        originalSize,
        size: originalSize,
        recompressed: false,
      };
    }

    return {
      blob: best.blob,
      ext: best.ext,
      type: best.type,
      width: bestW,
      height: bestH,
      originalSize,
      size: best.blob.size,
      recompressed: true,
    };
  } finally {
    bitmap.close();
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 1536 → "1.5 KB" */
export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 压缩率描述：「9.6 MB → 142 KB（省 98.5%）」 */
export function describeCompression(image: ProcessedImage): string {
  if (!image.recompressed) return formatBytes(image.size);
  const saved = image.originalSize > 0 ? 1 - image.size / image.originalSize : 0;
  return `${formatBytes(image.originalSize)} → ${formatBytes(image.size)}（省 ${(saved * 100).toFixed(0)}%）`;
}
