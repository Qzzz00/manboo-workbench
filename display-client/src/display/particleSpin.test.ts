/**
 * 「旋转」这件事本身(2026-09-22,Ben:「把 Live2D 形象换成**旋转的**粒子吧」)。
 *
 * 展示台没给核心加任何新动画:核心自己就有 `spinSpeed`(左右自转),这一份把它钉死——
 * 跑的是真核心(src/swarm/core.js),不画 canvas(SwarmV4 只算位置,不碰 DOM),
 * 所以在 node 环境里就能验:球到底转不转、转多快由谁决定。
 *
 * 为什么值得有这一条:屏幕截图只能证明「球画出来了」,证明不了「它在转」;
 * 而「转」正是 Ben 这次唯一明确要的那件事。
 */
import { describe, expect, it } from 'vitest';
import { SwarmV4, TUNING_DEFAULTS } from '../swarm/core.js';
import { withStageSpin } from './displayStage';

/**
 * `core.d.ts` 是生成物、与 Mac / 手机两端逐字相同(swarmSource.test.ts 守着),
 * 不为一条测试去改它 —— 它没声明 `count` / `angles` 这两个内部字段,所以在这里就地收窄。
 */
type SwarmInternals = SwarmV4 & { count: number; angles: Float32Array };

/** 跑 seconds 秒(按 60 帧/秒喂),回平均转过的角度(弧度,取绝对值)。 */
function spinAfter(spinSpeed: number, mode: string, seconds = 1): number {
  const swarm = new SwarmV4(300) as SwarmInternals;
  swarm.configure({ ...TUNING_DEFAULTS, count: 300, spinSpeed });
  swarm.setMode(mode);
  // 先 snap 一次:把弹簧直接拨到目标值,免得测到的是「从上一档滑过来」的那段过渡。
  swarm.step(0, true);
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds * 60); i++) swarm.step(dt, false);
  let sum = 0;
  for (let i = 0; i < swarm.count; i++) sum += Math.abs(swarm.angles[i]!);
  return sum / swarm.count;
}

describe('粒子球在转', () => {
  it('★待命态 + 默认参数:一秒之内确实转过了一个角度', () => {
    expect(spinAfter(TUNING_DEFAULTS.spinSpeed!, 'idle')).toBeGreaterThan(0.15);
  });

  it('★转多快由 spinSpeed 决定:调大一档,转过的角度跟着大致成比例', () => {
    const slow = spinAfter(0.2, 'idle');
    const fast = spinAfter(0.8, 'idle');
    expect(fast).toBeGreaterThan(slow * 3);
    expect(fast).toBeLessThan(slow * 5);
  });

  it('负数是反向转,转的幅度一样(所以展示台不把负数当「不转」)', () => {
    expect(spinAfter(-0.4, 'idle')).toBeCloseTo(spinAfter(0.4, 'idle'), 2);
  });

  it('spinSpeed = 0 就真的不转 —— 这正是 withStageSpin 要兜的那种情况', () => {
    expect(spinAfter(0, 'idle')).toBe(0);
    // 展示台不会把 0 原样交给核心:兜底那一档保证屏幕上还是「转着的球」。
    const settings = withStageSpin({ ...TUNING_DEFAULTS, spinSpeed: 0 });
    expect(spinAfter(settings.spinSpeed!, 'idle')).toBeGreaterThan(0.08);
  });

  it('在办态不自转(核心的规矩:只有 idle 吃 spinSpeed)——所以「有事等你」才映射回 idle', () => {
    expect(spinAfter(0.35, 'working')).toBe(0);
  });
});
