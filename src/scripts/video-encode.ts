/**
 * 视频压缩（全在浏览器里做，不经过任何服务器）
 * ============================================================
 * 发布动态时"视频一律压缩"，输出的永远是 MP4(H.264 + AAC)：
 *   · 体积可控（码率是我们给的，体积就是算出来的）
 *   · 格式统一（手机拍的 HEVC / .mov / 安卓的 mp4 都能收）
 *   · faststart（moov 在文件头），能边下边播、能拖进度条
 *
 * 三条路，运行时按能力选（**不能靠 isTypeSupported 查表**：
 * Chrome 里 mp4+mp4a 明明返回 true，实际编码直接 EncodingError）：
 *   ① webcodecs      VideoEncoder(avc1) + AudioEncoder(aac) + mp4-muxer
 *                    → 实测 2.9× 实时，桌面 Chrome/Edge、多数 Android Chrome
 *   ② recorder-mp4   MediaRecorder 'video/mp4;codecs=avc1,mp4a.40.2'
 *                    → 1× 实时（iOS Safari 走这条，产出标准 MP4/AAC）
 *   ③ recorder-webm  MediaRecorder 'video/webm;codecs=vp9,opus'
 *                    → 兜底，能播但不是所有 iPhone 都认
 * 三条都不行就报错拦住，不发（不发半成品）。
 * ============================================================
 */

import { MOMENT_VIDEO_AUDIO_KBPS, type VideoPlan } from '../utils/moment-meta';

export type EncodeMode = 'webcodecs' | 'recorder-mp4' | 'recorder-webm';

export interface VideoProbe {
  width: number;
  height: number;
  duration: number;
}

export interface EncodeOptions {
  plan: VideoPlan;
  /** 裁剪起点（秒） */
  start: number;
  /** 裁剪终点（秒） */
  end: number;
  onProgress?: (ratio: number, note?: string) => void;
}

export interface EncodedVideo {
  buffer: ArrayBuffer;
  ext: 'mp4' | 'webm';
  mime: string;
  width: number;
  height: number;
  duration: number;
  /** 封面（jpg）；抽不出来就是 null，卡片会退回占位背景 */
  poster: { buffer: ArrayBuffer; width: number; height: number } | null;
  mode: EncodeMode;
}

const sleep = (ms = 0) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/* ============================================================
   读元数据
   ============================================================ */

export async function probeVideo(file: File): Promise<VideoProbe> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('读视频超时了，换个文件试试')), 20000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(
          new Error(
            '这个视频浏览器解不开（常见于 HEVC / H.265）。先在手机相册或剪映里导出成 H.264 的 MP4 再发。',
          ),
        );
      };
    });

    // 有些容器（碎片化 mp4）一开始不给时长，seek 一下才吐出来
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.onseeked = done;
        video.currentTime = 1e6;
        window.setTimeout(done, 4000);
      });
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) throw new Error('拿不到视频时长，这个文件可能不完整');

    return {
      width: video.videoWidth || 1280,
      height: video.videoHeight || 720,
      duration,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/* ============================================================
   能力探测（结果缓存，弹窗里只看一次）
   ============================================================ */

let cachedMode: EncodeMode | null | undefined;

function avcCodec(width: number, height: number): string {
  const pixels = width * height;
  if (pixels > 1280 * 720) return 'avc1.42002a'; // level 4.2（1080p 必须）
  if (pixels > 720 * 576) return 'avc1.42001f'; // level 3.1
  return 'avc1.42001e'; // level 3.0
}

/** MediaRecorder 真的能出字节吗（Chrome 会谎报 isTypeSupported） */
async function recorderActuallyWorks(mime: string): Promise<boolean> {
  try {
    if (typeof MediaRecorder !== 'function' || !MediaRecorder.isTypeSupported(mime)) return false;

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 160, 90);

    const stream = canvas.captureStream(15);
    // 带上音轨一起测：Chrome 的坑就是「只有音轨组合时才炸」
    let audioContext: AudioContext | null = null;
    try {
      audioContext = new AudioContext();
      await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      gain.gain.value = 0.01;
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    } catch {
      /* 拿不到音轨就只测视频 */
    }

    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 200_000 });
    let bytes = 0;
    let failed = false;
    recorder.ondataavailable = (event) => {
      bytes += event.data.size;
    };
    recorder.onerror = () => {
      failed = true;
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start(100);
    await sleep(450);
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;

    stream.getTracks().forEach((track) => track.stop());
    await audioContext?.close();
    return !failed && bytes > 0;
  } catch {
    return false;
  }
}

