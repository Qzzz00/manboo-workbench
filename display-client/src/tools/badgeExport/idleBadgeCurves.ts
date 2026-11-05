/* 吧唧 W2：程序化低幅闭环 idle 曲线（spec docs/superpowers/specs/2026-07-04-idle-smoothness-design.md §3-W2）。
 *
 * 为什么不走 motion3.json / motion 管理器：引擎路径上有五个干扰源（绑定注册无 fade 控制、
 * Cubism 默认 fadeIn、内部 loop 融合、ensureIdle 看门狗、待机小动作池），且 pixi-live2d-display
 * 的 updateNaturalMovements 每帧偷偷叠加无理周期大摆(±7.5°)并覆写 ParamBreath——与任何 T
 * 都不通约=闭环必破（capture 时已 monkey-patch 掉，见 BadgeExportPage）。程序化直驱=数学
 * 精确闭环：帧 i = f(i/fps)，f(T)≡f(0)。
 *
 * 预算铁律（2026-07-04 实测 v2-v6）：delta 成本 ∝ 会动区块面积×帧数，与幅度/速度无关
 * （呼吸放慢一半+幅度减半→195块/帧纹丝不动）。推论：
 * - 幅度是免费的活气 → 呼吸拉满（翅膀物理挂在 ParamBreath 上，呼吸=翅膀活）。
 * - 连续全身摆装不下（纯呼吸 96KB/帧×32帧≈3.25MB 已近 3417KB 上限）→ 头部连续摆砍掉，
 *   补偿=小面积事件（耳抽动，错峰双耳）+ W3 眨眼随机轴。
 *
 * 写入位点：全部曲线在 afterMotionUpdate 写（物理之前）→ 翅/发/耳物理吃到周期输入。
 * 眼恒开/嘴恒闭由页面滑杆钉（beforeModelUpdate 终审），眨眼归 W3 固件随机轴。
 *
 * 拍板（Ben 2026-07-04）：32帧@10fps=3.2s 循环，D1 构图（恒等 transform，探针已验）。
 */

/** 循环周期（秒）。采集必须满足 帧数/fps === 该值（26帧@10fps=2.6s）。
 * 预算封顶 idle ~26 帧(全身动132K/帧)；10fps=硬件能给的最长循环(60÷6=10 是最低干净 TE 除数)。
 * 观感速度 = 幅度÷周期：要"大而慢"就中幅度+最长周期(此配置)，别靠 fps(fps↑=循环↓且更快)。 */
// 魔力卡（F1C100s，H.264 硬解）改档：吧唧的 2.6s/10fps 是板子 lz4 帧预算 + TE 除数天花板，
// 磁卡放视频无此限制。周期拉长到 6s（60fps=360帧，原生渲染无插值），观感"大而慢不憋屈"。
// 吧唧若要重烧本值应回 2.6（吧唧已冻结，暂不受影响）。
export const IDLE_BADGE_PERIOD_S = 6.0;

type SineCurve = {
  id: string;
  /** 每周期整数圈数（闭环前提） */
  cycles: number;
  amp: number;
  offset: number;
  /** 相位，单位=周期分数 0..1 */
  phase: number;
};

/** 事件曲线：升余弦包络 × 单圈正弦，窗外恒 0（像素逐字节相同→delta 零成本）。
 * 窗必须完全落在 (0, T) 内且不跨缝；包络与其导数在窗缘为 0 → C1 平滑。 */
type EventCurve = {
  id: string;
  t0: number;
  t1: number;
  amp: number;
  /** wiggle=包络×单圈正弦(来回抖,耳用); bump=纯升余弦包络(单向起落,呼吸联动抬头用) */
  shape: 'wiggle' | 'bump';
};

/** 连续组：呼吸 + 全身连续摇摆（E5, Ben 反馈"要晃动不要打嗝"; lz4 解锁了全身连续帧的预算）。
 * 全部整数圈正弦 → 数学闭环; 相位错开避免节拍器感; 幅度取"轻晃"级(比现有 idle.motion3 半幅)。
 * 翅膀/蝴蝶结物理输入=ParamBreath; 胸/裙/发/链的物理输入=角度参数(见 physics3)。 */
