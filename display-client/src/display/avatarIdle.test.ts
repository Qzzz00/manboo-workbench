/**
 * 展示台 Live2D 形象的待机动作调度(2026-10-01,维护者:「可别现在做完是一堆贴图啊,碧蓝航线的应该有很多动作,
 * 可以随机播放,那 4 个之前让写了动作的,但是可能比较呆板,你可以再丰富看看」)。
 */
import { describe, expect, it } from 'vitest';
import { azurIdlePlan, beatDelayMs, nextBeat } from './avatarIdle';

describe('碧蓝那批:按文件名分「待机循环」与「随机插播」', () => {
  const files = [
    'motions/idle.motion3.json', 'motions/idle1.motion3.json', 'motions/main_1.motion3.json', 'motions/main_2.motion3.json',
    'motions/home.motion3.json', 'motions/login.motion3.json', 'motions/mail.motion3.json', 'motions/mission.motion3.json',
    'motions/mission_complete.motion3.json', 'motions/complete.motion3.json',
    'motions/wedding.motion3.json', 'motions/effect.motion3.json', 'motions/touch_head.motion3.json', 'motions/touch_special.motion3.json',
    'motions/touch_idle1.motion3.json',
  ];
  it('★idle* 是循环;主界面 / 来信 / 任务这几段随机插播', () => {
    const plan = azurIdlePlan(files);
    expect(plan.loop).toEqual(['motions/idle.motion3.json', 'motions/idle1.motion3.json']);
    expect(plan.beats).toEqual([
      'motions/main_1.motion3.json', 'motions/main_2.motion3.json',
      'motions/mail.motion3.json', 'motions/mission.motion3.json', 'motions/mission_complete.motion3.json', 'motions/complete.motion3.json',
    ]);
  });
  it('★「回港」「登录」是运镜(镜头飞到无人机视角、黑边、HUD),不是角色动作 —— 一律不播(10-01 8 个角色逐段按画面筛过)', () => {
    const plan = azurIdlePlan(files);
    expect([...plan.loop, ...plan.beats].join(' ')).not.toMatch(/home|login/);
  });
  it('个别角色另外筛出来的运镜段(按画面差异)也排除,循环里也排除', () => {
    const plan = azurIdlePlan([...files, 'motions/idle2.motion3.json'], ['motions/idle1.motion3.json', 'motions/mission.motion3.json']);
    expect(plan.loop).toEqual(['motions/idle.motion3.json', 'motions/idle2.motion3.json']);
    expect(plan.beats).not.toContain('motions/mission.motion3.json');
  });
  it('★婚礼、特效、各种触摸反应不进随机(那是点到角色身上才有的反应,没人点的屏上自己冒出来不对)', () => {
    const all = [...azurIdlePlan(files).loop, ...azurIdlePlan(files).beats].join(' ');
    expect(all).not.toMatch(/wedding|effect|touch_/);
  });
  it('★台词段(主界面 / 登录这类原本配语音的)播的时候把嘴压住 —— 没声音还对口型像在默念', () => {
    expect(azurIdlePlan(files).muteMouth).toBe(true);
  });
  it('一条 idle 都没有时,拿第一条插播当循环(屏上不能定住不动)', () => {
    const plan = azurIdlePlan(['motions/home.motion3.json', 'motions/main_1.motion3.json']);
    expect(plan.loop).toEqual(['motions/main_1.motion3.json']);
  });
});

describe('随机插播', () => {
  const beats = ['a', 'b', 'c'];
  it('★不连着播同一条', () => {
    for (const r of [0, 0.2, 0.5, 0.99]) expect(nextBeat(beats, 'a', () => r)).not.toBe('a');
  });
  it('只有一条时就是它;没有就是 null', () => {
    expect(nextBeat(['a'], 'a', () => 0.5)).toBe('a');
    expect(nextBeat([], null, () => 0.5)).toBeNull();
  });
  it('两次插播之间隔 12–30 秒(随机),一屏不会一直手舞足蹈', () => {
    expect(beatDelayMs(() => 0)).toBe(12_000);
    expect(beatDelayMs(() => 0.999999)).toBeLessThanOrEqual(30_000);
    expect(beatDelayMs(() => 0.5)).toBe(21_000);
  });
});
