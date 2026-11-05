import { describe, expect, it } from 'vitest';
import { envelopeFromPcm, envelopeLevelAt, smoothMouthLevel } from './mouthSync';

/** 造一段正弦，振幅由 amp 决定；用来当"有声"的帧。 */
function tone(sampleRate: number, ms: number, amp: number): Float32Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  return out;
}

describe('envelopeFromPcm（口播改原生播放后的离线包络）', () => {
  it('静音段电平为 0——嘴要闭上，不能一直张着', () => {
    const env = envelopeFromPcm(new Float32Array(4800), 48000);

    expect([...env].every((v) => v === 0)).toBe(true);
  });

  it('有声段给出正电平，且响的比轻的开得大', () => {
    const quiet = envelopeFromPcm(tone(48000, 200, 0.05), 48000);
    const loud = envelopeFromPcm(tone(48000, 200, 0.5), 48000);

    expect(loud[2]).toBeGreaterThan(quiet[2]);
    expect(loud[2]).toBeGreaterThan(0);
  });

  it('★归一化形状与 analyzeAudioLevel 一致：低于阈值归零、上限截到 1', () => {
    const veryQuiet = envelopeFromPcm(tone(48000, 200, 0.001), 48000);
    const veryLoud = envelopeFromPcm(tone(48000, 200, 1), 48000);

    expect(veryQuiet[2]).toBe(0);
    expect(veryLoud[2]).toBe(1);
  });

  it('帧长按采样率换算，不同采样率下同样时长的帧数一致', () => {
    const a = envelopeFromPcm(tone(48000, 500, 0.3), 48000);
    const b = envelopeFromPcm(tone(24000, 500, 0.3), 24000);

    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
  });
});

describe('envelopeLevelAt', () => {
  it('按播放进度取到对应帧', () => {
    const env = Float32Array.from([0, 0.5, 1, 0.25]);

    expect(envelopeLevelAt(env, 0)).toBe(0);
    expect(envelopeLevelAt(env, 25)).toBe(0.5);
    expect(envelopeLevelAt(env, 50)).toBe(1);
  });

  it('★播完（越界）返回 0，嘴必须闭上——否则口播结束角色还张着嘴', () => {
    const env = Float32Array.from([1, 1]);

    expect(envelopeLevelAt(env, 10_000)).toBe(0);
    expect(envelopeLevelAt(env, -5)).toBe(0);
  });

  it('接得住 smoothMouthLevel：平滑后仍在 0..1', () => {
    const env = Float32Array.from([0, 1, 0]);
    let level = 0;
    for (const ms of [0, 25, 50]) level = smoothMouthLevel(level, envelopeLevelAt(env, ms));

    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(1);
  });
});