const CONTINUOUS_CURVES: SineCurve[] = [
  // E9 速度(Ben 认可)：摇摆(角度)砍半的那套保持不动。
  // E10 修翅膀"乱飞"：breath 0.7(范围-0.2~1.2,clamp 0/1) → 大力驱动 floppy 蝙蝠翅物理进
  // ~2×共振 overshoot(帧图实测每循环拍2次+左右不对称)。改 0.3(范围0.2~0.8,不 clamp,轻驱动)
  // → 翅膀跟随呼吸缓起伏、单拍、无 ringing。摇摆速度不受影响(不同参数)。
  // E13 解耦决定版 (Ben: 翅膀太大/身体太小)——关键: 翅膀刚性挂"躯干"(ParamBodyAngle)不挂"头"
  // (ParamAngle)。故: 头角度拉大=身体有生气但不动翅膀; 躯干角度砍到近零+breath 极小=翅膀几乎
  // 不动。这是唯一能"身体大+翅膀小"的解(绕开躯干-翅膀刚性耦合)。
  // F2 真机(Ben: 身体再大一点 / 翅膀有点卡·幅度再小)：breath 0.08→0.04(翅膀近静=去卡),
  // 头角度再放大 ~1.25×(不牵翅膀), 躯干仍近零。
  // 魔力卡方案B(Ben选)：温和小翅膀+完美无缝。大翻飞物理闭不上循环(wrap∝幅度: 0.3→4.5, 0.45c2→10.3),
  // 故取小幅 0.15(比吧唧近静0.04大~4倍,能看到动)+cycles1(慢,利于闭合)。目标 wrap<1.5=直编码无需淡化,零重影。
  // 翅膀是老大难(floppy低阻尼,大动包络也沉淀不下=淡化重影)。收到0.15轻起伏不糊。生气主要靠头/身体晃动(包络能兜)。
  { id: 'ParamBreath', cycles: 1, amp: 0.15, offset: 0.5, phase: 0.75 }, // 翅膀: 轻呼吸(不糊)
  // 头晃是主要生气来源(周期运动=闭环友好,鬓角/头发跟着自然摆)。1.2太木/3.3太夸张→2.4/1.6/1.9 中间档:明显晃头点头歪头。
  // 加一点躯干晃(0.6/0.5)让整体"晃一晃"更有身体感(躯干也带翅膀,但幅度小不破循环)。
  // 中段满幅大晃(有包络兜底,首尾归中性沉淀):转头/点头/歪头都拉大=预览那种有生气的自然待机。
  { id: 'ParamAngleX', cycles: 1, amp: 4.5, offset: 0, phase: 0.15 },   // 转头
  { id: 'ParamAngleY', cycles: 1, amp: 3.0, offset: 0, phase: 0.55 },   // 点头
  { id: 'ParamAngleZ', cycles: 1, amp: 3.5, offset: 0, phase: 0.35 },   // 歪头
  { id: 'ParamBodyAngleX', cycles: 1, amp: 1.2, offset: 0, phase: 0.25 }, // 躯干晃(带动身体/裙)
  { id: 'ParamBodyAngleZ', cycles: 1, amp: 1.0, offset: 0, phase: 0.7 }, // 躯干晃
  // 钉死头发摇动参数=0：治「刘海/左鬓角无缘无故抽动」。真凶=模型 idle.motion3(写ParamHairFront)+
  // swing.motion3(写ParamHairFront/Side)被 ensureIdle 看门狗泄漏进采集窗,而我的曲线没写这俩=没盖住。
  // 在 afterMotionUpdate(动作之后)硬写 0 → 强制覆盖泄漏,刘海/侧发不再被动作驱动。(物理仍随头角度微动)
  { id: 'ParamHairFront', cycles: 1, amp: 0, offset: 0, phase: 0 }, // 刘海摇动: 钉0(防idle motion泄漏)
  { id: 'ParamHairSide', cycles: 1, amp: 0, offset: 0, phase: 0 },  // 侧发摇动: 钉0(防swing motion泄漏)
];

/** 事件组：错峰双耳抽动（Param62/63=物理图里左/右耳链的专用输入；小区域点缀,不参与身体晃动）。 */
// 魔力卡：删掉耳朵抽动事件——嫌疑是它带动附近头发"一抽一抽"。先移除验证。
const EVENT_CURVES: EventCurve[] = [];

/* 眨眼烤进 idle（Ben 2026-07-04：单张 overlay 贴图不贴合/太大/太快=死结，改烤进帧由 Live2D
 * 渲染=尺寸对/跟头准/缓缓合上）。窗内 ParamEyeLOpen/ROpen 按升余弦 1→0→1（睁→闭→睁），
 * 窗外恒 1（睁）。窗须完全落在 (0,T) 内不跨缝。1 次/循环（周期 2.6s≈真人静息眨眼率）。
 * 采集时页面须关"眼开合"滑杆(eyeOn=false)，否则 beforeModelUpdate 会把眼钉回睁。 */
