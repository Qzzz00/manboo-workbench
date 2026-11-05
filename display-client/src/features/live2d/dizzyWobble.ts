// 摇一摇「被摇晕」的程序化演出：一段大幅、长尾的圆周晃动 + 张嘴。
// 设计要点：摇动过程中用户看不清角色，真正要看的是「停手后的余波」——所以动作要大、
// 衰减要慢（长尾），即便在摇动初期触发，用户停手时仍有明显晃动可看。
// 输出 focus 点（[-1,1] 归一化空间，喂 focusController 带动头+眼+身物理晃动）与张嘴量。
// 纯函数、无状态：引擎每帧用「距触发的毫秒数」调用它，取回该帧姿态。

export const DIZZY_DURATION_MS = 1500; // 整段时长（长尾余波）
export const DIZZY_ATTACK_MS = 120;    // 起手爬升：从中位平滑甩出，避免圆周运动起点跳变
const DIZZY_FREQ_HZ = 2.2;             // 晃动频率（大幅摆动稍慢更像「天旋地转」）
const DIZZY_AMP_X = 1.0;               // 左右摆幅（focus 上限=头部最大转幅）
const DIZZY_AMP_Y = 0.75;             // 上下摆幅（与 X 正交 → 头绕圈打转）
const DIZZY_MOUTH_PEAK = 0.85;         // 张嘴峰值

export interface DizzyFrame {
  active: boolean;
  focusX: number;
  focusY: number;
  mouthOpen: number;
}

const INACTIVE: DizzyFrame = { active: false, focusX: 0, focusY: 0, mouthOpen: 0 };

// 幅度包络：先在 DIZZY_ATTACK_MS 内 0→1 爬升，之后线性长衰减到 0（长尾余波）。
function envelope(elapsedMs: number, durationMs: number): number {
  if (elapsedMs < DIZZY_ATTACK_MS) return elapsedMs / DIZZY_ATTACK_MS;
  const decayT = (elapsedMs - DIZZY_ATTACK_MS) / (durationMs - DIZZY_ATTACK_MS); // 0..1
  return 1 - decayT;
}

/**
 * @param elapsedMs 距晕摇触发的毫秒数
 * @param durationMs 整段时长（默认 DIZZY_DURATION_MS）
 * 越界（<0 或 >=时长）返回 active:false，各量归零。
 */
export function dizzyWobble(elapsedMs: number, durationMs: number = DIZZY_DURATION_MS): DizzyFrame {
  if (!(elapsedMs >= 0) || elapsedMs >= durationMs) return INACTIVE;

  const env = envelope(elapsedMs, durationMs);
  const phase = 2 * Math.PI * DIZZY_FREQ_HZ * (elapsedMs / 1000);

  return {
    active: true,
    // X=sin、Y=cos → 正交，合成圆周「打转」；起手爬升让两轴都从 0 甩出。
    focusX: Math.sin(phase) * DIZZY_AMP_X * env,
    focusY: Math.cos(phase) * DIZZY_AMP_Y * env,
    // 张嘴跟随包络：起手张开，随余波慢慢合上，末尾归零。
    mouthOpen: env * DIZZY_MOUTH_PEAK,
  };
}
