/**
 * U3 电台执行侧：把 holoIntent 的 HoloAction 映射到 RadioLauncher（本地 SD 音乐播控 + 原生音量）。
 * 替代 holo 的 useHoloControlBus/djView.controls（云电台）。deps 注入以便纯函数单测。
 *
 * holo 专属动作（dj.setMode 云电台模式 / pomodoro.* 番茄钟）U3 不适用 → no-op（spec §5「去掉」）。
 * chat 动作不在此处理：由 useRadioVoice 直接调 useChat.handleSubmit（对话+TTS 回应）。
 */
import type { HoloAction } from '../holo/holoIntent.ts';

export interface RadioVoiceDeps {
  /** 本地播放控制：toggle=播停开关 / next / prev（→ RadioLauncher.playbackControl）。 */
  playback(op: 'toggle' | 'next' | 'prev'): void;
  /** 绝对设定媒体音量 0..1（→ RadioLauncher.setVolume）。 */
  setVolume(value: number): void;
  /** 相对增减媒体音量 ±分数（→ RadioLauncher.adjustVolume）。 */
  adjustVolume(delta: number): void;
  /** 当前是否在播放（判 dj.pause/dj.play 的幂等条件）。 */
  isPlaying(): boolean;
  /**
   * 按名字打开应用（宿主侧解析：已装app标签模糊匹配 → 中文名包名表 → 未知回落"更多应用"抽屉）。
   * 解析要查已装应用清单（异步、原生），故放宿主 deps 而非纯执行器里。
   */
  openApp(name: string): void;
}

export function executeRadioAction(action: HoloAction, deps: RadioVoiceDeps): void {
  switch (action.type) {
    case 'dj.next': deps.playback('next'); break;
    case 'dj.prev': deps.playback('prev'); break;
    case 'dj.playPause': deps.playback('toggle'); break;
    case 'dj.pause': if (deps.isPlaying()) deps.playback('toggle'); break;
    case 'dj.play': if (!deps.isPlaying()) deps.playback('toggle'); break;
    case 'volume.delta': deps.adjustVolume(action.delta); break;
    case 'volume.set': deps.setVolume(action.value); break;
    case 'open_app': deps.openApp(action.name); break; // 宿主 deps 负责解析(已装标签/表/抽屉)
    // U3 不适用：云电台模式 / 番茄钟 / 兜底对话（chat 另由 useRadioVoice 处理）。
    case 'dj.setMode':
    case 'pomodoro.ack':
    case 'pomodoro.pause':
    case 'pomodoro.resume':
    case 'pomodoro.setMinutes':
    case 'chat':
      break;
  }
}
