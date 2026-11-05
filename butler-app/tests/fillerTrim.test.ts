/**
 * 掐掉缓冲语头尾静音(2026-09-22)。
 *
 * 卡上点名要钉的四件:**阈值**、**最多掐多少**、**两端都掐**、**掐完不能空**。
 * 这一份里没有网络、没有 `<audio>`、没有 WebAudio:
 * {@link findTrimRange} / {@link encodeWav} / {@link trimSamplesToWav} 都是纯函数,
 * 只有最后一个 describe 里那个解码器是注入的假货。
 */
import { describe, expect, it } from 'vitest';
import {
  FILLER_TRIM_MAX_HEAD_MS,
  FILLER_TRIM_MAX_TAIL_MS,
  createOfflineDecoder,
  createWebAudioTrimmer,
  downmixToMono,
  encodeWav,
  findTrimRange,
  trimSamplesToWav,
} from '../src/call/fillerTrim';

const RATE = 24000;
const ms = (n: number): number => Math.round((n / 1000) * RATE);

/** 一段:`headMs` 静音 + `bodyMs` 有声(振幅 amp) + `tailMs` 静音。 */
function clip(headMs: number, bodyMs: number, tailMs: number, amp = 0.5, floor = 0): Float32Array {
  const out = new Float32Array(ms(headMs) + ms(bodyMs) + ms(tailMs));
  out.fill(floor);
  for (let i = 0; i < ms(bodyMs); i += 1) {
    // 正负交替:峰值检测看的是绝对值,这样也顺带钉住「负半轴也算有声」。
    out[ms(headMs) + i] = i % 2 === 0 ? amp : -amp;
  }
  return out;
}

describe('掐到哪儿(findTrimRange)', () => {
  it('★两端都掐:开头留 20ms、结尾留 50ms', () => {
    const range = findTrimRange(clip(300, 500, 400), { sampleRate: RATE });
    expect(range.trimmed).toBe(true);
    // 开头 300ms 的空白掐掉 280ms(留 20ms)。
    expect(Math.round(range.trimmedHeadMs)).toBe(280);
    // 结尾 400ms 掐掉 350ms(留 50ms)。
    expect(Math.round(range.trimmedTailMs)).toBe(350);
    expect(range.start).toBe(ms(280));
    expect(range.end).toBe(ms(300 + 500 + 50));
  });

  it('★阈值 −45dB:比它轻的底噪算静音,照掐', () => {
    // 0.003 ≈ −50dB,在阈值之下。
    const range = findTrimRange(clip(300, 500, 400, 0.5, 0.003), { sampleRate: RATE });
    expect(range.trimmed).toBe(true);
    expect(Math.round(range.trimmedHeadMs)).toBe(280);
  });

  it('★阈值 −45dB:比它响的一律算有声,一个样本都不掐', () => {
    // 0.01 ≈ −40dB,在阈值之上 —— 整段都算有声。
    const range = findTrimRange(clip(300, 500, 400, 0.5, 0.01), { sampleRate: RATE });
    expect(range.trimmed).toBe(false);
    expect(range.start).toBe(0);
  });

  it('阈值可以调:给一个更狠的阈值,原本算有声的那点底噪就被掐掉', () => {
    const samples = clip(300, 500, 400, 0.5, 0.01);
    expect(findTrimRange(samples, { sampleRate: RATE }).trimmed).toBe(false);
    expect(findTrimRange(samples, { sampleRate: RATE, thresholdDb: -30 }).trimmed).toBe(true);
  });

  it('★最多掐多少:头尾各有 1.5 秒的闸,再长的空白也只掐到这儿', () => {
    const range = findTrimRange(clip(3000, 500, 3000), { sampleRate: RATE });
    expect(range.trimmed).toBe(true);
    expect(Math.round(range.trimmedHeadMs)).toBe(FILLER_TRIM_MAX_HEAD_MS);
    expect(Math.round(range.trimmedTailMs)).toBe(FILLER_TRIM_MAX_TAIL_MS);
  });

  it('★掐完不能空:一整段都在阈值以下(全静音)就原样不掐', () => {
    const range = findTrimRange(clip(300, 500, 400, 0.001), { sampleRate: RATE });
    expect(range.trimmed).toBe(false);
    expect(range.start).toBe(0);
    expect(range.end).toBe(ms(1200));
  });

  it('★掐完不能空:只剩一声极短的响动 —— 判不准,原样不掐', () => {
    const samples = new Float32Array(ms(500));
    samples[ms(250)] = 0.9; // 独独一个样本
    const range = findTrimRange(samples, { sampleRate: RATE });
    expect(range.trimmed).toBe(false);
  });

  it('★掐完不能空:整段本来就比「最少留 200ms」还短,先怀疑自己,不掐', () => {
    const range = findTrimRange(clip(50, 20, 50), { sampleRate: RATE });
    expect(range.trimmed).toBe(false);
  });

  it('本来就没有头尾空白:不掐(也就不用白白重编一遍)', () => {
    const range = findTrimRange(clip(0, 800, 0), { sampleRate: RATE });
    expect(range.trimmed).toBe(false);
  });

  it('只有开头有空白:只掐那一头', () => {
    const range = findTrimRange(clip(300, 800, 0), { sampleRate: RATE });
    expect(range.trimmed).toBe(true);
    expect(Math.round(range.trimmedHeadMs)).toBe(280);
    expect(range.trimmedTailMs).toBe(0);
  });

  it('坏样本(NaN / Infinity)当静音 —— 一个坏样本不该把起点拽回 0', () => {
    const samples = clip(300, 500, 400);
    samples[10] = Number.NaN;
    samples[20] = Number.POSITIVE_INFINITY;
    const range = findTrimRange(samples, { sampleRate: RATE });
    expect(range.trimmed).toBe(true);
    expect(Math.round(range.trimmedHeadMs)).toBe(280);
  });

  it('空的 / 采样率不对:原样,不抛', () => {
    expect(findTrimRange(new Float32Array(0), { sampleRate: RATE }).trimmed).toBe(false);
    expect(findTrimRange(clip(300, 500, 400), { sampleRate: 0 }).trimmed).toBe(false);
    expect(findTrimRange(clip(300, 500, 400), { sampleRate: Number.NaN }).trimmed).toBe(false);
  });
});

