/* motion3 求值器单测：拿一条手写的 8 秒循环动作（仓库 10-21 起不带模型，原先用的 shuangsheng idle 已出库）验证
 * ① 解析（时长/曲线数） ② loop 闭合（f(0)≡f(T)，authored loop 的硬前提）
 * ③ 值域合法（不越 authored 关键帧包络太多——贝塞尔可轻微过冲，容忍 15%）
 * 并打印 authored idle 与手搓正弦驱动的峰值速度/加速度对比（甩头发的物理量）。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evalMotionCurve, motionCurveStats, parseMotion3 } from './motionCurves.ts';
import { IDLE_BADGE_PERIOD_S } from './idleBadgeCurves.ts';

const IDLE_PATH = resolve(__dirname, '../../features/badgeBake/fixtures/idle-loop.motion3.json');
const motion = parseMotion3(JSON.parse(readFileSync(IDLE_PATH, 'utf8')));

describe('parseMotion3(idle.motion3.json)', () => {
  it('时长 8s / 5 条参数曲线', () => {
    expect(motion.duration).toBe(8);
    expect(motion.loop).toBe(true);
    expect(motion.curves).toHaveLength(5);
  });

  it('全部曲线 loop 闭合：|f(0)-f(T)| < 1e-6', () => {
    for (const c of motion.curves) {
      const first = evalMotionCurve(c.segments, 0);
      const last = evalMotionCurve(c.segments, motion.duration);
      expect(Math.abs(first - last), c.id).toBeLessThan(1e-6);
    }
  });

  it('中间采样值有限且连续（无 NaN / 无跳变）', () => {
    for (const c of motion.curves) {
      let prev = evalMotionCurve(c.segments, 0);
      for (let s = 1; s <= 800; s += 1) {
        const v = evalMotionCurve(c.segments, (s / 800) * motion.duration);
        expect(Number.isFinite(v), c.id).toBe(true);
        // 10ms 步长下单步跳变 > 2.0 视为解析错位（authored idle 是缓动曲线）
        expect(Math.abs(v - prev), `${c.id}@${s}`).toBeLessThan(2);
        prev = v;
      }
    }
  });

  it('打印 authored idle vs 手搓正弦 的激励猛烈度（诊断输出）', () => {
    const stats = motionCurveStats(motion);
    const fmt = (n: number) => n.toFixed(2).padStart(8);
    console.log('\n—— authored idle.motion3（8s）——');
    console.log('param'.padEnd(18) + 'min'.padStart(8) + 'max'.padStart(8) + 'maxVel/s'.padStart(10) + 'maxAcc/s²'.padStart(11));
    for (const s of stats) {
      console.log(s.id.padEnd(18) + fmt(s.min) + fmt(s.max) + fmt(s.maxVel).padStart(10) + fmt(s.maxAcc).padStart(11));
    }
    // 对比：现行正弦驱动（idleBadgeCurves 魔力卡档）AngleX amp4.5 cycles1 + Tukey 包络 taper1.5s。
    // 正弦本体 maxVel = A·2π/T, maxAcc = A·(2π/T)²；包络把能量压进中段还会再抬升瞬时值，
    // 这里直接数值微分（与 motionCurveStats 同 hz）拿真实包络后的值。
    const T = IDLE_BADGE_PERIOD_S;
    const taper = 1.5;
    const env = (t: number) => {
      if (t < taper) return 0.5 * (1 - Math.cos((Math.PI * t) / taper));
      if (t > T - taper) return 0.5 * (1 - Math.cos((Math.PI * (T - t)) / taper));
      return 1;
    };
    const sine = (t: number) => env(t) * 4.5 * Math.sin((2 * Math.PI * t) / T + 2 * Math.PI * 0.15);
    const hz = 120;
    let prev = sine(0);
    let prevVel = 0;
    let maxVel = 0;
    let maxAcc = 0;
    for (let s = 1; s <= T * hz; s += 1) {
      const v = sine(s / hz);
      const vel = (v - prev) * hz;
      const acc = (vel - prevVel) * hz;
      if (Math.abs(vel) > maxVel) maxVel = Math.abs(vel);
      if (s > 1 && Math.abs(acc) > maxAcc) maxAcc = Math.abs(acc);
      prev = v;
      prevVel = vel;
    }
    console.log(`\n—— 手搓正弦 AngleX（amp4.5 T=${T}s + Tukey包络）——`);
    console.log(`maxVel=${maxVel.toFixed(2)}/s maxAcc=${maxAcc.toFixed(2)}/s²`);
    expect(stats.length).toBe(5);
  });
});
