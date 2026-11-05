import { describe, it, expect } from 'vitest';
import {
  swayOverridesFor, shouldEmitSwayFrame, mergeStageOverrides,
  SWAY_HEAD_DEG, SWAY_BODY_DEG, SMILE_FORM,
} from './humSway.ts';
import { MOUTH_PARAM_IDS } from '../live2d/mouthParams.ts';
import type { ParameterOverride } from '../live2d/types.ts';

describe('swayOverridesFor', () => {
  it('★生死线：绝不输出 ParamMouthOpenY（哼鸣是闭口鼻音，嘴不该开合）', () => {
    [0, 0.1, 0.25, 0.37, 0.5, 0.75, 0.999].forEach((phase) => {
      expect(swayOverridesFor(phase).map((o) => o.id)).not.toContain('ParamMouthOpenY');
    });
  });

  it('只输出 ParamAngleZ / ParamBodyAngleZ / ParamMouthForm 三项，不多不少', () => {
    const ids = swayOverridesFor(0.37).map((o) => o.id).sort();
    expect(ids).toEqual(['ParamAngleZ', 'ParamBodyAngleZ', 'ParamMouthForm'].sort());
  });

  it('头/身摇摆随拍相位正弦变化，峰值等于配置幅度', () => {
    const atQuarter = swayOverridesFor(0.25); // sin(0.25 * 2π) = sin(π/2) = 1
    expect(atQuarter.find((o) => o.id === 'ParamAngleZ')?.value).toBeCloseTo(SWAY_HEAD_DEG);
    expect(atQuarter.find((o) => o.id === 'ParamBodyAngleZ')?.value).toBeCloseTo(SWAY_BODY_DEG);

    const atThreeQuarters = swayOverridesFor(0.75); // sin(3π/2) = -1
    expect(atThreeQuarters.find((o) => o.id === 'ParamAngleZ')?.value).toBeCloseTo(-SWAY_HEAD_DEG);
    expect(atThreeQuarters.find((o) => o.id === 'ParamBodyAngleZ')?.value).toBeCloseTo(-SWAY_BODY_DEG);

    const atZero = swayOverridesFor(0); // sin(0) = 0
    expect(atZero.find((o) => o.id === 'ParamAngleZ')?.value).toBeCloseTo(0);
  });

  it('嘴角上扬是恒定值，不随拍相位变化', () => {
    expect(swayOverridesFor(0).find((o) => o.id === 'ParamMouthForm')?.value).toBe(SMILE_FORM);
    expect(swayOverridesFor(0.9).find((o) => o.id === 'ParamMouthForm')?.value).toBe(SMILE_FORM);
  });
});

describe('shouldEmitSwayFrame', () => {
  it('首帧（lastEmitSec=null，还没发过）总是放行', () => {
    expect(shouldEmitSwayFrame(null, 0)).toBe(true);
    expect(shouldEmitSwayFrame(null, 5)).toBe(true);
  });

  it('距上次发送不足节流间隔时不放行', () => {
    expect(shouldEmitSwayFrame(1.0, 1.02, 0.0625)).toBe(false);
  });

  it('距上次发送恰好达到节流间隔时放行', () => {
    expect(shouldEmitSwayFrame(1.0, 1.0625, 0.0625)).toBe(true);
  });

  it('距上次发送已超过节流间隔时放行', () => {
    expect(shouldEmitSwayFrame(1.0, 2.0, 0.0625)).toBe(true);
  });
});

describe('mergeStageOverrides', () => {
  const base: ParameterOverride[] = [
    { id: 'ParamAngleX', value: 7 },
    { id: 'ParamAngleZ', value: 20 },
    { id: 'ParamMouthOpenY', value: 0.8 },
    { id: 'ParamMouthForm', value: -0.5 },
  ];
  const sway = swayOverridesFor(0.25);

  it('★生死线延长段：口型同步激活时，输出里一个嘴部参数都没有（哼唱中也一样）', () => {
    [true, false].forEach((humming) => {
      const out = mergeStageOverrides(base, humming ? sway : [], true);
      const ids = out.map((o) => o.id);
      MOUTH_PARAM_IDS.forEach((mouthId) => expect(ids).not.toContain(mouthId));
    });
  });

  it('★口型同步激活时不能只筛 base 不筛 sway——sway 的 ParamMouthForm 也必须被裁掉', () => {
    // 这条正是实施过程中真断过的那次：先筛 base 再 append sway，等于把刚筛掉的嘴带回来。
    expect(sway.map((o) => o.id)).toContain('ParamMouthForm'); // 前提成立才有意义
    expect(mergeStageOverrides(base, sway, true).map((o) => o.id)).not.toContain('ParamMouthForm');
  });

  it('★快路引用保持：没在哼且没在同步口型时，原样返回 base 这个数组引用', () => {
    // Live2DStage 的 parameterOverrides effect 按引用相等判定是否重跑（Live2DStage.tsx:401）。
    // 这里返回新数组的话，原生桥会在每次渲染重推一遍参数。
    expect(mergeStageOverrides(base, [], false)).toBe(base);
  });

  it('哼唱中：sway 覆盖 base 的同名参数，sway 值胜出且只出现一次', () => {
    const out = mergeStageOverrides(base, sway, false);
    const angleZ = out.filter((o) => o.id === 'ParamAngleZ');
    expect(angleZ).toHaveLength(1);
    expect(angleZ[0].value).toBeCloseTo(SWAY_HEAD_DEG); // base 的 20 被顶掉
  });

  it('哼唱中：base 里与 sway 不冲突的参数原样保留，sway 三项全部到场', () => {
    const out = mergeStageOverrides(base, sway, false);
    expect(out.find((o) => o.id === 'ParamAngleX')?.value).toBe(7);
    ['ParamAngleZ', 'ParamBodyAngleZ', 'ParamMouthForm'].forEach((id) => {
      expect(out.map((o) => o.id)).toContain(id);
    });
    expect(out.find((o) => o.id === 'ParamBodyAngleZ')?.value).toBeCloseTo(SWAY_BODY_DEG);
    expect(out.find((o) => o.id === 'ParamMouthForm')?.value).toBe(SMILE_FORM);
  });

  it('哼唱中：绝不引入 ParamMouthOpenY（sway 不产它，base 的值也不被改写）', () => {
    const out = mergeStageOverrides(base, sway, false);
    expect(out.find((o) => o.id === 'ParamMouthOpenY')?.value).toBe(0.8); // 来自 base，非哼唱所加
    expect(sway.map((o) => o.id)).not.toContain('ParamMouthOpenY');
  });

  it('不修改传入的 base 数组（memo 的输入必须保持不变）', () => {
    const snapshot = base.map((o) => ({ ...o }));
    mergeStageOverrides(base, sway, true);
    expect(base).toEqual(snapshot);
  });
});
