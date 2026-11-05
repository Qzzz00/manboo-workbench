/* badgeCatalog：动作全枚举（闭合/Loop 标志/网格重映射）与表情 pins 折算的行为契约。 */
import { describe, expect, it } from 'vitest';
import { buildMotionDriver, probeLoopMotions, resolveExpressionPins, type LoopMotionOption } from './badgeCatalog.ts';
import type { AvatarExpression } from '../features/live2d/types.ts';

/** 造一个常量+首尾闭合的 motion3：单参数线性段 v0 → v0（时长 duration）。 */
function closedMotion(duration: number, id = 'ParamAngleX', v0 = 0, loop: boolean | undefined = true) {
  return {
    Version: 3,
    Meta: { Duration: duration, Fps: 30, Loop: loop },
    Curves: [
      { Target: 'Parameter', Id: id, Segments: [0, v0, 0, duration, v0] },
    ],
  };
}

/** 首尾不闭合的 motion3（0 → 1）。 */
function openMotion(duration: number) {
  return {
    Version: 3,
    Meta: { Duration: duration, Fps: 30, Loop: true },
    Curves: [
      { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, duration, 1] },
    ],
  };
}

function fetcher(map: Record<string, unknown>) {
  return async (url: string) => {
    if (!(url in map)) throw new Error(`404 ${url}`);
    return map[url];
  };
}

describe('probeLoopMotions', () => {
  const manifest = {
    modelJson: '/m/model.model3.json',
    motions: {
      idle: { file: '/m/idle.motion3.json' },
      wave: { file: '/m/wave.motion3.json' },        // 不闭合 → 排除
      pout: { file: '/m/pout.motion3.json' },        // Loop=false → 排除
      nod: { file: '/m/nod.motion3.json' },          // 5.47s 差网格 → 重映射保留
      weird: { file: '/m/weird.motion3.json' },      // 0.71s→0.7 网格差 1.4%…在 2% 内保留
    },
  };
  const files: Record<string, unknown> = {
    '/m/model.model3.json': { FileReferences: { Motions: { '': [{ File: 'scene.motion3.json' }] } } },
    '/m/idle.motion3.json': closedMotion(8),
    '/m/wave.motion3.json': openMotion(4),
    '/m/pout.motion3.json': closedMotion(3, 'ParamAngleX', 0, false),
    '/m/nod.motion3.json': closedMotion(5.47),
    '/m/weird.motion3.json': closedMotion(0.71),
    '/m/scene.motion3.json': closedMotion(2),
  };

  it('枚举 manifest∪model3，闭合+Loop 才上架，差网格按重映射保留', async () => {
    const out = await probeLoopMotions(manifest, 10, fetcher(files));
    const keys = out.map((o) => o.key).sort();
    expect(keys).toEqual(['idle', 'nod', 'scene', 'weird']);
    const nod = out.find((o) => o.key === 'nod')!;
    expect(nod.durationS).toBeCloseTo(5.47, 9);
    expect(nod.gridPeriodS).toBeCloseTo(5.5, 9);
    const idle = out.find((o) => o.key === 'idle')!;
    expect(idle.gridPeriodS).toBe(idle.durationS);
  });

  it('重映射偏差超 2% 的奇异时长放弃', async () => {
    const out = await probeLoopMotions(
      { motions: { odd: { file: '/m/odd.motion3.json' } } },
      10,
      fetcher({ '/m/odd.motion3.json': closedMotion(0.74) }),   // →0.7，偏 5.4%
    );
    expect(out).toEqual([]);
  });
});

