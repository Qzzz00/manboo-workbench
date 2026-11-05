import { useEffect, useRef } from 'react';
import { tiltToFocus, lowPass, createShakeDetector, accelToTiltAngles, createGravityEstimator, createTiltGate } from './deviceTilt.ts';

// 设备姿态 → Live2D 的副作用接线层（订阅传感器、生命周期清理）。
// 纯映射/判定逻辑在 deviceTilt.ts（已单测），本文件只做数据源接线。
//
// 数据源优先级（实测：部分 Android System WebView 不派发 deviceorientation/devicemotion，
// 但支持 W3C Generic Sensor API 的 Accelerometer，CPDAY10/Chrome140 即如此）：
//   1) Generic Sensor API `Accelerometer`（一个传感器同时供倾斜跟随 + 摇一摇）
//   2) 兜底：window 的 deviceorientation/devicemotion 事件

interface UseDeviceTiltOptions {
  enabled: boolean;
  onTilt: (nx: number, ny: number) => void;
  onShake: () => void;
}

const SMOOTH_ALPHA = 0.25;
const ACCEL_FREQUENCY = 60;
// 重力方向低通力度：60Hz 下 τ≈0.3s、截止≈0.4Hz。抹掉走路 ~2Hz 颠簸，故意倾斜基本无损。
// 越小越稳、越大越跟手（稳优先取 0.05）。仅用于 Accelerometer 路径，见下。
const GRAVITY_ALPHA = 0.05;

function readScreenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

/**
 * 返回 recenterRef：宿主双击时调用 recenterRef.current()，把陀螺仪基线/门控锚点
 * 重置到当前握持姿态（角色从此姿势起视为「正面对我」）。
 */
export function useDeviceTilt({ enabled, onTilt, onShake }: UseDeviceTiltOptions) {
  const onTiltRef = useRef(onTilt);
  const onShakeRef = useRef(onShake);
  onTiltRef.current = onTilt;
  onShakeRef.current = onShake;
  // 双击回正：宿主在双击时调用——基线/锚点重置到当前握持姿态，角色立即回正。
  const recenterRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    let smX = 0;
    let smY = 0;
    // 首帧倾角作为「中性」基准：手持角度因人而异，借此零配置校准前后/左右倾中位。
    let baselineBeta: number | null = null;
    let baselineGamma: number | null = null;
    const shake = createShakeDetector();
    // 重力方向估计（仅 Accelerometer 路径用）：把原始向量的走路动态加速度滤掉再算倾角。
    const gravity = createGravityEstimator(GRAVITY_ALPHA);
    // 转发门控：传感器 60Hz 恒定出数与用户动没动无关；只有真实动作才喂引擎，
    // 否则「互动让位」窗口被每帧刷新，待机演出永远轮不到上场。
    const gate = createTiltGate();
    recenterRef.current = () => {
      baselineBeta = null;
      baselineGamma = null;
      gate.reset();
    };

    // 一帧倾角/加速度的统一处理：算幅值判摇一摇、算倾角映射 focus。
    function consumeTilt(beta: number, gamma: number, magnitude: number) {
      if (shake.push(magnitude, performance.now())) onShakeRef.current();
      if (baselineBeta == null) baselineBeta = beta;
      if (baselineGamma == null) baselineGamma = gamma;
      const { nx, ny } = tiltToFocus(beta, gamma, readScreenAngle(), { baselineBetaDeg: baselineBeta, baselineGammaDeg: baselineGamma });
      smX = lowPass(smX, nx, SMOOTH_ALPHA);
      smY = lowPass(smY, ny, SMOOTH_ALPHA);
      // 取负：设备轴方向与「朝倾斜方向看」相反（真机实测两轴均需翻转）。
      if (gate.push(-smX, -smY, performance.now())) onTiltRef.current(-smX, -smY);
    }

    let cleanup = () => {};

    // ---- 兜底：window 事件（倾角 + 加速度两个事件源）----
    function attachWindowEventFallback() {
      let lastMag = 9.8; // 无 devicemotion 时按重力近似，摇一摇判定保持中性。
      const onMotion = (e: DeviceMotionEvent) => {
        const a = e.accelerationIncludingGravity;
        if (a && a.x != null && a.y != null && a.z != null) lastMag = Math.hypot(a.x, a.y, a.z);
      };
      const onOrient = (e: DeviceOrientationEvent) => {
        if (e.beta == null || e.gamma == null) return;
        consumeTilt(e.beta, e.gamma, lastMag);
      };
      window.addEventListener('devicemotion', onMotion);
      window.addEventListener('deviceorientation', onOrient);
      cleanup = () => {
        window.removeEventListener('devicemotion', onMotion);
        window.removeEventListener('deviceorientation', onOrient);
      };
    }

    // ---- 优先：Generic Sensor API Accelerometer ----
    const AccelCtor = (window as unknown as { Accelerometer?: new (o?: { frequency?: number }) => AccelSensor }).Accelerometer;
    let started = false;
    if (typeof AccelCtor === 'function') {
      try {
        const accel = new AccelCtor({ frequency: ACCEL_FREQUENCY });
        const onReading = () => {
          const x = accel.x ?? 0;
          const y = accel.y ?? 0;
          const z = accel.z ?? 0;
          // 倾斜通道用平滑后的重力方向（滤走路颠簸）；摇一摇通道用原始合加速度幅值（要动态尖峰）。
          const g = gravity.update(x, y, z);
          const { beta, gamma } = accelToTiltAngles(g.x, g.y, g.z);
          consumeTilt(beta, gamma, Math.hypot(x, y, z));
        };
        // Accelerometer 启动失败（权限/硬件）→ 退回 window 事件。
        const onError = () => {
          accel.removeEventListener('reading', onReading);
          accel.removeEventListener('error', onError);
          try { accel.stop(); } catch { /* ignore */ }
          attachWindowEventFallback();
        };
        accel.addEventListener('reading', onReading);
        accel.addEventListener('error', onError);
        accel.start();
        started = true;
        cleanup = () => {
          accel.removeEventListener('reading', onReading);
          accel.removeEventListener('error', onError);
          try { accel.stop(); } catch { /* ignore */ }
        };
      } catch {
        started = false;
      }
    }
    if (!started) attachWindowEventFallback();

    return () => {
      recenterRef.current = () => {};
      cleanup();
    };
  }, [enabled]);

  return recenterRef;
}

// Generic Sensor API 的最小结构（lib.dom 未必含 Sensor 类型）。
interface AccelSensor {
  x: number | null;
  y: number | null;
  z: number | null;
  start(): void;
  stop(): void;
  addEventListener(type: 'reading' | 'error', cb: () => void): void;
  removeEventListener(type: 'reading' | 'error', cb: () => void): void;
}
