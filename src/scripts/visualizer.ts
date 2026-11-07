/**
 * 音乐律动
 * ============================================================
 * 用 Web Audio 的 AnalyserNode 拿真实频谱，插值成一条**连续曲线**
 * （Catmull-Rom → 三次贝塞尔），上下镜像后填色，看起来像一层会呼吸的山脊。
 *
 * 几个刻意的设计：
 *   ① 频段按**对数**划分（40Hz → 14kHz），每个频段占的像素差不多宽，
 *      符合人耳的分辨习惯；而且分段边界会缓存，不用每帧重算。
 *   ② 归一化分两路，**都不是**跟「全场最强的那一段」比：
 *      ・contrast：这一段相对**它自己的平均水平**涨了几倍（log2 刻度）；
 *      ・presence：这一段相对**它自己的历史最高**还差多远。
 *      音乐能量天然随频率往下掉几十倍，一起比的话右边永远是一条死线
 *      （这就是以前"波峰全挤在左端、大部分时间很平静"的原因）。
 *   ③ 谱通量：整条曲线相对上一帧「往上长」了多少 —— 鼓点、贝斯进拍
 *      都能抓到，比盯着总音量准，而且跟音量大小无关。
 *   ④ 绝对响度（dBFS）把握整体幅度和亮度：上面那些量都是「相对自己」算的，
 *      所以安静段落也能满幅跳；乘上响度包络之后，安静的地方明显收着，
 *      副歌才炸开。dBFS 是音乐本身的电平，跟音量滑块无关。
 *   ⑤ 时间上逐帧插值、空间上做一次平滑，所以曲线永远是「连着」的，
 *      不会像频谱柱那样一格一格跳。
 *   ⑥ 暂停时不画成一条死线：叠一层慢慢流动的行波，安静也有呼吸感。
 *   ⑦ 颜色从 CSS 取（canvas 上的 color: oklch(var(--p))），
 *      换主题 / 切明暗会自动重新取色。
 *   ⑧ 冷启动要「打底」：刚开播 / 刚恢复 / 刚换歌的头一帧，各段的历史
 *      平均值还是 0，直接算 ratio 会让整条曲线瞬间糊满。所以第一帧直接
 *      写入基线，之后半秒用「见过的最大值」当基线，再过渡回慢速平均。
 *   ⑨ prefers-reduced-motion 下不跑动画，只画一帧静态曲线。
 *
 * 频谱本身**不受音量影响**：player.ts 里音量走的是分析器后面的增益节点，
 * 元素音量锁在 1，所以把音量拖到 1% 还是 100%，这条曲线的起伏都一样。
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

/** 频段范围：40Hz 起，每段等比放大，直到约 14kHz（再往上只剩噪声） */
const BAND_LOW_HZ = 40;
const BAND_SPAN = 350;

/**
 * 响度门限：-26dBFS 以下算「安静到底」，-14dBFS 以上算「最响」。
 * 这是「响的地方才炸、安静的地方明显收着」的依据 —— 只看音乐本身的
 * 电平，跟音量滑块无关（分析器接在增益之前）。
 */
const LOUD_FLOOR_DB = -26;
const LOUD_SPAN_DB = 12;

