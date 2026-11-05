import { describe, expect, test } from 'vitest';
import { tiltToFocus, lowPass, createShakeDetector, accelToTiltAngles, createGravityEstimator, createTiltGate } from './deviceTilt.ts';

describe('tiltToFocus', () => {
  test('在死区内返回中位 {0,0}', () => {
    // 默认死区 5°：小倾角不动，避免手抖驱动视线。
    expect(tiltToFocus(0, 3, 0)).toEqual({ nx: 0, ny: 0 });
  });

  test('竖屏：左右倾(gamma)驱动 nx，超出量程后夹到 ±1', () => {
    const { nx, ny } = tiltToFocus(0, 90, 0);
    expect(nx).toBe(1);
    expect(ny).toBe(0);
  });

  test('竖屏：gamma 为负 → 向左看（nx<0）', () => {
    expect(tiltToFocus(0, -90, 0).nx).toBeLessThan(0);
  });

  test('竖屏：前后倾(beta-baseline)驱动 ny', () => {
    const { nx, ny } = tiltToFocus(90, 0, 0, { baselineBetaDeg: 0 });
    expect(ny).toBe(1);
    expect(nx).toBe(0);
  });

  test('baseline 被减去：beta 等于 baseline 时 ny 居中', () => {
    expect(tiltToFocus(45, 0, 0, { baselineBetaDeg: 45 }).ny).toBe(0);
  });

  test('gamma 基线被减去：gamma 等于 baseline 时 nx 居中（双击回正后侧握也视为正面）', () => {
    expect(tiltToFocus(0, 30, 0, { baselineGammaDeg: 30 }).nx).toBe(0);
    // 双轴都回正：当前握持姿态映射回中位
    const { nx, ny } = tiltToFocus(40, 25, 0, { baselineBetaDeg: 40, baselineGammaDeg: 25 });
    expect(nx).toBe(0);
    expect(ny).toBe(0);
  });

  test('横屏(90°)：竖屏的左右倾旋转到垂直轴（旋转契约）', () => {
    // 同一物理「右倾」(gamma 大)在横屏下应落到 ny 轴，而非 nx。
    const { nx, ny } = tiltToFocus(0, 90, 90);
    expect(Math.abs(nx)).toBeLessThan(1e-6);
    expect(Math.abs(ny)).toBe(1);
  });
});

describe('accelToTiltAngles', () => {
  // 由重力加速度向量推算倾角（Generic Sensor API 的 Accelerometer 含重力）。
  test('平放面朝上 → beta/gamma 居中(≈0)', () => {
    const { beta, gamma } = accelToTiltAngles(0, 0, 9.8);
    expect(Math.abs(beta)).toBeLessThan(1);
    expect(Math.abs(gamma)).toBeLessThan(1);
  });

  test('右侧下沉(x≈g) → gamma≈+90(右倾到极限)', () => {
    expect(accelToTiltAngles(9.8, 0, 0).gamma).toBeCloseTo(90, 0);
  });

  test('左侧下沉(x≈-g) → gamma 为负', () => {
    expect(accelToTiltAngles(-9.8, 0, 0).gamma).toBeLessThan(0);
  });

  test('顶部前倾(y≈g) → beta≈+90', () => {
    expect(accelToTiltAngles(0, 9.8, 0).beta).toBeCloseTo(90, 0);
  });
});

describe('createGravityEstimator', () => {
  // 对原始加速度向量做慢低通，抹掉走路的动态加速度、留下稳定重力方向。
  const variance = (arr: number[]) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  };

  test('首帧直接采纳原始值（无从 0 缓入的启动瞬态）', () => {
    const est = createGravityEstimator(0.05);
    expect(est.update(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
  });

  test('稳态收敛到恒定输入', () => {
    const est = createGravityEstimator(0.2);
    let out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i++) out = est.update(0, 0, 9.8);
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.z).toBeCloseTo(9.8, 5);
  });

  test('走路场景：估计倾角的波动远小于对原始向量直接算', () => {
    // 稳定重力方向 + 2Hz 动态加速度（模拟脚步/摆臂），采样 60Hz、2s。
    const gx = 2, gy = 6, gz = 7.5; // |g|≈9.9
    const fps = 60, seconds = 2, walkHz = 2, noiseAmp = 3;
    const est = createGravityEstimator(0.05);
    const rawBetas: number[] = [];
    const smoothBetas: number[] = [];
    for (let i = 0; i < fps * seconds; i++) {
      const t = i / fps;
      const n = Math.sin(2 * Math.PI * walkHz * t) * noiseAmp;
      const rx = gx + n, ry = gy - n, rz = gz + n * 0.5;
      rawBetas.push(accelToTiltAngles(rx, ry, rz).beta);
      const s = est.update(rx, ry, rz);
      smoothBetas.push(accelToTiltAngles(s.x, s.y, s.z).beta);
    }
    // 取后半段（避开启动瞬态）比方差。
    const rawVar = variance(rawBetas.slice(fps));
    const smoothVar = variance(smoothBetas.slice(fps));
    expect(smoothVar).toBeLessThan(rawVar * 0.15);
  });
});

