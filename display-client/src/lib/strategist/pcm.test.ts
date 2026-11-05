import { describe, expect, it } from 'vitest';

import { floatToInt16, int16ToBase64, resampleTo16k } from './pcm.ts';

describe('floatToInt16', () => {
  it('满量程映射到 int16 边界', () => {
    const out = floatToInt16(new Float32Array([0, 1, -1]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
    expect(out[2]).toBe(-32768);
  });

  it('超范围输入被夹住而不是回绕（回绕在音频里就是爆音）', () => {
    const out = floatToInt16(new Float32Array([2, -2]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it('长度一一对应', () => {
    expect(floatToInt16(new Float32Array(7)).length).toBe(7);
  });
});

describe('resampleTo16k', () => {
  it('已经是 16k 就原样返回（不做无谓插值）', () => {
    const src = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleTo16k(src, 16000)).toBe(src);
  });

  it('48k 降到 16k 长度变三分之一', () => {
    expect(resampleTo16k(new Float32Array(48000).fill(0.5), 48000).length).toBe(16000);
  });

  it('降采样保住信号量级（不是全零）', () => {
    const out = resampleTo16k(new Float32Array(48000).fill(0.5), 48000);
    expect(out[100]).toBeCloseTo(0.5, 2);
  });

  it('44.1k 也能降（掌机 WebView 未必认 sampleRate 请求）', () => {
    const out = resampleTo16k(new Float32Array(44100).fill(0.25), 44100);
    expect(out.length).toBe(16000);
    expect(out[500]).toBeCloseTo(0.25, 2);
  });

  it('末尾不越界读（最后一个采样点插值要夹住右邻居）', () => {
    const out = resampleTo16k(new Float32Array([0, 1, 0, 1, 0, 1]), 48000);
    expect(Number.isFinite(out[out.length - 1])).toBe(true);
  });
});

describe('int16ToBase64', () => {
  it('小端编码，能被解回原样', () => {
    const b64 = int16ToBase64(new Int16Array([1, -1]));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0xff, 0xff]);
  });

  it('长音频不爆栈（一段 30 秒录音接近 1MB，一次 apply 会 RangeError）', () => {
    const big = new Int16Array(16000 * 30);
    expect(() => int16ToBase64(big)).not.toThrow();
    expect(int16ToBase64(big).length).toBeGreaterThan(1000);
  });
});
