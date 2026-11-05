import { describe, it, expect } from 'vitest';
import { centsToRatio, midiToHz, scoreDurationSec, validateScore, type Score } from './score.ts';

const TWINKLE: Score = {
  id: 'twinkle', title: '小星星', bpm: 96,
  notes: [
    { pitch: 60, beats: 1 }, { pitch: 60, beats: 1 },
    { pitch: 67, beats: 1 }, { pitch: 67, beats: 1 },
    { pitch: 69, beats: 1 }, { pitch: 69, beats: 1 },
    { pitch: 67, beats: 2 }, { pitch: null, beats: 1 },
  ],
};

describe('midiToHz', () => {
  it('A4(69) = 440Hz，中央C(60) ≈ 261.63Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
  });
  it('高八度=频率翻倍', () => {
    expect(midiToHz(72)).toBeCloseTo(midiToHz(60) * 2, 6);
  });
});

describe('centsToRatio', () => {
  it('1200 音分=一个八度=2 倍', () => {
    expect(centsToRatio(1200)).toBeCloseTo(2, 9);
    expect(centsToRatio(0)).toBe(1);
    expect(centsToRatio(-1200)).toBeCloseTo(0.5, 9);
  });
});

describe('scoreDurationSec', () => {
  it('总时长 = 总拍数 × 60/bpm（休止符也占时长）', () => {
    // 9 拍 @ 96bpm = 9 * 0.625 = 5.625s
    expect(scoreDurationSec(TWINKLE)).toBeCloseTo(5.625, 6);
  });
});

describe('validateScore', () => {
  it('合法乐谱返回空数组', () => {
    expect(validateScore(TWINKLE)).toEqual([]);
  });
  it('bpm ≤ 0 报错', () => {
    expect(validateScore({ ...TWINKLE, bpm: 0 }).join()).toMatch(/bpm/);
  });
  it('notes 为空报错', () => {
    expect(validateScore({ ...TWINKLE, notes: [] }).join()).toMatch(/notes/);
  });
  it('beats ≤ 0 报错并指出下标', () => {
    const bad = { ...TWINKLE, notes: [{ pitch: 60, beats: 0 }] };
    expect(validateScore(bad).join()).toMatch(/notes\[0\]\.beats/);
  });
  it('pitch 越界报错，但 null（休止）合法', () => {
    expect(validateScore({ ...TWINKLE, notes: [{ pitch: 12, beats: 1 }] }).join()).toMatch(/notes\[0\]\.pitch/);
    expect(validateScore({ ...TWINKLE, notes: [{ pitch: null, beats: 1 }] })).toEqual([]);
  });
});
