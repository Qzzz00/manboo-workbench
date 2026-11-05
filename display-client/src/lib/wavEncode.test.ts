import { describe, it, expect } from 'vitest';
import { encodeWavPcm16 } from './wavEncode.ts';

/** 读小端字段的辅助。 */
function u32(v: Uint8Array, o: number) {
  return v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24);
}
function u16(v: Uint8Array, o: number) {
  return v[o] | (v[o + 1] << 8);
}
function ascii(v: Uint8Array, o: number, n: number) {
  return String.fromCharCode(...v.slice(o, o + n));
}

describe('encodeWavPcm16', () => {
  it('生成合法 RIFF/WAVE 头 + 16bit/mono/指定采样率', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWavPcm16(samples, 16000);
    // header 44 字节 + 5 样本 * 2 字节
    expect(wav.length).toBe(44 + 5 * 2);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(u32(wav, 16)).toBe(16); // fmt chunk size
    expect(u16(wav, 20)).toBe(1); // PCM
    expect(u16(wav, 22)).toBe(1); // mono
    expect(u32(wav, 24)).toBe(16000); // sample rate
    expect(u16(wav, 32)).toBe(2); // block align = 1ch*2byte
    expect(u16(wav, 34)).toBe(16); // bits
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(u32(wav, 40)).toBe(5 * 2); // data size
    // RIFF size = 36 + dataSize
    expect(u32(wav, 4)).toBe(36 + 5 * 2);
  });

  it('Float32 [-1,1] → Int16 正确量化 + 越界钳制', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2]), 16000);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(dv.getInt16(44 + 0 * 2, true)).toBe(0);
    expect(dv.getInt16(44 + 1 * 2, true)).toBe(32767); // 1 → max
    expect(dv.getInt16(44 + 2 * 2, true)).toBe(-32768); // -1 → min
    expect(dv.getInt16(44 + 3 * 2, true)).toBe(32767); // 2 clamp → max
    expect(dv.getInt16(44 + 4 * 2, true)).toBe(-32768); // -2 clamp → min
  });

  it('空样本 → 只有 44 字节头，data size=0', () => {
    const wav = encodeWavPcm16(new Float32Array([]), 16000);
    expect(wav.length).toBe(44);
    expect(u32(wav, 40)).toBe(0);
  });
});