/**
 * 字节频谱（dB）→ 线性幅度 的查表。
 * AnalyserNode 给的是 dB，直接拿来做比例的话响度差异会被对数压缩，
 * 换成线性幅度，重音之间的倍数关系才是真实的。
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
  const amplitude = options.amplitude ?? 0.46;
  const layers = options.layers ?? 2;
  const idle = options.idle ?? 0.1;
  const lineWidth = options.lineWidth ?? 1.6;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { destroy: () => {} };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** 每段自己的历史最高 / 慢平均 —— 自动增益就靠这两个 */
  const bandPeak = new Float32Array(count);
  const bandAvg = new Float32Array(count);
  /** 逐帧的瞬时形状（0–1） */
  const shaped = new Float32Array(count);
  /** 上一帧的形状，用来算谱通量 */
  const prevShaped = new Float32Array(count);
  /** 平滑后的最终高度 */
  const values = new Float32Array(count);
  const targets = new Float32Array(count);
  const smooth = new Float32Array(count);

  /** 频段边界（bin 索引），只在场/采样率/点数变化时重算 */
  const bandLo = new Int32Array(count);
  const bandHi = new Int32Array(count);
  let bandKey = '';

  let spectrum = new Uint8Array(1024);
  let timeBuf = new Uint8Array(2048);

  /** 整体活跃度（0–1）：频谱形状的平均高度，主要用来微调幅度 */
  let energy = 0.35;
  /** 谱通量鼓点包络（0–1）：重音时整条曲线被顶起来一次 */
  let beat = 0;
  let fluxAverage = 0.004;
  /** 低频平均高度：贝斯响的时候让低频段更饱满 */
  let lowBands = 0;
  /**
   * 绝对响度（0–1）：这一段音乐**真的有多响**。
   * 前面那些量都是「相对自己」算的（所以安静段落也满幅跳），
   * 这个量看的是 dBFS 本身 —— 安静的前奏靠它把整条曲线收回去，
   * 副歌才炸开。跟音量滑块无关：分析器在增益之前，读的是原始信号。
   */
  let loud = 0;
  /** 响度的 0.5 秒滑动平均（dBFS），抹掉逐帧抖动 */
  let dbSmooth = -30;

  /**
   * 冷启动标记：刚开播 / 刚从暂停恢复 / 刚换歌的那一帧要做「打底」，
   * 否则每个频段都在跟一个几乎为 0 的历史平均值比 → 对比度全部顶到 1，
   * 看起来就是"一开播整条曲线直接糊满"。
   */
  let pendingReset = true;
  /** 上一帧分析器有没有给出数据 */
  let prevLive = false;
  /** 冷启动之后，还要用「峰值保持」当基线的帧数（约半秒） */
  let warmup = 0;
  /** 上一次看到的歌，用来判断换歌 */
  let lastSongId: string | null = null;

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

  /** 对数分段：第 i 段覆盖 [40·350^(i/count), 40·350^((i+1)/count)) */
  function layoutBands(bins: number, binHz: number): void {
    const key = `${count}:${bins}:${binHz.toFixed(2)}`;
    if (key === bandKey) return;
    bandKey = key;

    for (let i = 0; i < count; i += 1) {
      const f0 = BAND_LOW_HZ * Math.pow(BAND_SPAN, i / count);
      const f1 = BAND_LOW_HZ * Math.pow(BAND_SPAN, (i + 1) / count);
      const lo = Math.max(1, Math.min(bins - 1, Math.floor(f0 / binHz)));
      const hi = Math.min(bins - 1, Math.max(lo + 1, Math.ceil(f1 / binHz)));
      bandLo[i] = lo;
      bandHi[i] = hi;
    }
  }

  function sample(dt: number): void {
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
      if (binHz > 0) layoutBands(bins, binHz);
    }

    /* ① 逐段取平均幅度，同时维护每段自己的峰值 / 慢平均。
       峰值缓慢回落（大约十秒掉四成），停播时冻结 —— 否则暂停久了
       再按播放，所有段落会一起从 0 冲到满格。 */
    const live = bins > 0;

    // 频谱几乎全 0 = 还没出声（浏览器刚建好音频图 / 换歌缓冲 / 上下文刚恢复）。
    // 这种帧不能拿来打底：平均值一旦被固定到 1e-6，接下来一秒
    // value/avg 会差几十倍，log2 之后每个频段都顶到 1 —— 就是"一开播糊满"。
    let peakByte = 0;
    if (live) {
      for (let b = 0; b < bins; b += 8) {
        const v = spectrum[b]!;
        if (v > peakByte) peakByte = v;
      }
    }
    const silent = live && peakByte < 24;

    // 刚开播 / 刚恢复 / 刚换歌的第一帧「有声音的」帧只用来打底
    const cold = live && !silent && (!prevLive || pendingReset);
    const peakDecay = playing ? Math.pow(0.9985, dt * 60) : 1;
    const lowCount = Math.max(1, Math.round(count * 0.12));
    let sumAll = 0;
    let sumLow = 0;

    for (let i = 0; i < count; i += 1) {
      // 没数据 / 声音还没真的出来：这一帧不参与计算，画成暂停那种呼吸线。
      // 关键是别拿这种"几乎全 0"的帧去喂自动增益，不然平均值会被拉到底。
      if (!live || silent) {
        shaped[i] = 0;
        continue;
      }

      const lo = bandLo[i]!;
      const hi = bandHi[i]!;
      let sum = 0;
      for (let b = lo; b < hi; b += 1) sum += LINEAR_LUT[spectrum[b]!]!;
      const value = sum / Math.max(1, hi - lo);

      if (cold) {
        /* 冷启动打底：把这一帧当成「这一段平时的样子」的起点。
           不这么做的话，历史平均值还是 0 附近，value/avg 能差几十倍，
           log2 之后每个频段都顶到 1 —— 一开播整条曲线糊满就是这么来的。 */
        bandPeak[i] = value;
        bandAvg[i] = value;
      } else if (warmup > 0) {
        /* 打底之后的头半秒：基线取「这段时间见过的最大值」（peak hold）。
           打底那一帧常常正好撞上播放器刚开始出声、音量还在往上爬的那几帧，
           那时 value 很小；如果马上切回慢速平均，平均值跟不上，
           对比度又会顶满。用见过的最大值当基线，ratio 恒 ≤ 1，
           怎么都不会饱和，半秒后再自然过渡回慢速平均。 */
        bandPeak[i] = Math.max(value, bandPeak[i]! * peakDecay);
        bandAvg[i] = Math.max(bandAvg[i]!, value);
      } else {
        const peak = bandPeak[i]!;
        const avg = bandAvg[i]!;
        bandPeak[i] = value > peak ? value : peak * peakDecay;
        bandAvg[i] = avg + (value - avg) * Math.min(1, dt * 1.1);
      }

      /* ② 归一化 —— 关键的一步，分两路：
         ・contrast：跟**这一段自己的平均水平**比，涨了多少倍（log2 刻度，
           人耳本来就是按倍数判断响度）。低频一拍能有 20dB 的起伏，
           高频的镲也有十几 dB —— 各算各的倍数，右边才不会是一条死线。
         ・presence：跟**这一段自己的最高点**比，还差多远。用来保留
           "整体响起"的那层信息，免得只有相对变化、没有强弱感。 */
      const ownPeak = bandPeak[i]!;
      const ownAvg = Math.max(ownPeak * 0.02, bandAvg[i]!, 1e-7);

      const contrast = Math.max(0, Math.min(1, (Math.log2(value / ownAvg) + 0.9) / 2.4));
      const presence = ownPeak > 1e-7 ? Math.pow(Math.min(1, value / ownPeak), 1.3) : 0;

      const norm = Math.max(0, Math.min(1, contrast * 0.82 + presence * 0.18));
      shaped[i] = norm;

      sumAll += norm;
      if (i < lowCount) sumLow += norm;
    }

    /* ③ 谱通量：整体形状相对上一帧「往上长」了多少 —— 比看总音量更准，
       鼓点、贝斯进拍都能抓到，而且跟音量大小无关。
       冷启动那一帧不算：它从全 0 直接跳到基线，通量必然是满值，
       会额外触发一次假鼓点（整块提亮、幅度再顶一把）。 */
    let flux = 0;
    if (live && !cold) {
      for (let i = 0; i < count; i += 1) {
        const diff = shaped[i]! - prevShaped[i]!;
        if (diff > 0) flux += diff;
      }
      flux /= count;
    }
    for (let i = 0; i < count; i += 1) prevShaped[i] = shaped[i]!;

    if (cold) {
      // 打底这一帧直接归零，别让上一首的鼓点包络延续过来
      beat = 0;
      fluxAverage = 0.004;
    } else {
      fluxAverage += (flux - fluxAverage) * Math.min(1, dt * 3);
      // 只有明显超过自己平均水平的那一下才算鼓点，避免整首歌都在闪
      const gate = fluxAverage * 2.1 + 0.004;
      const punch = Math.max(0, Math.min(1, (flux - gate) / (gate * 1.5 + 1e-4)));
      // 快起慢落：重音一下就顶起来，之后慢慢退回去
      beat = Math.max(beat * Math.exp(-dt / 0.19), punch);
    }

    /* ④ 绝对响度：拿时域 RMS 换算成 dBFS。
       这是「这段音乐有多响」的客观值，跟音量滑块无关（分析器在增益前面）。
       前奏/主歌闷着唱的时候它很低，副歌一进来它顶到 1 —— 幅度和亮度
       都跟着它走，安静的地方才会明显收着。 */
    if (live && analyser) {
      if (timeBuf.length !== analyser.fftSize) timeBuf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(timeBuf);

      let square = 0;
      let samples = 0;
      for (let i = 0; i < timeBuf.length; i += 2) {
        const v = (timeBuf[i]! - 128) / 128;
        square += v * v;
        samples += 1;
      }
      const rms = Math.sqrt(square / Math.max(1, samples));
      const db = 20 * Math.log10(Math.max(rms, 1e-5));

      // 以 -14dBFS 为「最响」，往下 12dB（-26dBFS）就是「安静到底」。
      // 参考点固定、不做自适应 —— 这样同一首歌每次播放、或者从哪一段开始听，
      // 强弱关系都一样，不会「先听到副歌就整首变小」。
      dbSmooth = cold ? db : dbSmooth + (db - dbSmooth) * Math.min(1, dt * 2);
      const dev = Math.max(0, Math.min(1, (dbSmooth - LOUD_FLOOR_DB) / LOUD_SPAN_DB));
      const target = Math.pow(dev, 1.5);
      if (cold) {
        // 第一帧直接对位，不然会从 0 爬上来（开头小一下再变大）
        loud = target;
      } else {
        // 起得快（副歌一进来立刻炸），退得慢（一句唱完不会马上塌掉）
        loud += (target - loud) * Math.min(1, dt * (target > loud ? 10 : 2.5));
      }
    } else if (!playing) {
      loud += (0 - loud) * Math.min(1, dt * 0.6);
    }

    /* ⑤ 整体活跃度：用来把握幅度整体抬高 / 压低，
       让安静段落不至于整条趴在中间，副歌又能铺满。 */
    const energyNow = live ? sumAll / count : 0;
    energy = cold ? energyNow : energy + (energyNow - energy) * Math.min(1, dt * (energyNow > energy ? 9 : 1.6));

    lowBands = live ? sumLow / lowCount : 0;

    /* ⑥ 混入暂停时的行波：暂停不画死线，慢慢流动；
       播放中遇到极安静的段落 / 缓冲中，也留一口气，别塌成一条直线 */
    for (let i = 0; i < count; i += 1) {
      const ratio = count === 1 ? 0 : i / (count - 1);
      const breath = (0.5 + 0.5 * Math.sin(phase * 1.1 - ratio * 4.6 + 0.8)) ** 1.8;
      targets[i] = playing
        ? Math.max(shaped[i]!, breath * (idle * 0.9 + 0.05))
        : breath * idle * 3.4;
    }

    // 打底做完，后面的帧正常计算
    if (cold) {
      pendingReset = false;
      warmup = 30;
    } else if (warmup > 0) {
      warmup -= 1;
    }
    prevLive = live;
  }

  function smoothValues(dtScale: number): void {
    // 快起慢落：冲上去只要一两帧，落下来要十几帧 —— 鼓点才有「敲」的感觉
    const attack = Math.min(1, dtScale * 0.8);
    const release = Math.min(1, dtScale * 0.13);

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
      smooth[i] = values[i]! * 0.84 + prev * 0.08 + next * 0.08;
    }
  }

  function draw(dt: number): void {
    if (!width || !height) return;

    const dtScale = dt * 60;
    phase += dt * (playing ? 1.7 : 0.55);
    sample(dt);
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
    const step = width / Math.max(1, count - 1);
    /* 响度包络：安静段落整条曲线收着（幅度压到五六成、也没那么亮），
       副歌顶上来的时候才炸开。静止（暂停）时给一个中间值，别把呼吸线掐掉。 */
    const dyn = playing ? 0.5 + 0.8 * loud : 0.8;
    const lum = playing ? 0.45 + 0.55 * loud : 0.85;
    // 幅度基准在 1 附近：低了趴平，高了削顶；
    // 再乘上响度包络，音乐一起来整条曲线就「撑开」
    const ampScale = (0.98 + 0.18 * energy + 0.25 * beat + 0.1 * lowBands) * dyn;
    const flowGain = playing ? (0.08 + 0.22 * energy) * (0.25 + 0.75 * loud) : 0;

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

        // 频谱的形 + 一层随活跃度起伏的行波（抒情歌没鼓点也不会死板）
        const flow = (0.5 + 0.5 * Math.sin(phase * 2.4 - ratio * 8 + layerPhase)) ** 2.4;
        const mixed = Math.max(smooth[i]!, flow * flowGain);

        const raw = mixed * (edge * edge * (3 - 2 * edge)) * wobble * ampScale;
        // 顶端软饱和：0.7 以下原样保留，往上一段逐渐压缩，
        // 重音能顶到 0.9 以上，但不会削成一条平顶直线
        const over = Math.max(0, raw - 0.7);
        const value = Math.min(1, raw <= 0.7 ? raw : 0.7 + over / (1 + over * 1.3));

        const x = i * step;
        const y = mid - value * mid * amplitude * depth * 2;
        top.push({ x, y });
        bottom.push({ x, y: mid + (mid - y) });
      }

      /* 填充：峰尖也要看得见，所以整块保持实心，中段再亮一点；
         鼓点上来时整个色块一起提亮（flash），安静段落整体压暗（lum） */
      const flash = (1 + beat * 0.7) * lum;
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

      /* 上沿那条线：发光的主曲线，鼓点上更亮一点，安静段落跟着 lum 收暗 */
      ctx!.beginPath();
      traceSpline(ctx!, top);
      ctx!.strokeStyle = inkWithAlpha(
        Math.min(1, ((layer === 0 ? 0.95 : 0.32) * lum + beat * 0.15)),
      );
      ctx!.lineWidth = (layer === 0 ? lineWidth : lineWidth * 0.7) * (1 + beat * 0.35) * (0.85 + 0.15 * lum);
      ctx!.lineJoin = 'round';
      ctx!.lineCap = 'round';
      ctx!.shadowColor = inkWithAlpha(0.55 * alphaBase * lum);
      ctx!.shadowBlur = (layer === 0 ? 9 : 4) * (1 + beat * 1.6);
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
  lastSongId = initial.songId;

  const unsubscribe = subscribe(({ type, state }) => {
    if (type !== 'change') return;
    playing = state.playing;

    // 换歌：上一首的峰值 / 平均值对新的一首毫无意义（而且会让开头
    // 一小段时间里对比度整体偏掉），清空后由下一帧重新打底。
    const nextSong = state.songId ?? null;
    if (nextSong !== lastSongId) {
      lastSongId = nextSong;
      bandPeak.fill(0);
      bandAvg.fill(0);
      prevShaped.fill(0);
      beat = 0;
      fluxAverage = 0.004;
      pendingReset = true;
    }
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