/** WAV 头读回来,给下面几条用。 */
function readWav(wav: ArrayBuffer): { rate: number; bits: number; channels: number; samples: Int16Array } {
  const view = new DataView(wav);
  const tag = (at: number): string => String.fromCharCode(
    view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3),
  );
  expect(tag(0)).toBe('RIFF');
  expect(tag(8)).toBe('WAVE');
  expect(tag(12)).toBe('fmt ');
  expect(tag(36)).toBe('data');
  const bytes = view.getUint32(40, true);
  return {
    rate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    channels: view.getUint16(22, true),
    samples: new Int16Array(wav.slice(44, 44 + bytes)),
  };
}

describe('封成 WAV(encodeWav)', () => {
  it('头是对的:RIFF/WAVE、16 位、单声道、采样率照给的那个', () => {
    const wav = encodeWav(new Float32Array(ms(100)), RATE);
    const parsed = readWav(wav);
    expect(parsed.rate).toBe(RATE);
    expect(parsed.bits).toBe(16);
    expect(parsed.channels).toBe(1);
    expect(parsed.samples.length).toBe(ms(100));
    expect(wav.byteLength).toBe(44 + ms(100) * 2);
  });

  it('满幅的 ±1.0 不绕回:+1 → 32767,−1 → −32768', () => {
    const parsed = readWav(encodeWav(Float32Array.from([1, -1, 0]), RATE));
    expect([...parsed.samples]).toEqual([32767, -32768, 0]);
  });

  it('超出 [-1,1] 的削平,坏样本当 0', () => {
    const parsed = readWav(encodeWav(Float32Array.from([2, -2, Number.NaN]), RATE));
    expect([...parsed.samples]).toEqual([32767, -32768, 0]);
  });
});