describe('lowPass', () => {
  test('alpha=0 保持旧值', () => {
    expect(lowPass(0.2, 0.8, 0)).toBe(0.2);
  });
  test('alpha=1 直接取新值', () => {
    expect(lowPass(0.2, 0.8, 1)).toBe(0.8);
  });
  test('alpha=0.5 取中点', () => {
    expect(lowPass(0, 1, 0.5)).toBe(0.5);
  });
});

describe('createShakeDetector', () => {
  const opts = { magnitudeThreshold: 18, minCrossings: 3, windowMs: 600, cooldownMs: 3000 };

  test('静置在重力附近永不触发', () => {
    const d = createShakeDetector(opts);
    let fired = false;
    for (let t = 0; t < 5000; t += 50) fired = d.push(9.8, t) || fired;
    expect(fired).toBe(false);
  });

  test('窗口内累计达到最少过阈次数时触发一次', () => {
    const d = createShakeDetector(opts);
    expect(d.push(25, 0)).toBe(false);
    expect(d.push(25, 100)).toBe(false);
    expect(d.push(25, 200)).toBe(true); // 第 3 次过阈 → 触发
  });

  test('冷却期内不再触发', () => {
    const d = createShakeDetector(opts);
    d.push(25, 0); d.push(25, 100);
    expect(d.push(25, 200)).toBe(true);
    // 冷却 3s 内继续猛摇也不触发
    expect(d.push(25, 300)).toBe(false);
    expect(d.push(25, 400)).toBe(false);
    expect(d.push(25, 500)).toBe(false);
  });

  test('冷却结束后可再次触发', () => {
    const d = createShakeDetector(opts);
    d.push(25, 0); d.push(25, 100); d.push(25, 200); // fire @200
    expect(d.push(25, 3300)).toBe(false);
    expect(d.push(25, 3400)).toBe(false);
    expect(d.push(25, 3500)).toBe(true); // 冷却已过，再次触发
  });

  test('过阈事件超出时间窗会被剔除，不累计触发', () => {
    const d = createShakeDetector(opts);
    expect(d.push(25, 0)).toBe(false);
    expect(d.push(25, 400)).toBe(false);
    // 距第一次已 900ms > 600ms 窗口：第一次被剔除，窗口内只剩 2 次 → 不触发
    expect(d.push(25, 900)).toBe(false);
  });
});

describe('createTiltGate', () => {
  const opts = { deadband: 0.02, settleMs: 800 };

  test('首帧转发定位，静止收尾窗过后不再转发（不能无限刷新互动压制）', () => {
    const g = createTiltGate(opts);
    expect(g.push(0, 0, 0)).toBe(true); // 首帧：允许按当前握持姿态定位
    expect(g.push(0, 0, 900)).toBe(false); // 收尾窗已过、无动作 → 停喂
    expect(g.push(0.01, 0.005, 1000)).toBe(false); // 手持微颤 < 死区 → 仍停喂
  });

  test('真实倾斜转发；动作停止后收尾窗内继续转发平滑收尾，之后停喂', () => {
    const g = createTiltGate(opts);
    g.push(0, 0, 0);
    expect(g.push(0.1, 0, 2000)).toBe(true); // 超死区 → 动作
    expect(g.push(0.1, 0, 2500)).toBe(true); // 收尾窗内继续
    expect(g.push(0.1, 0, 3000)).toBe(false); // 静止且收尾窗过 → 停喂
  });

  test('缓慢连续倾斜（单帧低于死区但累计超过）也算动作', () => {
    const g = createTiltGate(opts);
    g.push(0, 0, 0);
    let t = 1000;
    let x = 0;
    let fired = false;
    for (let i = 0; i < 10; i++) {
      x += 0.005; // 每帧远小于死区
      t += 16;
      if (g.push(x, 0, t)) fired = true;
    }
    expect(fired).toBe(true); // 相对锚点累计位移触发
  });

  test('停喂后再次动作能重新转发', () => {
    const g = createTiltGate(opts);
    g.push(0, 0, 0);
    expect(g.push(0, 0, 5000)).toBe(false); // 已静止停喂
    expect(g.push(0.2, 0.1, 6000)).toBe(true); // 新动作 → 恢复转发
  });

  test('reset() 清除锚点，下一帧按当前握持重新定位（双击回正）', () => {
    const g = createTiltGate(opts);
    g.push(0.5, 0.5, 0); // 首帧采纳大偏转作为锚点
    expect(g.push(0.5, 0.5, 900)).toBe(false); // 静止 → 停喂
    g.reset();
    // 重置后首帧：按新的当前握持(0.5,0.5)重新定位 → 放行
    expect(g.push(0.5, 0.5, 1000)).toBe(true);
    expect(g.push(0.5, 0.5, 1900)).toBe(false); // 新锚点下静止 → 停喂
  });
});
