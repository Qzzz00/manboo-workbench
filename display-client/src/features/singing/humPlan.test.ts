import { describe, it, expect } from 'vitest';
import { buildHumPlan, DEFAULT_HUM_PROFILE, PLAN_STEP_SEC } from './humPlan.ts';
import { midiToHz, type Score } from './score.ts';

// bpm=60 → 1 拍 = 1 秒，测试里所有时刻都能心算。
const C_THEN_G: Score = {
  id: 't', title: 't', bpm: 60,
  notes: [{ pitch: 60, beats: 1 }, { pitch: 67, beats: 1 }],
};
const WITH_REST: Score = {
  id: 'r', title: 'r', bpm: 60,
  notes: [{ pitch: 60, beats: 1 }, { pitch: null, beats: 1 }, { pitch: 60, beats: 1 }],
};
/** 固定 rng，让 Task 3 的微扰在本任务阶段也是确定值。 */
const FIXED_RNG = () => 0.5;
/** 取 t 秒处的采样下标。 */
const at = (t: number) => Math.round(t / PLAN_STEP_SEC);

describe('buildHumPlan 基础曲线', () => {
  it('时长 = 总拍数 × 60/bpm', () => {
    expect(buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG).durationSec).toBeCloseTo(2, 6);
  });

  it('音符稳态段的基频中心就是该音符的频率（颤音围绕它波动，取一个颤音周期的均值）', () => {
    const p = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    // Task 3 起，长音带 5.5Hz 颤音，单点采样会落在波峰/波谷上而偏离中心；
    // 取整一个颤音周期(1/5.5≈0.182s)的均值，测的仍是「音高映射对不对」这件事。
    const meanOver = (fromSec: number) => {
      const seg = p.f0.slice(at(fromSec), at(fromSec + 1 / DEFAULT_HUM_PROFILE.vibratoHz));
      return seg.reduce((sum, v) => sum + v, 0) / seg.length;
    };
    expect(meanOver(0.4)).toBeCloseTo(midiToHz(60), 0);
    expect(meanOver(1.4)).toBeCloseTo(midiToHz(67), 0);
  });

  it('transpose +12 让整首高八度', () => {
    const base = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    const up = buildHumPlan(C_THEN_G, { ...DEFAULT_HUM_PROFILE, transpose: 12 }, FIXED_RNG);
    expect(up.f0[at(0.5)]).toBeCloseTo(base.f0[at(0.5)] * 2, 0);
  });

  it('休止符：增益为 0，但基频保持前一个值（0Hz 会让振荡器/带通跳变出爆音）', () => {
    const p = buildHumPlan(WITH_REST, DEFAULT_HUM_PROFILE, FIXED_RNG);
    expect(p.gain[at(1.5)]).toBe(0);
    expect(p.f0[at(1.5)]).toBeGreaterThan(0);
  });

  it('增益包络：起点为 0，稳态为 1，收尾回落', () => {
    const p = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    expect(p.gain[0]).toBe(0);
    expect(p.gain[at(0.5)]).toBeCloseTo(1, 3);
    expect(p.gain[at(0.98)]).toBeLessThan(0.5);
  });

  it('formants 是 3 个常数，受 formantScale 缩放（★体型感靠它，不靠 transpose）', () => {
    const p = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    expect(p.formants).toEqual([280, 1150, 2400]);
    const small = buildHumPlan(C_THEN_G, { ...DEFAULT_HUM_PROFILE, formantScale: 1.2 }, FIXED_RNG);
    expect(small.formants[0]).toBeCloseTo(336, 6);
    // 移调不该动共振峰
    const up = buildHumPlan(C_THEN_G, { ...DEFAULT_HUM_PROFILE, transpose: 12 }, FIXED_RNG);
    expect(up.formants).toEqual([280, 1150, 2400]);
  });

  it('beats 给出每一拍的时刻，供摇摆演出用', () => {
    const p = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    expect(p.beats).toEqual([0, 1]);
  });

  it('曲线长度覆盖整首，且 stepSec 一致', () => {
    const p = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    expect(p.stepSec).toBe(PLAN_STEP_SEC);
    expect(p.f0.length).toBe(p.gain.length);
    expect((p.f0.length - 1) * PLAN_STEP_SEC).toBeGreaterThanOrEqual(p.durationSec - 1e-9);
  });

  it('★护栏：rng 调用次数 = 音符数（不能在采样循环里抽，否则依赖步长、不可复现）', () => {
    let calls = 0;
    buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, () => { calls += 1; return 0.5; });
    expect(calls).toBe(C_THEN_G.notes.length);
  });
});

describe('buildHumPlan 人味四刀', () => {
  it('滑音：相邻不同音高之间不跳变，交界处是中间值', () => {
    const p = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    // 第二个音符起点 1.0s，滑音窗 40ms，取 1.02s（窗中点）
    const mid = p.f0[at(1.02)];
    expect(mid).toBeGreaterThan(midiToHz(60));
    expect(mid).toBeLessThan(midiToHz(67));
  });

  it('起音上滑：乐句首音从下方约 40 音分够上去', () => {
    const p = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, FIXED_RNG);
    const target = midiToHz(60);
    expect(p.f0[0]).toBeLessThan(target * 0.99);
    expect(p.f0[0]).toBeGreaterThan(target * 0.96);
  });

  it('颤音只出现在长音：长音稳态段有周期性起伏，短音是平的', () => {
    const long: Score = { id: 'l', title: 'l', bpm: 60, notes: [{ pitch: 60, beats: 2 }] };
    const short: Score = { id: 's', title: 's', bpm: 60, notes: [{ pitch: 60, beats: 0.3 }] };
    const spread = (a: number[]) => Math.max(...a) - Math.min(...a);

    const pl = buildHumPlan(long, DEFAULT_HUM_PROFILE, FIXED_RNG);
    // 取 0.4~1.8s 的稳态段（已过 0.15s 颤音延迟）
    expect(spread(pl.f0.slice(at(0.4), at(1.8)))).toBeGreaterThan(2);

    const ps = buildHumPlan(short, DEFAULT_HUM_PROFILE, FIXED_RNG);
    // 0.3s 短音不该有颤音；取 0.1~0.2s 段（已过起音上滑窗 0.08s）
    expect(spread(ps.f0.slice(at(0.1), at(0.2)))).toBeLessThan(0.5);
  });

  it('rng 注入可复现：同种子结果全等，不同种子音准有差异', () => {
    const seeded = (seed: number) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
    const a = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, seeded(1));
    const b = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, seeded(1));
    const c = buildHumPlan(C_THEN_G, DEFAULT_HUM_PROFILE, seeded(999));
    expect(a.f0).toEqual(b.f0);
    expect(a.f0[at(0.5)]).not.toBeCloseTo(c.f0[at(0.5)], 6);
  });

  it('呼吸：≥0.5 拍的休止符产生一个呼吸时刻，短休止不产生', () => {
    const longRest = buildHumPlan(WITH_REST, DEFAULT_HUM_PROFILE, FIXED_RNG);
    expect(longRest.breaths.length).toBe(1);
    expect(longRest.breaths[0]).toBeGreaterThanOrEqual(1);
    expect(longRest.breaths[0]).toBeLessThan(2);

    const shortRest: Score = {
      id: 'sr', title: 'sr', bpm: 60,
      notes: [{ pitch: 60, beats: 1 }, { pitch: null, beats: 0.25 }, { pitch: 60, beats: 1 }],
    };
    expect(buildHumPlan(shortRest, DEFAULT_HUM_PROFILE, FIXED_RNG).breaths).toEqual([]);
  });
});