export async function detectEncodeMode(): Promise<EncodeMode | null> {
  if (cachedMode !== undefined) return cachedMode;

  // ① WebCodecs：快路径。AAC 编不出来就直接放弃这条（否则会出无声视频）
  if (typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function') {
    try {
      const videoOk = await VideoEncoder.isConfigSupported({
        codec: 'avc1.42001f',
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });
      const audioOk = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: MOMENT_VIDEO_AUDIO_KBPS * 1000,
      });
      if (videoOk.supported && audioOk.supported) {
        cachedMode = 'webcodecs';
        return cachedMode;
      }
    } catch {
      /* 落到下一条 */
    }
  }

  // ② MediaRecorder 出 MP4/H.264+AAC（iOS Safari 唯一可用的压缩路径）
  if (await recorderActuallyWorks('video/mp4;codecs=avc1.42E01E,mp4a.40.2')) {
    cachedMode = 'recorder-mp4';
    return cachedMode;
  }

  // ③ WebM 兜底
  if (await recorderActuallyWorks('video/webm;codecs=vp9,opus')) {
    cachedMode = 'recorder-webm';
    return cachedMode;
  }

  cachedMode = null;
  return cachedMode;
}

/** 给界面看的模式说明 */
export function modeLabel(mode: EncodeMode): string {
  if (mode === 'webcodecs') return '硬件编码（较快）';
  if (mode === 'recorder-mp4') return '实时编码（约等于视频长度）';
  return '实时编码（WebM，iPhone 可能播不了）';
}

/* ============================================================
   通用小工具
   ============================================================ */

function loadVideoElement(url: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  return video;
}

async function waitMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('读视频超时')), 20000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('这个视频浏览器解不开'));
    };
  });
}

