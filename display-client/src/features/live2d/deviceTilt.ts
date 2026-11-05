// 设备姿态 → Live2D 视线信号的纯逻辑层（无 DOM、无副作用，便于单测）。
//  - tiltToFocus：把 DeviceOrientation 的 beta/gamma 倾角映射成归一化 focus 点 [-1,1]，
//    含死区、量程夹取、baseline 扣除与横竖屏旋转归一。
//  - lowPass：一阶低通，平滑传感器噪声。
//  - createShakeDetector：合加速度过阈 + 时间窗 + 冷却的摇一摇判定，防走路/掏手机误触。

export interface TiltOptions {
  /** 死区角度：|倾角| ≤ 此值时不动，过滤手抖。默认 5°。 */
  deadzoneDeg?: number;
  /** 量程角度：从死区到此值线性映射到 0..1，超出夹到 1。默认 35°。 */
  rangeDeg?: number;
  /** 前后倾基准（手持时 beta 并非 0）：ny 以 beta-baseline 计。默认 0。 */
  baselineBetaDeg?: number;
  /** 左右倾基准（偏头/侧握时 gamma 并非 0）：nx 以 gamma-baseline 计。默认 0。 */
  baselineGammaDeg?: number;
}

const DEFAULT_TILT: Required<TiltOptions> = {
  deadzoneDeg: 5,
  rangeDeg: 35,
  baselineBetaDeg: 0,
  baselineGammaDeg: 0,
};

// 单轴映射：死区内归零，死区外线性映射到 ±[0,1] 并夹取。
function mapAxis(angleDeg: number, deadzoneDeg: number, rangeDeg: number): number {
  const a = Math.abs(angleDeg);
  if (a <= deadzoneDeg) return 0;
  const span = Math.max(rangeDeg - deadzoneDeg, 1e-6);
  const t = Math.min((a - deadzoneDeg) / span, 1);
  return Math.sign(angleDeg) * t;
}

