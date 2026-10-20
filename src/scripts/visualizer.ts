/**
 * 音乐律动
 * ============================================================
 * 用 Web Audio 的 AnalyserNode 拿真实频谱，插值成一条**连续曲线**
 * （Catmull-Rom → 三次贝塞尔），上下镜像后填色，看起来像一层会呼吸的山脊。
 *
 * 几个刻意的设计：
 *   ① 低频在左边、高频在右边，用 pow(ratio, 1.6) 做对数映射，
 *      符合人耳对低频更敏感的感觉（不然全挤在左边一小撮）。
 *   ② 时间上逐帧插值、空间上做一次平滑，所以曲线永远是「连着」的，
 *      不会像频谱柱那样一格一格跳。
 *   ③ 暂停时不画成一条死线：叠一层慢慢流动的行波，安静也有呼吸感。
 *   ④ 颜色从 CSS 取（canvas 上的 color: oklch(var(--p))），
 *      换主题 / 切明暗会自动重新取色。
 *   ⑤ prefers-reduced-motion 下不跑动画，只画一帧静态曲线。
 * ============================================================
 */

import { getAnalyser, getState, subscribe } from './player';

export interface WaveOptions {
  /** 采样点数：越多曲线越细腻，40 左右刚好 */
  points?: number;
  /** 波峰高度占画布高度的比例（0–1） */
  amplitude?: number;
  /** 画几层（后面几层相位错开、透明度更低，做出纵深） */
  layers?: number;
  /** 暂停时的起伏强度（0–1） */
  idle?: number;
  /** 线宽 */
  lineWidth?: number;
}

export interface WaveHandle {
  destroy(): void;
}

const TAU = Math.PI * 2;

/**
 * 字节频谱（dB）→ 线性幅度 的查表。
 * AnalyserNode 给的是 dB，直接拿来画的话响度差异会被对数压缩，
 * 鼓点只比底噪高一丢丢；换成线性幅度，重音才真的「跳」出来。
 */
const LUT_MIN_DB = -90;
const LUT_MAX_DB = 0;
const LINEAR_LUT = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const db = LUT_MIN_DB + (i / 255) * (LUT_MAX_DB - LUT_MIN_DB);
    table[i] = Math.pow(10, db / 20);
  }
  return table;
})();

/* ---------------- 颜色 ---------------- */

/** 把任意 CSS 颜色（oklch / color() / rgb …）转成 rgba 字符串 */
function toRgba(color: string, alpha: number): string {
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return `rgba(255, 99, 180, ${alpha})`;
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } catch {
    return `rgba(255, 99, 180, ${alpha})`;
  }
}

/* ---------------- 曲线 ---------------- */

interface Point {
  x: number;
  y: number;
}

