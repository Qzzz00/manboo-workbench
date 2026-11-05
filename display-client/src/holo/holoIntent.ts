/**
 * 全息屏「统一意图层」：把多模态输入源（语音 / 将来 Stackchan 手势 / 触摸）先归一成
 * 一组「意图 HoloIntent」，再由纯 reducer 翻成「动作描述符 HoloAction」交执行侧照做。
 *
 * ★为什么这样切：意图与来源解耦★
 *  - 输入源只管产出「用户想干嘛」(HoloIntent)，不关心怎么执行、也不关心彼此；
 *  - 执行侧（djView / 引擎 / 番茄提醒）只认 HoloAction，不关心是语音还是手势来的；
 *  - 中间 resolveIntent 是纯函数（不碰 DOM / 引擎 / djView），单测即可锁死这张映射表，
 *    以后新增输入源（手势、触摸、陀螺仪…）只要能产出 HoloIntent，执行侧零改动。
 *
 * 本模块是纯 TS 逻辑：无 React / DOM / 引擎依赖，全部 named export，便于隔离单测。
 */

import { HOLO_CONTROLS, type HoloControl } from './holoControl';

// ── 意图 HoloIntent：用户想干嘛（与输入来源无关）─────────────────────────
// 语音来的播放控制直接复用现有 HoloControl 白名单；音量 / 番茄是给手势·触摸预留的新意图；
// chat 是兜底——判定「不是控制指令」时，把原话原样交给 LLM 对话。
export type HoloIntent =
  | { kind: 'playback'; control: HoloControl } // 播放控制（复用语音白名单：next/prev/playPause/mode:*）
  | { kind: 'volume'; dir: 'up' | 'down' } //    相对增减（手势：捏手指=down）
  | { kind: 'volume'; set: number } //           绝对设定 0..1（语音「音量一半」/ 触摸滑条）
  | { kind: 'pomodoro'; action: 'ack' | 'pause' | 'resume' } // 番茄：摸头消闹钟 / 语音暂停·继续专注
  | { kind: 'pomodoro'; action: 'set'; minutes: number } // 番茄：语音改专注时长(立即按新时长重开)
  | { kind: 'open_app'; name: string } //        打开应用(名字交执行侧查表→包名;LLM 判意图)
  | { kind: 'chat'; text: string }; //           兜底：非控制 → 交给 LLM 对话

// ── 动作描述符 HoloAction：执行侧照着做的判别联合 ───────────────────────
// 刻意做成扁平的纯 data（不含函数 / 引用 / DOM），方便日志、回放、单测直接对拍。
export type HoloAction =
  | { type: 'dj.next' }
  | { type: 'dj.prev' }
  | { type: 'dj.playPause' }
  | { type: 'dj.pause' } // 明确暂停(已暂停=无操作,执行侧按 paused 状态判)
  | { type: 'dj.play' } //  明确播放(在播=无操作)
  | { type: 'dj.setMode'; mode: string }
  | { type: 'volume.delta'; delta: number } // 相对：up=+VOLUME_STEP / down=-VOLUME_STEP
  | { type: 'volume.set'; value: number } //   绝对：已 clamp 到 [0,1]
  | { type: 'pomodoro.ack' }
  | { type: 'pomodoro.pause' }
  | { type: 'pomodoro.resume' }
  | { type: 'pomodoro.setMinutes'; minutes: number }
  | { type: 'open_app'; name: string } //         打开应用(执行侧查中文名→包名,未知回落更多应用抽屉)
  | { type: 'chat'; text: string };

/** 音量相对增减的步长（up=+0.1 / down=-0.1）。抽成常量便于统一调 + 单测引用同一真相。 */
export const VOLUME_STEP = 0.1;

/**
 * 把音量夹到 [0,1]。NaN 无法参与比较，兜底到 0（静音）；±Infinity 交给 Math 自然夹到边界
 * （+∞→1 / -∞→0），保证输出恒落在合法闭区间，绝不把非法值喂给播放器。
 */
