import { describe, it, expect } from 'vitest';
import { HUM_TUNES, humProfileFor, pickHumTune } from './humTunes.ts';
import { validateScore, scoreDurationSec } from './score.ts';

describe('HUM_TUNES', () => {
  it('每首都是合法乐谱', () => {
    expect(HUM_TUNES.length).toBeGreaterThanOrEqual(3);
    HUM_TUNES.forEach((t) => expect(validateScore(t)).toEqual([]));
  });
  it('id 不重复', () => {
    expect(new Set(HUM_TUNES.map((t) => t.id)).size).toBe(HUM_TUNES.length);
  });
  it('时长都在 8–25 秒之间（待机哼唱是「一小段」，不是整首）', () => {
    HUM_TUNES.forEach((t) => {
      const d = scoreDurationSec(t);
      expect(d).toBeGreaterThanOrEqual(8);
      expect(d).toBeLessThanOrEqual(25);
    });
  });
});

describe('humProfileFor', () => {
  it('未知角色回落默认档案', () => {
    expect(humProfileFor('nobody').formantScale).toBe(1);
  });
  it('★不同角色靠 formantScale 区分体型感，而不是只靠 transpose', () => {
    const scales = new Set(['yumi', 'ellen', 'huohuo'].map((id) => humProfileFor(id).formantScale));
    expect(scales.size).toBeGreaterThan(1);
  });
});

describe('pickHumTune', () => {
  it('rng 决定选哪首，且落在曲目表内', () => {
    expect(pickHumTune(() => 0).id).toBe(HUM_TUNES[0].id);
    expect(pickHumTune(() => 0.999).id).toBe(HUM_TUNES[HUM_TUNES.length - 1].id);
  });
});
