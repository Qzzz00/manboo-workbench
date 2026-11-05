import { describe, expect, it } from 'vitest';
import { createRingtone, pickRingtoneSource, ringSchedule } from './ringtone';

describe('pickRingtoneSource（选择播放源，纯函数）', () => {
  it('有 URL 选 audio 源', () => {
    expect(pickRingtoneSource('https://cdn/r.mp3')).toBe('audio');
  });

  it('无 URL（undefined/空串/纯空白）选合成源', () => {
    expect(pickRingtoneSource(undefined)).toBe('synth');
    expect(pickRingtoneSource('')).toBe('synth');
    expect(pickRingtoneSource('   ')).toBe('synth');
  });
});

describe('ringSchedule（铃声节拍编排，纯函数）', () => {
  it('默认一个周期（1.2s）内产出两拍：叮(880Hz)在0ms，咚(659Hz)在0.35s后', () => {
    const beats = ringSchedule();
    expect(beats).toEqual([
      { freq: 880, atMs: 0, durMs: 350 },
      { freq: 659, atMs: 350, durMs: 350 },
    ]);
  });

  it('传入 cycleMs 会按周期重复排出多轮节拍', () => {
    const beats = ringSchedule(2400);
    expect(beats).toEqual([
      { freq: 880, atMs: 0, durMs: 350 },
      { freq: 659, atMs: 350, durMs: 350 },
      { freq: 880, atMs: 1200, durMs: 350 },
      { freq: 659, atMs: 1550, durMs: 350 },
    ]);
  });

  it('cycleMs 小于单轮两拍所需时长时，仍只排出能完整放入的整轮节拍', () => {
    const beats = ringSchedule(500);
    expect(beats).toEqual([{ freq: 880, atMs: 0, durMs: 350 }]);
  });
});

describe('createRingtone（WebAudio 程序化铃声，无音频资产）', () => {
  it('无 AudioContext 环境下 start() 安全 no-op，不抛错', () => {
    expect(typeof globalThis.AudioContext).toBe('undefined');
    const ringtone = createRingtone();
    expect(() => ringtone.start()).not.toThrow();
  });

  it('无 AudioContext 环境下 stop() 也安全 no-op，不抛错（含未 start 直接 stop）', () => {
    const ringtone = createRingtone();
    expect(() => ringtone.stop()).not.toThrow();
    ringtone.start();
    expect(() => ringtone.stop()).not.toThrow();
  });
});