/** Catmull-Rom 插值成三次贝塞尔，得到一条真正连续的曲线 */
function traceSpline(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  const n = pts.length;
  if (n < 2) return;

  ctx.moveTo(pts[0]!.x, pts[0]!.y);

  for (let i = 0; i < n - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

/* ---------------- 主函数 ---------------- */

export function mountWave(canvas: HTMLCanvasElement, options: WaveOptions = {}): WaveHandle {
  const count = options.points ?? 44;
  const amplitude = options.amplitude ?? 0.44;
  const layers = options.layers ?? 2;
  const idle = options.idle ?? 0.13;
  const lineWidth = options.lineWidth ?? 1.6;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { destroy: () => {} };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const values = new Float32Array(count);
  const targets = new Float32Array(count);
  const smooth = new Float32Array(count);
  const shaped = new Float32Array(count);
  /** 每个频段自己的历史峰值：让安静的高频也能跟着动 */
  const bandPeaks = new Float32Array(count);
  let spectrum = new Uint8Array(1024);
  /** 整首歌的响度参考 */
  let globalPeak = 0.16;

  /** 低频能量（鼓点）的滑动均值 + 敲击包络 */
  const rawBands = new Float32Array(count);
  let lowAverage = 0;
  let kick = 0;
  /** 时域能量的「电平表」：快起慢落，整条曲线的起伏主要靠它 */
  let timeBuf = new Uint8Array(2048);
  let meterPeak = 0.03;
  let meterLevel = 0.35;
  /** 当前整体响度（0–1），画流动感的时候要用 */
  let loudness = 0;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let playing = false;
  let phase = Math.random() * TAU;
  let raf = 0;
  let last = 0;
  let ink = 'rgba(255, 99, 180, 0.8)';
  let destroyed = false;

  /** 从 canvas 的 color 上取当前主题色（换主题时会变） */
  function refreshInk(): void {
    let color = '';
    try {
      color = window.getComputedStyle(canvas).color;
    } catch {
      /* 取不到就用兜底色 */
    }
    ink = toRgba(color || '#ff63b4', 1);
  }

  function inkWithAlpha(alpha: number): string {
    // ink 形如 rgba(r, g, b, 1)，直接换掉最后一段透明度
    return ink.replace(/rgba\((\d+),\s*(\d+),\s*(\d+),[^)]+\)/, `rgba($1, $2, $3, ${alpha})`);
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reducedMotion.matches) draw(0.016);
  }

  function sample(): void {
    const analyser = getAnalyser();

    if (analyser && analyser.frequencyBinCount !== spectrum.length) {
      spectrum = new Uint8Array(analyser.frequencyBinCount);
    }

    let bins = 0;
    let binHz = 0;

    if (analyser && playing) {
      analyser.getByteFrequencyData(spectrum);
      bins = analyser.frequencyBinCount;
      binHz = (analyser.context.sampleRate || 44100) / (analyser.fftSize || 2048);
    }

    // ⓪ 时域 RMS：最直观的「音量表」。
    //    快起慢落之后，每个鼓点都会把整条曲线顶起来一次。
    if (analyser && playing) {
      if (timeBuf.length !== analyser.fftSize) timeBuf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(timeBuf);

      let squareSum = 0;
      let sampleCount = 0;
      for (let i = 0; i < timeBuf.length; i += 2) {
        const v = (timeBuf[i]! - 128) / 128;
        squareSum += v * v;
        sampleCount += 1;
      }
      const rms = Math.sqrt(squareSum / Math.max(1, sampleCount));

      meterPeak = Math.max(rms, meterPeak * 0.996, 0.02);
      const level = Math.min(1, rms / meterPeak);
      // 快起慢落：这一句就是「重音突出」的来源
      meterLevel += (level - meterLevel) * (level > meterLevel ? 0.65 : 0.07);
    } else {
      meterLevel += (0.3 - meterLevel) * 0.05;
    }

    // ① 对数频率分段取平均（40Hz → 12kHz），记下每段自己的峰值
    let frameMax = 0;
    for (let i = 0; i < count; i += 1) {
      let value = 0;

      if (bins && binHz) {
        const loBin = Math.max(0, Math.floor((40 * Math.pow(300, i / count)) / binHz));
        const hiBin = Math.min(
          bins - 1,
          Math.max(loBin + 1, Math.ceil((40 * Math.pow(300, (i + 1) / count)) / binHz)),
        );

        let sum = 0;
        let samples = 0;
        for (let b = loBin; b < hiBin; b += 1) {
          sum += LINEAR_LUT[spectrum[b]!]!;
          samples += 1;
        }
        value = samples ? sum / samples : 0;
      }

      // 高频补偿：音乐能量天然随频率下降，不补的话左边会变成一整块
      // 顶到天花板的"平台"，右边却什么都没有
      const tilt = 0.7 + 0.6 * (i / Math.max(1, count - 1));
      const weighted = value * tilt;
      rawBands[i] = weighted;

      // 每段跟自己的历史峰值比，让安静的高频也参与构图
      bandPeaks[i] = Math.max(weighted, bandPeaks[i]! * 0.985);

      if (weighted > frameMax) frameMax = weighted;
    }

    // ①b 归一化：以「当前最强的那一段」为参照 → 每帧都有一条完整起伏的山脊
    const ref = Math.max(frameMax, 0.02);
    for (let i = 0; i < count; i += 1) {
      const relative = Math.pow(rawBands[i]! / ref, 1.15);
      const own = Math.pow(rawBands[i]! / Math.max(0.008, bandPeaks[i]!), 1.4);
      shaped[i] = Math.min(1, relative * 0.8 + own * 0.2);
    }

    // ② 鼓点检测：最低那几段的能量突然超过它自己的平均值 → 记一次「敲击」
    const lowEnergy = (rawBands[0]! + rawBands[1]! + rawBands[2]! + rawBands[3]!) * 0.25;
    lowAverage += (lowEnergy - lowAverage) * 0.07;
    const flux = lowEnergy - lowAverage;
    // 相对自己平均值的超过程度：比均值高 90% 就算一次重音
    kick = Math.max(kick * 0.84, Math.min(1, flux / Math.max(0.004, lowAverage * 0.9)));

    // ③ 整体响度：安静的前奏整条曲线压低，副歌才铺满
    globalPeak = Math.max(frameMax, globalPeak * 0.995, 0.06);
    loudness = Math.min(1, frameMax / globalPeak);

    // ④ 混入暂停时的行波
    for (let i = 0; i < count; i += 1) {
      const ratio = count === 1 ? 0 : i / (count - 1);
      const wave = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(phase * 1.15 - ratio * 5.2 + 1.1));
      const idleValue = wave ** 1.7;
      const musicValue = shaped[i]! * (0.42 + 0.58 * loudness);

      targets[i] = Math.max(musicValue, idleValue * (playing ? idle * 0.7 : idle * 3));
    }
  }

  function smoothValues(dtScale: number): void {
    // 快起慢落：冲上去只要一两帧，落下来要十几帧 —— 鼓点才有「敲」的感觉
    const attack = Math.min(1, dtScale * 0.75);
    const release = Math.min(1, dtScale * 0.11);

    for (let i = 0; i < count; i += 1) {
      const target = targets[i]!;
      const current = values[i]!;
      const k = target > current ? attack : release;
      values[i] = current + (target - current) * k;
    }

    // 空间平滑：只借很少的邻居，保住每个峰的棱角
    for (let i = 0; i < count; i += 1) {
      const prev = values[Math.max(0, i - 1)]!;
      const next = values[Math.min(count - 1, i + 1)]!;
      smooth[i] = values[i]! * 0.86 + prev * 0.07 + next * 0.07;
    }
  }

  function draw(dt: number): void {
    if (!width || !height) return;

    const dtScale = dt * 60;
    phase += dt * (playing ? 1.7 : 0.55);
    sample();
    smoothValues(dtScale);

    ctx!.clearRect(0, 0, width, height);

    // 一条极淡的中轴线，让它更像一条「函数曲线」
    ctx!.beginPath();
    ctx!.moveTo(0, height / 2);
    ctx!.lineTo(width, height / 2);
    ctx!.strokeStyle = inkWithAlpha(0.09);
    ctx!.lineWidth = 1;
    ctx!.stroke();

    const mid = height / 2;
    const step = width / (count - 1);
    const ampScale = 0.4 + 0.75 * meterLevel + 0.4 * kick;

    for (let layer = layers - 1; layer >= 0; layer -= 1) {
      const depth = 1 - layer * 0.26;
      const layerPhase = phase + layer * 1.4;
      const alphaBase = layer === 0 ? 1 : 0.34 - layer * 0.1;

      const top: Point[] = [];
      const bottom: Point[] = [];

      for (let i = 0; i < count; i += 1) {
        const ratio = i / (count - 1);
        // 只在最两端收一小口气，别把最响的低频峰给削平了
        const edge = Math.min(1, Math.min(ratio, 1 - ratio) / 0.025);
        const wobble = 1 + Math.sin(layerPhase - ratio * 3.4) * 0.06;

        // 频谱的形 + 一层随响度起伏的流动行波（抒情歌没鼓点也不会死板）
        const flow = (0.5 + 0.5 * Math.sin(phase * 2.4 - ratio * 8 + layerPhase)) ** 2.4;
        const mixed = Math.max(smooth[i]!, playing ? flow * loudness * 0.4 : 0);

        const value = Math.min(1, mixed * (edge * edge * (3 - 2 * edge)) * wobble * ampScale);

        const x = i * step;
        const y = mid - value * mid * amplitude * depth * 2;
        top.push({ x, y });
        bottom.push({ x, y: mid + (mid - y) });
      }

      /* 填充：峰尖也要看得见，所以整块保持实心，中段再亮一点；
         鼓点上来时整个色块一起提亮（flash） */
      const flash = 1 + kick * 0.7;
      const gradient = ctx!.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, inkWithAlpha(Math.min(1, 0.2 * alphaBase * flash)));
      gradient.addColorStop(0.5, inkWithAlpha(Math.min(1, 0.34 * alphaBase * flash)));
      gradient.addColorStop(1, inkWithAlpha(Math.min(1, 0.2 * alphaBase * flash)));

      ctx!.beginPath();
      // 上沿从左到右 + 下沿从右到左，串成一条闭合曲线再填充
      const outline: Point[] = [];
      for (let i = 0; i < top.length; i += 1) outline.push(top[i]!);
      for (let i = bottom.length - 1; i >= 0; i -= 1) outline.push(bottom[i]!);
      traceSpline(ctx!, outline);
      ctx!.closePath();
      ctx!.fillStyle = gradient;
      ctx!.fill();

      /* 上沿那条线：发光的主曲线，鼓点上更亮一点 */
      ctx!.beginPath();
      traceSpline(ctx!, top);
      ctx!.strokeStyle = inkWithAlpha(
        Math.min(1, (layer === 0 ? 0.92 : 0.3) * (playing ? 1 : 0.7) + kick * 0.15),
      );
      ctx!.lineWidth = (layer === 0 ? lineWidth : lineWidth * 0.7) * (1 + kick * 0.35);
      ctx!.lineJoin = 'round';
      ctx!.lineCap = 'round';
      ctx!.shadowColor = inkWithAlpha(0.55 * alphaBase);
      ctx!.shadowBlur = (layer === 0 ? 9 : 4) * (1 + kick * 1.6);
      ctx!.stroke();
      ctx!.shadowBlur = 0;
    }
  }

  function loop(now: number): void {
    if (destroyed) return;
    raf = window.requestAnimationFrame(loop);
    if (document.hidden) return;

    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    draw(dt);
  }

  /* ---------------- 启动 / 收尾 ---------------- */

  const initial = getState();
  playing = initial.playing;

  const unsubscribe = subscribe(({ type, state }) => {
    if (type === 'change') playing = state.playing;
  });

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);

  const onThemeChange = (): void => {
    refreshInk();
    if (reducedMotion.matches) draw(0.016);
  };
  const themeObserver = new MutationObserver(onThemeChange);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-type'],
  });

  const onReducedMotionChange = (): void => {
    window.cancelAnimationFrame(raf);
    raf = 0;
    if (reducedMotion.matches) draw(0.016);
    else raf = window.requestAnimationFrame(loop);
  };
  reducedMotion.addEventListener('change', onReducedMotionChange);

  refreshInk();
  resize();
  if (!reducedMotion.matches) raf = window.requestAnimationFrame(loop);
  else draw(0.016);

  return {
    destroy(): void {
      destroyed = true;
      window.cancelAnimationFrame(raf);
      unsubscribe();
      observer.disconnect();
      themeObserver.disconnect();
      reducedMotion.removeEventListener('change', onReducedMotionChange);
    },
  };
}
