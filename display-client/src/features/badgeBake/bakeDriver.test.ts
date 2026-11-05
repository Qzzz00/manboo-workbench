/* 驱动纯函数单测：闭合性（f(0)≡f(T)，证书机制的数学前提）+ 形状约定。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMotion3 } from '../../tools/badgeExport/motionCurves.ts';
import { motionDriverFrom, resolveDriver, sineBadgeF2Driver, wobbleDriver } from './bakeDriver.ts';
import { computeCertificate, CERT_RESIDUAL_EPS } from './bakeCertificate.ts';

// 仓库不带模型了(10-21),闭合性用一条手写的 8 秒循环动作测(首尾值相同、眼参数眨一次)。
const IDLE_FIXTURE = resolve(__dirname, 'fixtures/idle-loop.motion3.json');
const IDLE = parseMotion3(JSON.parse(readFileSync(IDLE_FIXTURE, 'utf8')));

function maxWrapGap(driver: { periodS: number; evalParams: (t: number) => Array<[string, number]>; evalEyes: (t: number) => Array<[string, number]> }) {
  const at = (t: number) => new Map([...driver.evalParams(t), ...driver.evalEyes(t)]);
  const a = at(0);
  const b = at(driver.periodS);
  let worst = 0;
  for (const [id, v] of a) worst = Math.max(worst, Math.abs(v - (b.get(id) ?? Number.NaN)));
  return worst;
}

describe('sineBadgeF2Driver', () => {
  it('周期 2.6s，f(0)≡f(T) 精确闭合', () => {
    const d = sineBadgeF2Driver();
    expect(d.periodS).toBe(2.6);
    expect(maxWrapGap(d)).toBeLessThan(1e-9);
  });
  it('眨眼窗内闭眼、窗外恒睁；耳事件窗外恒 0', () => {
    const d = sineBadgeF2Driver();
    const eyeMid = new Map(d.evalEyes(1.2)).get('ParamEyeLOpen')!;
    expect(eyeMid).toBeLessThan(0.1);
    expect(new Map(d.evalEyes(0.2)).get('ParamEyeLOpen')).toBe(1);
    expect(new Map(d.evalParams(0.1)).get('Param62')).toBe(0);
    expect(Math.abs(new Map(d.evalParams(0.55)).get('Param62')!)).toBeGreaterThan(0.01);
  });
});

describe('motionDriverFrom', () => {
  it('periodS = duration×loopMult；f(0)≡f(T) 闭合（authored 曲线闭合 + 摆动整分频）', () => {
    const d = motionDriverFrom(IDLE, true, 2);
    expect(d.periodS).toBe(16);
    expect(maxWrapGap(d)).toBeLessThan(1e-6);
  });
  it('眼参数只出现在 evalEyes，不混进 evalParams', () => {
    const d = motionDriverFrom(IDLE, true, 2);
    const ids = d.evalParams(3.3).map(([id]) => id);
    expect(ids).not.toContain('ParamEyeLOpen');
    expect(d.evalEyes(0).map(([id]) => id)).toEqual(['ParamEyeLOpen', 'ParamEyeROpen']);
  });
  it('摆动层生效：wobble 开关改变头角度合成值', () => {
    const on = new Map(motionDriverFrom(IDLE, true, 2).evalParams(5)).get('ParamAngleX')!;
    const off = new Map(motionDriverFrom(IDLE, false, 2).evalParams(5)).get('ParamAngleX')!;
    expect(Math.abs(on - off)).toBeGreaterThan(0.5);
  });
});

describe('wobbleDriver 省预算参数（spec 2026-07-10 预算内烘焙）', () => {
  it('ampScale 缩幅度但呼吸 0.5 基线不缩', () => {
    const full = wobbleDriver(8);
    const half = wobbleDriver(8, { ampScale: 0.5 });
    const f = new Map(full.evalParams(1.234));
    const h = new Map(half.evalParams(1.234));
    expect(h.get('ParamAngleX')).toBeCloseTo((f.get('ParamAngleX') ?? 0) * 0.5, 10);
    expect((h.get('ParamBreath') ?? 0) - 0.5).toBeCloseTo(((f.get('ParamBreath') ?? 0.5) - 0.5) * 0.5, 10);
  });
  it('localized 钉躯干与呼吸、保留头三轴与眨眼', () => {
    const d = wobbleDriver(8, { localized: true });
    for (const t of [0.7, 3.1, 6.9]) {
      const m = new Map(d.evalParams(t));
      expect(m.get('ParamBodyAngleX')).toBe(0);
      expect(m.get('ParamBreath')).toBe(0.5);
      expect(Math.abs(m.get('ParamAngleX') ?? 0)).toBeGreaterThan(0);
    }
    expect(d.evalEyes(1.0).length).toBe(2);
  });
  it('扩参后数学闭合性保持：f(0)≡f(T) 逐分量', () => {
    const d = wobbleDriver(8, { ampScale: 0.7, localized: true });
    const a = d.evalParams(0);
    const b = d.evalParams(8);
    for (let i = 0; i < a.length; i += 1) expect(b[i][1]).toBeCloseTo(a[i][1], 9);
  });
});

describe('resolveDriver', () => {
  it('motion 走注入的 fetchJson', async () => {
    const d = await resolveDriver(
      { kind: 'motion', url: '/x/idle.motion3.json', wobble: false, loopMult: 1 },
      async () => JSON.parse(readFileSync(IDLE_FIXTURE, 'utf8')),
    );
    expect(d.periodS).toBe(8);
  });
});

describe('computeCertificate', () => {
  const warmOk = { cycles: 8, residual: 0.003, subharmonic: 0 };
  it('全绿通过', () => {
    const c = computeCertificate([1.0, 1.1, 0.9, 1.2, 1.0], warmOk);
    expect(c.pass).toBe(true);
    expect(c.medianMad).toBe(1.1);   // 上中位（与页面 analyzeLoop 同口径）
  });
  it('残差超标=预警不否决（像素门通过照发，M9/呼吸带两次实证）', () => {
    const c = computeCertificate([1.0, 1.1, 0.9], { ...warmOk, residual: CERT_RESIDUAL_EPS });
    expect(c.pass).toBe(true);
    expect(c.warnings.join()).toContain('未收敛');
  });
  it('亚谐波=预警不否决', () => {
    const c = computeCertificate([1.0, 1.1, 0.9], { ...warmOk, subharmonic: 2 });
    expect(c.pass).toBe(true);
    expect(c.warnings.join()).toContain('亚谐波');
  });
  it('接缝超 1.3×中位拒绝', () => {
    const c = computeCertificate([2.0, 1.0, 1.1, 0.9], warmOk);
    expect(c.pass).toBe(false);
    expect(c.reason).toContain('接缝超标');
  });
  it('回卷等于 1.3×中位恰好放行（边界含）', () => {
    const c = computeCertificate([1.3, 1.0, 1.0, 1.0], warmOk);
    expect(c.pass).toBe(true);
  });
});