const BLINK_WINDOW = { t0: 1.0, t1: 1.4 };   // 0.4s≈4帧@10fps：睁→半→闭(帧12)→半→睁
export function blinkEyeOpen(tSec: number): number {
  // 磁卡:恢复眨眼(Ben:一直不眨很奇怪)。之前误判「刘海抽动=眨眼」,实际抽动主因是头转物理(已调小)。眨眼自然,保留。
  let t = tSec % IDLE_BADGE_PERIOD_S;
  if (t < 0) t += IDLE_BADGE_PERIOD_S;
  if (t <= BLINK_WINDOW.t0 || t >= BLINK_WINDOW.t1) return 1;      // 窗外恒睁
  const u = (t - BLINK_WINDOW.t0) / (BLINK_WINDOW.t1 - BLINK_WINDOW.t0);
  const closed = 0.5 * (1 - Math.cos(2 * Math.PI * u));            // 0→1→0 闭合度
  return 1 - closed;                                              // 1→0→1 睁开度
}

/* 晃动包络(Ben思路):首尾各 SWAY_TAPER_S 缓冲期把晃动幅度渐降到0=回到中性姿势,让物理沉淀→首尾同一静止姿势=完美闭合;
 * 中间平台期幅度拉满=大幅有生气。Tukey窗:0→(升余弦taper)→1→(平台)→1→(降余弦taper)→0。env与env'在首尾都=0(C1平滑,零速度沉淀)。
 * 幅度只乘振荡项(offset中性姿势不变):angle=offset+env·amp·sin。首尾 env=0 → =offset(中性)。 */
const SWAY_TAPER_S = 1.5;
function swayEnvelope(tSec: number): number {
  let t = tSec % IDLE_BADGE_PERIOD_S;
  if (t < 0) t += IDLE_BADGE_PERIOD_S;
  const T = IDLE_BADGE_PERIOD_S;
  const taper = Math.min(SWAY_TAPER_S, T / 2);
  if (t < taper) return 0.5 * (1 - Math.cos((Math.PI * t) / taper));         // 0→1 缓冲起
  if (t > T - taper) return 0.5 * (1 - Math.cos((Math.PI * (T - t)) / taper)); // 1→0 缓冲回(回第一帧)
  return 1;                                                                   // 中间满幅
}

function evalSine(c: SineCurve, tSec: number): number {
  const osc = c.amp * Math.sin((2 * Math.PI * c.cycles * tSec) / IDLE_BADGE_PERIOD_S + 2 * Math.PI * c.phase);
  return c.offset + swayEnvelope(tSec) * osc;
}

function evalEvent(c: EventCurve, tSec: number): number {
  // 预热段 t<0：按周期回卷到 [0,T)，保证预热轨迹与采集窗完全同构
  let t = tSec % IDLE_BADGE_PERIOD_S;
  if (t < 0) t += IDLE_BADGE_PERIOD_S;
  if (t <= c.t0 || t >= c.t1) return 0;
  const u = (t - c.t0) / (c.t1 - c.t0);              // 0..1
  const env = 0.5 * (1 - Math.cos(2 * Math.PI * u)); // 升余弦包络 0→1→0
  if (c.shape === 'bump') return c.amp * env;        // 单向起落(呼吸联动)
  return c.amp * env * Math.sin(2 * Math.PI * u);    // 单圈来回(耳抖)
}

/** 物理输入组（afterMotionUpdate 写入，物理之前）。 */
export function evalIdleBadgeAngles(tSec: number): Array<[string, number]> {
  return EVENT_CURVES.map((c) => [c.id, evalEvent(c, tSec)] as [string, number]);
}

/** 与 Angles 同位点写入（历史命名保留；现全部都在 afterMotionUpdate）。
 * 眨眼(ParamEyeOpen)不在此写——afterMotionUpdate 对眼不生效(库随后恢复默认睁)，改由
 * 采集侧每帧塞 burst(beforeModelUpdate)驱动，见 BadgeExportPage 的 blinkEyeOpen 用法。 */
export function evalIdleBadgeFinal(tSec: number): Array<[string, number]> {
  return CONTINUOUS_CURVES.map((c) => [c.id, evalSine(c, tSec)] as [string, number]);
}