export function clampVolume(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * 纯 reducer：意图 → 动作描述符。这是唯一的「翻译表」，无副作用。
 * switch 覆盖每种 kind；default 用 never 断言锁死穷尽性（漏处理某种意图 → 编译期即报）。
 */
export function resolveIntent(intent: HoloIntent): HoloAction {
  switch (intent.kind) {
    case 'playback':
      return playbackControlToAction(intent.control);
    case 'volume':
      // 两种音量意图同为 kind:'volume'，用 'set' 字段二次判别：
      // 有 set → 绝对设定（clamp 到 [0,1]）；否则 → 相对增减（固定步长）。
      if ('set' in intent) return { type: 'volume.set', value: clampVolume(intent.set) };
      return { type: 'volume.delta', delta: intent.dir === 'up' ? VOLUME_STEP : -VOLUME_STEP };
    case 'pomodoro':
      if (intent.action === 'pause') return { type: 'pomodoro.pause' };
      if (intent.action === 'resume') return { type: 'pomodoro.resume' };
      if (intent.action === 'set') return { type: 'pomodoro.setMinutes', minutes: intent.minutes };
      return { type: 'pomodoro.ack' };
    case 'open_app':
      return { type: 'open_app', name: intent.name };
    case 'chat':
      return { type: 'chat', text: intent.text };
    default:
      return assertNever(intent);
  }
}

/** 播放控制白名单 → 动作。mode:* 拆成 dj.setMode + 具体模式名，其余一一直连。 */
function playbackControlToAction(control: HoloControl): HoloAction {
  // 唯一的带参指令先拦（模板字面量类型进不了 switch 穷举）
  const setM = /^pomodoro:set:(\d+)$/.exec(control);
  if (setM) return { type: 'pomodoro.setMinutes', minutes: parseInt(setM[1], 10) };
  const appM = /^open_app:(.+)$/.exec(control);
  if (appM) return { type: 'open_app', name: appM[1] };
  const fixed = control as (typeof HOLO_CONTROLS)[number];
  switch (fixed) {
    case 'next':
      return { type: 'dj.next' };
    case 'prev':
      return { type: 'dj.prev' };
    case 'playPause':
      return { type: 'dj.playPause' };
    case 'pause':
      return { type: 'dj.pause' };
    case 'play':
      return { type: 'dj.play' };
    case 'volume:up':
      return { type: 'volume.delta', delta: VOLUME_STEP };
    case 'volume:down':
      return { type: 'volume.delta', delta: -VOLUME_STEP };
    case 'volume:min':
      return { type: 'volume.set', value: 0.12 }; // 不给0:「最小」语义=还听得见
    case 'volume:half':
      return { type: 'volume.set', value: 0.5 };
    case 'volume:max':
      return { type: 'volume.set', value: 1 };
    case 'pomodoro:pause':
      return { type: 'pomodoro.pause' };
    case 'pomodoro:resume':
      return { type: 'pomodoro.resume' };
    case 'mode:focus':
      return { type: 'dj.setMode', mode: 'focus' };
    case 'mode:commute':
      return { type: 'dj.setMode', mode: 'commute' };
    default:
      return assertNever(fixed);
  }
}

/** 便捷构造器：把语音来的 HoloControl 包成 playback 意图（输入源侧的统一出口）。 */
export function playbackIntent(c: HoloControl): HoloIntent {
  return { kind: 'playback', control: c };
}

// ── Stackchan 手势接缝：手势名 → 意图（纯查表）───────────────────────────
// 手势识别本体在别处（Stackchan 硬件 / 视觉），这里只提供「名字 → 意图」的静态映射，
// 让手势和语音汇入同一条 HoloIntent 管道。表项按不可变值描述符对待（消费侧勿改）。
const GESTURE_INTENTS: Record<string, HoloIntent> = {
  pinch: { kind: 'volume', dir: 'down' }, //             捏手指 = 降音量
  swipe_left: { kind: 'playback', control: 'prev' }, //  左挥 = 上一首
  swipe_right: { kind: 'playback', control: 'next' }, // 右挥 = 下一首
  swipe_up: { kind: 'volume', dir: 'up' }, //            食指上挥 = 音量+
  swipe_down: { kind: 'volume', dir: 'down' }, //        食指下挥 = 音量-
  open_palm: { kind: 'playback', control: 'playPause' }, // (tap 备用遥控)播放/暂停开关
  fist: { kind: 'playback', control: 'pause' }, //       拳头 = 暂停(视觉大脑手型)
  palm: { kind: 'playback', control: 'play' }, //        手掌 = 播放(视觉大脑手型)
  head_pat: { kind: 'pomodoro', action: 'ack' }, //      摸头 = 消番茄闹钟(Stackchan 头顶 Si12T)
};

/** 常见手势名 → 意图：命中查表返回意图，未知返回 null（调用侧忽略）。给 Stackchan 预留的接缝。 */
export function gestureToIntent(gesture: string): HoloIntent | null {
  return GESTURE_INTENTS[gesture] ?? null;
}

// ── 桥事件接缝：后端 /api/holo/events 统一事件流（Stackchan 手势 + 语音转写）→ 意图 ──
export type HoloBridgeEvent = { kind: string; value: string };

/**
 * 桥事件 → 意图：gesture 走手势查表；utterance（设备录音经服务端 ASR 的转写文本）
 * 兜底进 LLM 对话管线（chat 意图 → handleSubmit，由 LLM 自己判「控制 or 闲聊」——
 * 与 holo 本机语音（useHoloVoice）殊途同归）；未知 kind / 空文本返回 null（调用侧忽略）。
 */
export function holoEventToIntent(evt: HoloBridgeEvent): HoloIntent | null {
  if (evt.kind === 'gesture') return gestureToIntent(evt.value);
  if (evt.kind === 'utterance') {
    const text = evt.value.trim();
    return text ? { kind: 'chat', text } : null;
  }
  return null;
}

/** 穷尽性守卫：类型正确时永不触达；漏处理某个联合成员时编译期即报错。 */
function assertNever(x: never): never {
  throw new Error(`Unhandled HoloIntent/HoloControl: ${JSON.stringify(x)}`);
}
