/**
 * 全息屏语音控制意图：LLM 在 JSON 里吐一个 `control` 字段，App 解析后驱动
 * djView 的播放控制 / 模式切换。屏幕不可点，控制全走语音，所以让 LLM 判意图。
 *
 * 本模块只负责「合法值定义 + 校验」，是可测的隔离核心；mic/VAD 在 useHoloVoice，
 * 契约挂载在 llm.ts。移动端主客户端不传 holoControl，走不到这里。
 */

/** LLM/手势允许的控制指令（严格白名单，别的一律忽略当普通聊天）。 */
export const HOLO_CONTROLS = [
  'next', // 下一首/切一首
  'prev', // 上一首/回上一首
  'playPause', // 暂停/继续（同一开关）
  'pause', // 明确暂停（拳头手势/「暂停」；已暂停则无操作）
  'play', // 明确播放（手掌手势/「继续放」；在播则无操作）
  'volume:up', // 音量大一点(相对+10%)
  'volume:down', // 音量小一点(相对-10%)
  'volume:min', // 音量调到最小(能听见的底线)
  'volume:half', // 音量调到一半
  'volume:max', // 音量调到最大
  'pomodoro:pause', // 暂停专注/番茄倒计时（≠暂停音乐）
  'pomodoro:resume', // 继续专注/番茄倒计时
  'mode:focus', // 切「音乐」模式
  'mode:commute', // 切「播客」模式
] as const;

/** 固定白名单之外,唯一的带参指令:pomodoro:set:<分钟>(语音「番茄设为25分钟一组」)。 */
export type HoloControl = (typeof HOLO_CONTROLS)[number] | `pomodoro:set:${number}` | `open_app:${string}`;

/**
 * 校验并归一 LLM 吐出的 control 原始值。命中白名单返回该指令，否则 undefined
 * （消费侧据此判断「这是控制指令」还是「纯聊天，只回复不控制」）。
 * 容忍首尾空白与大小写；mode 前缀大小写也容忍（focus/FOCUS）。
 */
export function parseHoloControl(raw: unknown): HoloControl | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  // 直接命中（含 mode: 前缀）
  const lower = v.toLowerCase();
  const hit = HOLO_CONTROLS.find((c) => c.toLowerCase() === lower);
  if (hit) return hit;
  // 带参:pomodoro:set:<分钟>。范围对齐 FocusTimer 的 UI 限制(1..180),太离谱的当聊天忽略。
  const setM = /^pomodoro:set:(\d{1,3})$/.exec(lower);
  if (setM) {
    const min = parseInt(setM[1], 10);
    if (min >= 1 && min <= 180) return `pomodoro:set:${min}`;
  }
  // 带参:open_app:<名字>(交执行侧查中文名→包名表;这里只校验非空)。原文用 v(不 lower)保留中文/大小写。
  const appM = /^open_app:(.+)$/.exec(v);
  if (appM) {
    const name = appM[1].trim();
    if (name) return `open_app:${name}`;
  }
  return undefined;
}

/**
 * 追加进 system prompt 的控制子句：仅 holo 面注入，告诉 LLM 何时/如何填 control。
 * 保持角色照常用 reply 回应（换歌也可以嘴上确认），control 只是并行的机器指令。
 */
export const HOLO_CONTROL_SYSTEM_NOTE = [
  'You are running on a hands-free holographic display (a smart-speaker-like companion).',
  'The user speaks to control music/podcast playback. In addition to your normal JSON reply,',
  'when the user clearly asks to control playback, ALSO include a top-level string field "control" with EXACTLY one of:',
  '- "next" (skip to next / play another track)',
  '- "prev" (previous / go back a track)',
  '- "pause" (explicitly pause playback)',
  '- "play" (explicitly resume/start playback)',
  '- "playPause" (toggle — only when user intent is ambiguous between pause/resume)',
  '- "volume:up" (a bit louder / turn it up)',
  '- "volume:down" (a bit quieter / turn it down)',
  '- "volume:min" (set volume to minimum 最小声/静一点到底)',
  '- "volume:half" (set volume to about half 一半音量)',
  '- "volume:max" (set volume to maximum 最大声)',
  '- "pomodoro:pause" (pause the FOCUS/POMODORO countdown timer 暂停专注/番茄钟 — NOT the music)',
  '- "pomodoro:resume" (resume the focus/pomodoro timer 继续专注)',
  '- "pomodoro:set:<minutes>" (set focus session length AND restart the timer, e.g. 番茄改成25分钟一组/设为25分钟 → "pomodoro:set:25"; integer 1-180)',
  '- "mode:focus" (switch to music mode / 音乐)',
  '- "mode:commute" (switch to podcast mode / 播客)',
  '- "open_app:<name>" (open/launch an app by its Chinese or common name, e.g. 打开微信→"open_app:微信"、打开日历→"open_app:日历")',
  'Disambiguate: “暂停/pause” alone refers to MUSIC ("pause"); “暂停专注/暂停番茄/pause the timer” refers to the pomodoro ("pomodoro:pause").',
  'Only include "control" when the user is actually asking to control playback or the pomodoro; otherwise omit it entirely and just chat normally.',
  'Always keep replying in character in the "reply" field (a brief spoken confirmation is nice), regardless of control.',
].join(' ');