async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, time);
  if (Math.abs(video.currentTime - target) < 0.004) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = target;
    window.setTimeout(done, 1200);
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.82): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** 抽一帧当封面（默认取裁剪区间里第 1 秒，实在没有就取开头） */
export async function capturePoster(
  file: File,
  options: { start?: number; end?: number; maxWidth?: number } = {},
): Promise<{ buffer: ArrayBuffer; width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  const video = loadVideoElement(url);
  try {
    await waitMetadata(video);
    const start = options.start ?? 0;
    const end = options.end ?? video.duration ?? 1;
    const at = Math.min(end - 0.05, start + Math.min(1, (end - start) / 2));
    await seekTo(video, Math.max(0, at));

    const maxWidth = options.maxWidth ?? 1280;
    const scale = Math.min(1, maxWidth / Math.max(1, video.videoWidth));
    const width = even(video.videoWidth * scale);
    const height = even(video.videoHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(video, 0, 0, width, height);

    const blob = await canvasToJpeg(canvas);
    if (!blob) return null;
    return { buffer: await blob.arrayBuffer(), width, height };
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/* ============================================================
   ① WebCodecs 路径
   ============================================================ */

interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
  numberOfChannels: number;
  /** 已按裁剪区间切好 */
  length: number;
}

/** 线性插值重采样：只在解码出来的采样率不是 44100/48000 时才用到 */
function resampleChannel(channel: Float32Array, from: number, to: number): Float32Array {
  if (!channel.length || from === to) return channel;
  const ratio = to / from;
  const length = Math.max(1, Math.floor(channel.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = channel[index] ?? 0;
    const b = channel[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

/**
 * 把源文件的音轨整段解成 PCM（3 分钟内内存可控）；没音轨返回 null。
 * 采样率必须落在 44100 / 48000 —— AAC 编码器只认这两个，
 * 而 decodeAudioData 会跟着系统输出设备重采样（有人机器是 96kHz，实测就踩了）。
 */
async function decodeAudioTrack(file: File, start: number, end: number): Promise<DecodedAudio | null> {
  const buffer = await file.arrayBuffer();
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  } catch {
    context = new AudioContext();
  }

  try {
    const decoded = await context.decodeAudioData(buffer.slice(0));

    const targetRate = [44100, 48000].includes(decoded.sampleRate) ? decoded.sampleRate : 48000;
    const rate = decoded.sampleRate;
    const from = Math.max(0, Math.floor((start / 1) * rate));
    const to = Math.min(decoded.length, Math.floor((end / 1) * rate));
    const length = Math.max(0, to - from);
    if (length <= 0) return null;

    const numberOfChannels = Math.min(2, decoded.numberOfChannels);
    const channels: Float32Array[] = [];
    for (let index = 0; index < numberOfChannels; index += 1) {
      const slice = decoded.getChannelData(index).slice(from, to);
      channels.push(rate === targetRate ? slice : resampleChannel(slice, rate, targetRate));
    }

    return {
      channels,
      sampleRate: targetRate,
      numberOfChannels,
      length: channels[0]?.length ?? 0,
    };
  } catch {
    // 音轨解不出来（源无音轨 / 编码不支持）就当静音视频处理
    return null;
  } finally {
    void context.close();
  }
}

function waitQueue(encoder: VideoEncoder | AudioEncoder): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (encoder.state !== 'configured' || encoder.encodeQueueSize <= 3) resolve();
      else window.setTimeout(check, 4);
    };
    check();
  });
}

/** 配 H.264：level 配错会直接 "closed codec"，所以按分辨率挑 + 逐个试 */
async function configureAvc(encoder: VideoEncoder, plan: VideoPlan): Promise<void> {
  const base = {
    width: plan.width,
    height: plan.height,
    bitrate: plan.videoKbps * 1000,
    framerate: plan.fps,
  };
  for (const codec of [avcCodec(plan.width, plan.height), 'avc1.640028', 'avc1.4d0028']) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec, ...base, latencyMode: 'quality' });
      if (support.supported) {
        encoder.configure({ codec, ...base, latencyMode: 'quality' });
        return;
      }
    } catch {
      /* 试下一档 */
    }
  }
  throw new Error('这台设备的编码器压不了这个分辨率，换台设备或换个视频试试');
}

/** PCM → AAC；编不了返回 null（那就出无音轨视频，别毁掉整条） */
async function encodeAudioChunks(
  audio: DecodedAudio,
  plan: VideoPlan,
): Promise<Array<{ chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }> | null> {
  const config = {
    codec: 'mp4a.40.2',
    sampleRate: audio.sampleRate,
    numberOfChannels: audio.numberOfChannels,
    bitrate: plan.audioKbps * 1000,
  };
  try {
    const support = await AudioEncoder.isConfigSupported(config);
    if (!support.supported) {
      console.warn('[moment] 这台设备编不了 AAC，这条视频没有声音');
      return null;
    }
  } catch {
    return null;
  }

  const chunks: Array<{ chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }> = [];
  const state: { failure: string | null } = { failure: null };
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      chunks.push(meta ? { chunk, meta } : { chunk });
    },
    error: (error) => {
      state.failure = error.message;
    },
  });

  try {
    encoder.configure(config);
    const chunkFrames = 1024;
    for (let offset = 0; offset < audio.length; offset += chunkFrames) {
      if (state.failure) break;
      const count = Math.min(chunkFrames, audio.length - offset);
      const planar = new Float32Array(count * audio.numberOfChannels);
      for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
        planar.set(audio.channels[channel].subarray(offset, offset + count), channel * count);
      }
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: audio.sampleRate,
        numberOfFrames: count,
        numberOfChannels: audio.numberOfChannels,
        timestamp: Math.round((offset / audio.sampleRate) * 1e6),
        data: planar,
      });
      encoder.encode(data);
      data.close();
      if (encoder.encodeQueueSize > 24) await waitQueue(encoder);
    }
    if (state.failure) {
      console.warn('[moment] 音频编码失败，这条视频没有声音：', state.failure);
      return null;
    }
    await encoder.flush();
    return chunks.length ? chunks : null;
  } catch (error) {
    console.warn('[moment] 音频编码失败，这条视频没有声音：', error);
    return null;
  } finally {
    encoder.close();
  }
}

