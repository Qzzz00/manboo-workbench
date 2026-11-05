// 来源:Aiboo origin/main 7c55ce12 src/lib/asr.ts —— 只取 pickRecorderMimeType 一个函数。
// 原文件其余部分(转码 + POST /ai/asr)在本工程由 src/api/voice.ts 的 asr() 承担:录音 hook 自己已经出 16k WAV。

/** 选 MediaRecorder 的录音格式:优先 mp4(aac),次 webm。 */
export function pickRecorderMimeType(): string | undefined {
  const MR = (globalThis as unknown as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder;
  if (!MR) return undefined;
  if (MR.isTypeSupported('audio/mp4')) return 'audio/mp4';
  if (MR.isTypeSupported('audio/webm')) return 'audio/webm';
  return undefined;
}