describe('buildMotionDriver', () => {
  it('正网格给 motion 驱动并钉呼吸', async () => {
    const opt: LoopMotionOption = { key: 'idle', url: '/m/idle.motion3.json', durationS: 8, gridPeriodS: 8 };
    const driver = await buildMotionDriver(opt, fetcher({ '/m/idle.motion3.json': closedMotion(8) }));
    expect(driver).toMatchObject({ kind: 'motion', url: '/m/idle.motion3.json', paramBand: { ParamBreath: { center: 0.5, scale: 0 } } });
  });

  it('差网格给 custom 重映射驱动：周期=网格值、闭合保持、呼吸钉住、眼走 evalEyes', async () => {
    const motion = {
      Version: 3,
      Meta: { Duration: 5.47, Fps: 30, Loop: true },
      Curves: [
        { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 2, 0, 5.47, 2] },
        { Target: 'Parameter', Id: 'ParamBreath', Segments: [0, 0.9, 0, 5.47, 0.9] },
        { Target: 'Parameter', Id: 'ParamEyeLOpen', Segments: [0, 1, 0, 5.47, 1] },
      ],
    };
    const opt: LoopMotionOption = { key: 'nod', url: '/m/nod.motion3.json', durationS: 5.47, gridPeriodS: 5.5 };
    const driver = await buildMotionDriver(opt, fetcher({ '/m/nod.motion3.json': motion }));
    if (driver.kind !== 'custom') throw new Error('应为 custom 驱动');
    expect(driver.periodS).toBeCloseTo(5.5, 9);
    const p0 = new Map(driver.evalParams(0));
    const pT = new Map(driver.evalParams(5.5));
    expect(p0.get('ParamAngleX')).toBeCloseTo(pT.get('ParamAngleX')!, 6);   // 数学闭环
    expect(p0.get('ParamBreath')).toBeCloseTo(0.5, 9);                       // 呼吸钉半开
    expect(p0.has('ParamEyeLOpen')).toBe(false);                             // 眼不走 params
    expect(new Map(driver.evalEyes(0)).get('ParamEyeLOpen')).toBeCloseTo(1, 9);
  });
});

describe('resolveExpressionPins', () => {
  const expr = (id: string, binding: AvatarExpression['binding']): AvatarExpression => ({
    id, label: id, kind: 'prop', prompt: '', binding,
  });
  const baseline = new Map([['P.Hair', 0], ['P.Scale', 2], ['P.Ear', 0.5]]);

  it('Add/Multiply/Overwrite 按基线折算；preset 视为覆盖；后选覆盖先选', async () => {
    const expressions = [
      expr('hair2', { mode: 'file', file: '/e/hair2.exp3.json' }),
      expr('bigger', { mode: 'file', file: '/e/bigger.exp3.json' }),
      expr('flat', { mode: 'preset', params: { 'P.Ear': 1 } }),
    ];
    const files = {
      '/e/hair2.exp3.json': { Parameters: [
        { Id: 'P.Hair', Value: 1, Blend: 'Add' },
        { Id: 'P.Ear', Value: 0.2 },                          // 缺省 Blend=Add
      ] },
      '/e/bigger.exp3.json': { Parameters: [
        { Id: 'P.Scale', Value: 1.5, Blend: 'Multiply' },
        { Id: 'P.Hair', Value: 9, Blend: 'Overwrite' },
      ] },
    };
    const pins = new Map(await resolveExpressionPins(baseline, expressions, ['hair2', 'bigger', 'flat'], fetcher(files)));
    expect(pins.get('P.Hair')).toBe(9);          // Add(0+1)=1 后被 Overwrite 9
    expect(pins.get('P.Scale')).toBe(3);         // 2×1.5
    expect(pins.get('P.Ear')).toBe(1);           // Add(0.5+0.2)=0.7 后被 preset 覆盖 1
  });

  it('未选中/未知 id 不产生 pins', async () => {
    const pins = await resolveExpressionPins(baseline, [], ['nope'], fetcher({}));
    expect(pins).toEqual([]);
  });

  it('dev 的 /public/ 前缀路径解析失败时剥前缀重试', async () => {
    const expressions = [expr('hair2', { mode: 'file', file: '/public/e/hair2.exp3.json' })];
    const files = { '/e/hair2.exp3.json': { Parameters: [{ Id: 'P.Hair', Value: 1, Blend: 'Add' }] } };
    const pins = new Map(await resolveExpressionPins(baseline, expressions, ['hair2'], fetcher(files)));
    expect(pins.get('P.Hair')).toBe(1);
  });
});