interface CaptureArgs {
  video: HTMLVideoElement;
  plan: VideoPlan;
  start: number;
  end: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  pushFrame: (frame: VideoFrame) => void;
  onProgress: (ratio: number) => void;
}

/**
 * 抽帧。
 * 主路径是「把视频播起来，用 requestVideoFrameCallback 跟着取帧」——
 * 解码器顺序解码，比"每帧 seek 回去从关键帧重解"快一个量级
 * （实测 2560×1600 的片子，逐帧 seek 是 0.18× 实时，播放取帧是 1–2×）。
 * 播不起来（没有用户手势 / 浏览器限制）就退回逐帧 seek，慢但稳。
 */
async function captureFrames(args: CaptureArgs): Promise<number> {
  const { video, plan, start, end, canvas, ctx, pushFrame, onProgress } = args;
  const span = Math.max(0.1, end - start);

  // 必须挂在文档里才会被合成：脱机元素上 requestVideoFrameCallback 不一定回调。
  // 放个 2×2 像素、几乎透明的小角落，用户看不到但浏览器照常出帧。
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText =
    'position:fixed;left:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.append(holder);
  holder.append(video);

  try {
    return await captureWithPlayback({ video, plan, start, end, canvas, ctx, pushFrame, onProgress, span });
  } finally {
    video.pause();
    holder.remove();
  }
}

async function captureWithPlayback(args: CaptureArgs & { span: number }): Promise<number> {
  const { video, plan, start, end, canvas, ctx, pushFrame, onProgress, span } = args;

  const grab = (time: number) => {
    ctx.drawImage(video, 0, 0, plan.width, plan.height);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((time - start) * 1e6),
      duration: Math.round(1e6 / plan.fps),
    });
    pushFrame(frame);
    frame.close();
  };

  await seekTo(video, start);

  let played = false;
  try {
    video.muted = true;
    // 2× 播着抽帧：解码顺序进行，实测能跑到 1.5× 实时左右
    video.playbackRate = 2;
    await video.play();
    played = true;
  } catch {
    played = false;
  }

  if (!played) {
    const frames = Math.max(1, Math.round(span * plan.fps));
    for (let index = 0; index < frames; index += 1) {
      await seekTo(video, Math.min(end - 0.002, start + index / plan.fps));
      grab(Math.min(end, start + index / plan.fps));
      if (index % 8 === 0) {
        onProgress(Math.min(0.98, index / frames));
        await sleep(0);
      }
    }
    return frames;
  }

  const minStep = 1 / plan.fps - 0.002;
  let last = start - 1;
  let captured = 0;
  const supportsRvfc = typeof video.requestVideoFrameCallback === 'function';
  const startedAt = performance.now();
  let rateDropped = video.playbackRate <= 1;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const tick = () => {
      if (done) return;
      const time = video.currentTime;
      if (video.ended || time >= end - 0.001) {
        finish();
        return;
      }
      // 播了 1.2 秒看看实际能跑多快：达不到 1.6× 就退回 1×，
      // 宁可慢一点也别丢一大片帧（实测 2560×1600 的片子在 2× 下会掉 30%）
      if (!rateDropped && performance.now() - startedAt > 1200) {
        const wall = (performance.now() - startedAt) / 1000;
        const effective = (time - start) / Math.max(0.001, wall);
        if (effective < 1.6) {
          video.playbackRate = 1;
          rateDropped = true;
        }
      }
      if (time - last >= minStep) {
        last = time;
        grab(Math.min(Math.max(time, start), end - 0.001));
        captured += 1;
        if (captured % 4 === 0) onProgress(Math.min(0.98, (time - start) / span));
      }
      if (supportsRvfc) video.requestVideoFrameCallback(tick);
      else window.setTimeout(tick, Math.max(4, Math.round(1000 / plan.fps / 2)));
    };
    if (supportsRvfc) video.requestVideoFrameCallback(tick);
    else window.setTimeout(tick, 0);
    video.addEventListener('ended', finish, { once: true });
    // 兜底：最慢按 1× 播放算，再给 15 秒
    window.setTimeout(finish, span * 1000 + 15000);
  });

  video.pause();
  onProgress(0.99);
  const expected = Math.max(1, Math.round(span * plan.fps));
  // 掉帧率只在调试时看：播放抽帧受解码能力限制，2× 下偶尔会丢一些
  console.debug(`[moment] 抽帧 ${captured} / 预计 ${expected}`);
  return captured;
}