describe('掐 + 封(trimSamplesToWav)', () => {
  it('★掐过的 WAV 里,第一个样本就该是有声的那一段(减去留的 20ms)', () => {
    const result = trimSamplesToWav(clip(300, 500, 400), { sampleRate: RATE });
    expect(result.trimmed).toBe(true);
    const parsed = readWav(result.wav);
    // 留下的长度 = 20ms 空白 + 500ms 有声 + 50ms 空白。
    expect(parsed.samples.length).toBe(ms(570));
    // 前 20ms 还是空白,第 20ms 之后是那段有声。
    expect(parsed.samples[0]).toBe(0);
    expect(Math.abs(parsed.samples[ms(20)]!)).toBeGreaterThan(1000);
  });

  it('不掐的时候也照样给一份完整的 WAV(长度一个样本都没少)', () => {
    const samples = clip(0, 800, 0);
    const result = trimSamplesToWav(samples, { sampleRate: RATE });
    expect(result.trimmed).toBe(false);
    expect(readWav(result.wav).samples.length).toBe(samples.length);
  });
});

describe('多声道压成单声道(downmixToMono)', () => {
  it('两条声道逐样本取平均', () => {
    const mono = downmixToMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1])]);
    expect([...mono]).toEqual([0.5, 0, 0]);
  });

  it('本来就是单声道:原样', () => {
    const one = Float32Array.from([0.1, 0.2]);
    expect(downmixToMono([one])).toBe(one);
  });

  it('一条声道都没有:空的,不抛', () => {
    expect(downmixToMono([]).length).toBe(0);
  });
});

describe('接到 blob 上那一层(createWebAudioTrimmer)', () => {
  /** 一个假解码器:把 blob 里的字节当成「几毫秒静音 + 几毫秒有声 + 几毫秒静音」的描述。 */
  const decodeClip = async (): Promise<{ channels: Float32Array[]; sampleRate: number }> => ({
    channels: [clip(300, 500, 400)],
    sampleRate: RATE,
  });

  it('★这台 WebView 没有 OfflineAudioContext:返回 null —— 调用方据此整个不掐', () => {
    // jsdom 里本来就没有,所以默认构造正好走这一条。
    expect(createOfflineDecoder()).toBeNull();
    expect(createWebAudioTrimmer()).toBeNull();
    expect(createWebAudioTrimmer({ decode: null })).toBeNull();
  });

  it('★正常:掐过之后是一份 audio/wav,而且报得出掐了多少', async () => {
    const trim = createWebAudioTrimmer({ decode: decodeClip })!;
    const result = await trim(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }));
    expect(result.trimmed).toBe(true);
    expect(result.blob.type).toBe('audio/wav');
    expect(Math.round(result.trimmedHeadMs)).toBe(280);
    expect(Math.round(result.trimmedTailMs)).toBe(350);
  });

  it('★没什么可掐的:把原来那个 blob 原样还回去(不白白把 mp3 变成大一倍的 WAV)', async () => {
    const trim = createWebAudioTrimmer({ decode: async () => ({ channels: [clip(0, 800, 0)], sampleRate: RATE }) })!;
    const original = new Blob([new Uint8Array([1])], { type: 'audio/mpeg' });
    const result = await trim(original);
    expect(result.trimmed).toBe(false);
    expect(result.blob).toBe(original);
  });

  it('★解不开(老 WebView、半截的字节):原样还回去,不抛 —— 不许带走一通电话', async () => {
    const lines: string[] = [];
    const trim = createWebAudioTrimmer({
      decode: async () => { throw new Error('EncodingError'); },
      log: line => lines.push(line),
    })!;
    const original = new Blob([new Uint8Array([1])], { type: 'audio/mpeg' });
    const result = await trim(original);
    expect(result.blob).toBe(original);
    expect(result.trimmed).toBe(false);
    expect(lines.join('')).toContain('EncodingError');
  });

  it('一个字节都没有的 blob:原样,不去解码', async () => {
    let called = 0;
    const trim = createWebAudioTrimmer({ decode: async () => { called += 1; return await decodeClip(); } })!;
    const original = new Blob([], { type: 'audio/mpeg' });
    expect((await trim(original)).blob).toBe(original);
    expect(called).toBe(0);
  });

  it('解出来一条声道都没有:原样,不给一段空气', async () => {
    const trim = createWebAudioTrimmer({ decode: async () => ({ channels: [], sampleRate: RATE }) })!;
    const original = new Blob([new Uint8Array([1])], { type: 'audio/mpeg' });
    expect((await trim(original)).blob).toBe(original);
  });
});
