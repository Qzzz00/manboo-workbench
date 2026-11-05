/**
 * 语音转文字客户端：录音 blob → 16k 单声道 WAV → base64 → POST /ai/asr → 文字。
 *
 * ★为什么要转码：浏览器 MediaRecorder 只能出 webm/opus 或 mp4/aac，而后端 volcAsr 的 extractPcm
 * 只认 RIFF/WAV 或裸 PCM 16k/16bit/mono——拿到 webm/opus 会当裸 PCM 直接喂火山→解码垃圾→空转写
 * (真机实测浏览器路径全 422 EMPTY_TRANSCRIPT 的根因)。故先经 Web Audio 解码+重采样成 16k 单声道
 * PCM，再封 WAV 发出，吻合后端契约。解码失败(极少)回落发原始 blob(退化但不崩)。
 */
import { apiPost } from './apiClient';
import { API_AI_ASR } from './apiConfig';
import { encodeWavPcm16 } from './wavEncode';

const ASR_SAMPLE_RATE = 16000;

/** 选 MediaRecorder 的录音格式：优先 Qwen-ASR 友好的 mp4(aac)，次 webm。 */
export function pickRecorderMimeType(): string | undefined {
  const MR = (globalThis as unknown as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder;
  if (!MR) return undefined;
  if (MR.isTypeSupported('audio/mp4')) return 'audio/mp4';
  if (MR.isTypeSupported('audio/webm')) return 'audio/webm';
  return undefined;
}

/** blob → 纯 base64（不含 data: 前缀）。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取音频失败'));
    reader.readAsDataURL(blob);
  });
}

/** 把录音 blob 解码 + 重采样成 16k 单声道，再取 Float32 PCM 样本。 */
async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const AC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AC();
  let decoded: AudioBuffer;
  try {
    // slice(0)：某些实现会 detach 传入的 ArrayBuffer，传副本更稳。
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void decodeCtx.close?.();
  }
  // 用 OfflineAudioContext 把任意采样率/声道渲染成 16k 单声道（连到 1 声道 destination 自动下混）。
  const frames = Math.max(1, Math.ceil(decoded.duration * ASR_SAMPLE_RATE));
  const OAC: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const offline = new OAC(1, frames, ASR_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** 录音 blob → { base64 音频, mimeType }：优先转 16k 单声道 WAV；解码失败回落原始 blob。 */
async function encodeBlobForAsr(blob: Blob): Promise<{ audio: string; mimeType: string }> {
  try {
    const pcm = await decodeToMono16k(blob);
    const wav = encodeWavPcm16(pcm, ASR_SAMPLE_RATE);
    const audio = await blobToBase64(new Blob([wav], { type: 'audio/wav' }));
    return { audio, mimeType: 'audio/wav' };
  } catch (err) {
    console.warn('[asr] WAV transcode failed, sending raw blob (可能识别不出):', err);
    return { audio: await blobToBase64(blob), mimeType: blob.type || 'audio/webm' };
  }
}

/** 转写一段录音，返回识别文字（失败/空值调用方按 ApiError 处理）。 */
export async function transcribeBlob(blob: Blob): Promise<string> {
  const { audio, mimeType } = await encodeBlobForAsr(blob);
  const data = (await apiPost(API_AI_ASR, { audio, mimeType })) as { text?: string };
  return (data?.text || '').trim();
}