export function tiltToFocus(
  beta: number,
  gamma: number,
  orientationAngle: number,
  opts?: TiltOptions,
): { nx: number; ny: number } {
  const { deadzoneDeg, rangeDeg, baselineBetaDeg, baselineGammaDeg } = { ...DEFAULT_TILT, ...opts };
  // 设备坐标系下的倾斜向量：x=左右(gamma-baseline)，y=前后(beta-baseline)。
  const gx = gamma - baselineGammaDeg;
  const gy = beta - baselineBetaDeg;
  // 屏幕旋转 angle → 把倾斜向量旋转 -angle 表达到屏幕坐标系（横竖屏方向一致）。
  const a = (orientationAngle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const sx = gx * cos + gy * sin;
  const sy = -gx * sin + gy * cos;
  return {
    nx: mapAxis(sx, deadzoneDeg, rangeDeg),
    ny: mapAxis(sy, deadzoneDeg, rangeDeg),
  };
}

const RAD2DEG = 180 / Math.PI;

// 由重力加速度向量推算倾角（度）。Generic Sensor API 的 Accelerometer 读数含重力，
// 静止时即为重力方向，可直接得到设备相对水平面的 roll(gamma)/pitch(beta)。
//   gamma：左右倾（绕 Y 轴），右侧下沉为正，范围 ±90。
//   beta ：前后倾（绕 X 轴），顶部前倾为正，范围 ±90。
// 与 DeviceOrientationEvent 的 beta/gamma 语义对齐，故可直接喂 tiltToFocus。
export function accelToTiltAngles(x: number, y: number, z: number): { beta: number; gamma: number } {
  return {
    gamma: Math.atan2(x, Math.hypot(y, z)) * RAD2DEG,
    beta: Math.atan2(y, Math.hypot(x, z)) * RAD2DEG,
  };
}

// 一阶低通：prev 向 next 靠拢 alpha。alpha=0 不动，alpha=1 立即到位。
export function lowPass(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha;
}

/**
 * 重力方向估计器：对原始加速度向量三轴各做慢低通。
 *
 * 加速度计读数 = 重力 + 动态加速度。走路的脚步/摆臂产生高频、时间平均趋近于零的
 * 动态分量，被低通抹平；恒定的重力方向保留。用平滑后的向量算倾角，即可只跟随
 * 「故意的持续倾斜」而不跟随走路颠簸。alpha 越小越稳、越大越跟手。
 * 首帧直接采纳原始值，避免从 0 缓入的启动瞬态。
 */
export function createGravityEstimator(alpha: number) {
  let g: { x: number; y: number; z: number } | null = null;
  return {
    update(x: number, y: number, z: number): { x: number; y: number; z: number } {
      if (g == null) g = { x, y, z };
      else g = { x: lowPass(g.x, x, alpha), y: lowPass(g.y, y, alpha), z: lowPass(g.z, z, alpha) };
      return g;
    },
  };
}

export interface ShakeOptions {
  /** 合加速度过阈门限(m/s²)。重力≈9.8，摇动尖峰远高于此。默认 18。 */
  magnitudeThreshold?: number;
  /** 触发所需的窗口内过阈次数。默认 3。 */
  minCrossings?: number;
  /** 过阈事件的有效时间窗(ms)。默认 600。 */
  windowMs?: number;
  /** 触发后的冷却(ms)，期间不再触发。默认 3000。 */
  cooldownMs?: number;
}

const DEFAULT_SHAKE: Required<ShakeOptions> = {
  magnitudeThreshold: 18,
  minCrossings: 3,
  windowMs: 600,
  cooldownMs: 3000,
};

export function createShakeDetector(opts?: ShakeOptions) {
  const { magnitudeThreshold, minCrossings, windowMs, cooldownMs } = { ...DEFAULT_SHAKE, ...opts };
  let crossings: number[] = [];
  let lastFireAt = -Infinity;

  return {
    /** 喂一帧合加速度幅值；返回是否在本帧触发摇一摇。 */
    push(magnitude: number, now: number): boolean {
      if (magnitude <= magnitudeThreshold) return false;
      crossings.push(now);
      crossings = crossings.filter((t) => now - t <= windowMs);
      if (crossings.length >= minCrossings && now - lastFireAt >= cooldownMs) {
        lastFireAt = now;
        crossings = [];
        return true;
      }
      return false;
    },
  };
}

export interface TiltGateOptions {
  /** 归一化 focus 空间 [-1,1] 的动作阈值：相对锚点位移超过才算「用户在动」。默认 0.02。 */
  deadband?: number;
  /** 动作停止后继续转发的收尾窗口(ms)，让跟随平滑落定。默认 800。 */
  settleMs?: number;
}

const DEFAULT_TILT_GATE: Required<TiltGateOptions> = {
  deadband: 0.02,
  settleMs: 800,
};

/**
 * 倾斜转发门控：只有「真实动作」才把倾角喂给引擎。
 *
 * 背景：传感器按固定频率（60Hz）持续出数，与用户动没动手机无关。若无条件转发，
 * 引擎会把每一帧都当作「用户正在互动」而让待机演出无限让位（压制窗被 60Hz 刷新，
 * 永远走不完）。本门控以锚点位移判定动作：静止/微颤时停喂，待机演出得以正常上场。
 *
 * 锚点只在动作帧更新——缓慢连续倾斜虽单帧低于死区，相对锚点会累计触发，不漏跟随。
 */
export function createTiltGate(opts?: TiltGateOptions) {
  const { deadband, settleMs } = { ...DEFAULT_TILT_GATE, ...opts };
  let anchorX = 0;
  let anchorY = 0;
  let activeUntil = -Infinity;
  let primed = false;

  return {
    /** 喂一帧归一化倾斜；返回是否应转发给引擎。 */
    push(nx: number, ny: number, now: number): boolean {
      if (!primed) {
        // 首帧：采纳当前握持姿态为锚点并放行，让形象按实际持机角度定位。
        primed = true;
        anchorX = nx;
        anchorY = ny;
        activeUntil = now + settleMs;
        return true;
      }
      if (Math.hypot(nx - anchorX, ny - anchorY) > deadband) {
        anchorX = nx;
        anchorY = ny;
        activeUntil = now + settleMs;
        return true;
      }
      return now < activeUntil; // 收尾窗内继续转发，平滑落定；之后停喂
    },
    /** 回正（双击）：清除已采纳的锚点，下一帧按当前握持重新定位。 */
    reset(): void {
      primed = false;
    },
  };
}
