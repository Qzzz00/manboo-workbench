// 录音数据 → 火山 ASR 要的 16kHz / 16bit / 单声道 raw PCM。
//
// ★为什么是 raw PCM 而不是 MediaRecorder 的 webm/opus：现有的
// server/services/volcAsr.cjs（已在生产跑通）走的就是 raw PCM 那条协议。
// 用 webm 就得在 Python 服务端塞一个 ffmpeg 进 Docker 镜像转码，凭空多一个二进制依赖。

/** Float32 [-1,1] → Int16。超范围**夹住**而不是回绕——回绕在音频里就是爆音。 */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const v = Math.max(-1, Math.min(1, input[i]));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/**
 * 线性插值重采样到 16kHz。
 * 优先让浏览器做（`new AudioContext({sampleRate:16000})`）；这里是兜底——
 * 部分 WebView 会忽略 sampleRate 请求，拿到的仍是 44.1k/48k。
 */
export function resampleTo16k(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16000) return input;
  const ratio = srcRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    // 右邻居夹在数组内：最后一个采样点插值时 i0+1 会越界，读出 undefined → NaN。
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Int16Array → base64（小端字节序，与协议一致）。 */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // 分块拼：一次 String.fromCharCode(...bytes) 参数太多会 RangeError（爆栈），
  // 一段 30 秒录音接近 1MB，必现。
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
