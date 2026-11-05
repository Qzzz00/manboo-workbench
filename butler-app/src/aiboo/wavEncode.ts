// 来源:Aiboo origin/main 7c55ce12 src/lib/wavEncode.ts
/**
 * Float32 PCM 样本（[-1,1]）→ 16bit 单声道 WAV（RIFF）字节。
 *
 * 为什么需要：浏览器 MediaRecorder 只能出 webm/opus 或 mp4/aac，而后端 volcAsr 的 extractPcm
 * 只认「RIFF/WAV」或「裸 PCM 16k/16bit/mono」——拿到 webm 会当裸 PCM 直接喂火山→解码垃圾→空转写。
 * 故客户端先把录音解码重采样成 16k 单声道 PCM，再用本函数封成 WAV，吻合后端契约。纯函数、可测。
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const dataSize = numSamples * 2; // 16bit = 2 bytes/sample, mono
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF header
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  // fmt chunk
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  // Float32 [-1,1] → Int16，越界钳制。
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // 负值用 32768、正值用 32767，避免正向溢出（1 → 32767）。
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}