async function encodeWithWebCodecs(file: File, options: EncodeOptions): Promise<EncodedVideo> {
  const { plan, start, end, onProgress } = options;
  // 动态 import：只有真的要压缩时才下载这个几十 KB 的封装库
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');

  const url = URL.createObjectURL(file);
  const video = loadVideoElement(url);
  try {
    await waitMetadata(video);
    onProgress?.(0.02, '解码音轨…');

    const audio = await decodeAudioTrack(file, start, end);

    // 先把 chunk 全攒在内存里，最后统一封装：
    // 这样音轨万一编不了，可以干脆封成无音轨版本，不会产出坏文件。
    const videoChunks: Array<{ chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }> = [];
    const encoderState: { failure: string | null } = { failure: null };
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        videoChunks.push(meta ? { chunk, meta } : { chunk });
      },
      error: (error) => {
        encoderState.failure = error.message;
      },
    });

    await configureAvc(videoEncoder, plan);

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持画布，压不了视频');
    ctx.imageSmoothingQuality = 'high';

    // ---- 视频：边播边抽帧（顺序解码，比逐帧 seek 快一个量级）----
    const keyEvery = Math.max(1, plan.fps * 2);
    let frameIndex = 0;
    await captureFrames({
      video,
      plan,
      start,
      end,
      canvas,
      ctx,
      pushFrame: (frame) => {
        if (encoderState.failure) return;
        videoEncoder.encode(frame, { keyFrame: frameIndex % keyEvery === 0 });
        frameIndex += 1;
      },
      onProgress: (ratio) => onProgress?.(0.04 + ratio * (audio ? 0.6 : 0.8), '编码视频…'),
    });
    if (encoderState.failure) throw new Error(`视频编码失败：${encoderState.failure}`);
    if (videoEncoder.encodeQueueSize > 0) await waitQueue(videoEncoder);
    await videoEncoder.flush();
    videoEncoder.close();

    // ---- 音频：PCM → AAC（编不了就出无音轨版本）----
    onProgress?.(0.7, '编码音轨…');
    const audioChunks = audio ? await encodeAudioChunks(audio, plan) : null;

    // ---- 封装（moov 前置：能边下边播、能拖进度条）----
    onProgress?.(0.9, '封装…');
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: plan.width, height: plan.height, frameRate: plan.fps },
      ...(audio && audioChunks
        ? {
            audio: {
              codec: 'aac' as const,
              numberOfChannels: audio.numberOfChannels,
              sampleRate: audio.sampleRate,
            },
          }
        : {}),
      // 抽帧是从"播放到的那一刻"取的，第一帧时间戳通常不是 0（实测 33ms），
      // 而 muxer 默认要求从 0 开始 → 让它整体平移一下
      firstTimestampBehavior: 'offset',
      // moov 前置：能边下边播、能拖进度条
      fastStart: 'in-memory',
    });
    for (const entry of videoChunks) muxer.addVideoChunk(entry.chunk, entry.meta);
    if (audioChunks) for (const entry of audioChunks) muxer.addAudioChunk(entry.chunk, entry.meta);
    muxer.finalize();
    onProgress?.(0.97, '生成封面…');
    const poster = await capturePoster(file, { start, end, maxWidth: Math.min(1280, plan.width) });

    return {
      buffer: target.buffer as ArrayBuffer,
      ext: 'mp4',
      mime: 'video/mp4',
      width: plan.width,
      height: plan.height,
      duration: Math.max(0, end - start),
      poster,
      mode: 'webcodecs',
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/* ============================================================
   ②③ MediaRecorder 路径（1× 实时；iOS 走这条）
   ============================================================ */

async function encodeWithRecorder(
  file: File,
  options: EncodeOptions,
  mode: EncodeMode,
): Promise<EncodedVideo> {
  const { plan, start, end, onProgress } = options;
  const mime = mode === 'recorder-mp4' ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' : 'video/webm;codecs=vp9,opus';

  const url = URL.createObjectURL(file);
  const video = loadVideoElement(url);
  video.muted = false; // 音轨要从元素里取，静音的话录出来是无声的
  video.volume = 0.0001;
  let audioContext: AudioContext | null = null;

  try {
    await waitMetadata(video);

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持画布，压不了视频');

    const stream = canvas.captureStream(plan.fps);
    // 用 WebAudio 把声音接到录制流里：不接扬声器，压缩期间没有声音外放
    try {
      audioContext = new AudioContext();
      await audioContext.resume();
      const source = audioContext.createMediaElementSource(video);
      const destination = audioContext.createMediaStreamDestination();
      source.connect(destination);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    } catch {
      audioContext = null;
    }

    let failure: string | null = null;
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: plan.videoKbps * 1000,
      audioBitsPerSecond: plan.audioKbps * 1000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      failure = '录制器出错';
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    await seekTo(video, start);
    const poster = await capturePoster(file, { start, end, maxWidth: Math.min(1280, plan.width) });

    recorder.start(400);
    await video.play();

    const span = Math.max(0.1, end - start);
    let raf = 0;
    await new Promise<void>((resolve) => {
      const paint = () => {
        ctx.drawImage(video, 0, 0, plan.width, plan.height);
        const elapsed = video.currentTime - start;
        onProgress?.(Math.min(0.97, Math.max(0, elapsed / span)), '实时编码中，请保持页面在前台…');
        if (failure || video.ended || video.currentTime >= end - 0.02) {
          resolve();
          return;
        }
        raf = requestAnimationFrame(paint);
      };
      raf = requestAnimationFrame(paint);
    });
    window.cancelAnimationFrame(raf);
    video.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    if (failure) throw new Error('实时编码失败了，换个浏览器或设备试试');

    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error('实时编码没有产出数据，这个浏览器的录制器不可用');

    return {
      buffer: await blob.arrayBuffer(),
      ext: mode === 'recorder-mp4' ? 'mp4' : 'webm',
      mime,
      width: plan.width,
      height: plan.height,
      duration: span,
      poster,
      mode,
    };
  } finally {
    void audioContext?.close();
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/* ============================================================
   对外入口
   ============================================================ */

export async function encodeVideo(
  file: File,
  options: EncodeOptions,
): Promise<EncodedVideo> {
  const mode = await detectEncodeMode();
  if (!mode) {
    throw new Error('这个浏览器压不了视频（需要 WebCodecs 或 MediaRecorder）。换 Chrome / Edge / 新版 Safari 试试。');
  }
  return mode === 'webcodecs'
    ? encodeWithWebCodecs(file, options)
    : encodeWithRecorder(file, options, mode);
}
