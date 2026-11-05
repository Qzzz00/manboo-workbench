/**
 * 全息屏控制总线（消费侧）：把 holoIntent 的纯映射接到活的执行端（djView / 音量 / 番茄 / 对话）。
 * 输入源（语音、将来 Stackchan 手势/触摸）只管 `dispatch(intent)`，不关心怎么执行、彼此无耦合。
 *
 * 执行端用 ref 兜住，故返回的 dispatch 身份稳定（可安全放进 onControl/onGesture 等回调依赖）。
 */
import { useCallback, useRef } from 'react';
import type { DjModeView } from '../hooks/useDjMode';
import { resolveIntent, type HoloIntent } from './holoIntent';

export interface HoloControlBusDeps {
  /** DJ 引擎视图：播放控制 + 模式切换。 */
  djView: DjModeView;
  /** 音量相对增减（djClient 暂未暴露音量控制 → 留回调，Stackchan 手势期接上；未接则忽略）。 */
  onVolumeDelta?: (delta: number) => void;
  /** 音量绝对设定 0..1（同上）。 */
  onVolumeSet?: (value: number) => void;
  /** 消除番茄提醒（触摸屏幕/Stackchan）。 */
  onPomodoroAck?: () => void;
  /** 语音暂停/继续专注倒计时。 */
  onPomodoroPause?: () => void;
  onPomodoroResume?: () => void;
  /** 语音改专注时长(分钟)并立即按新时长重开。 */
  onPomodoroSetMinutes?: (minutes: number) => void;
  /** 兜底对话：非控制指令 → 交给聊天管线（LLM+TTS）。 */
  onChat?: (text: string) => void;
}

export function useHoloControlBus(deps: HoloControlBusDeps): (intent: HoloIntent) => void {
  const ref = useRef(deps);
  ref.current = deps;
  return useCallback((intent: HoloIntent) => {
    const d = ref.current;
    const action = resolveIntent(intent);
    switch (action.type) {
      case 'dj.next': d.djView.dj.controls.next(); break;
      case 'dj.prev': d.djView.dj.controls.prev(); break;
      case 'dj.playPause': d.djView.dj.controls.playPause(); break;
      // 明确语义的暂停/播放：按当前 paused 状态条件触发开关(重复指令=无操作,幂等)
      case 'dj.pause': if (!d.djView.dj.paused) d.djView.dj.controls.playPause(); break;
      case 'dj.play': if (d.djView.dj.paused) d.djView.dj.controls.playPause(); break;
      case 'dj.setMode': d.djView.setMode(action.mode); break;
      case 'volume.delta': d.onVolumeDelta?.(action.delta); break;
      case 'volume.set': d.onVolumeSet?.(action.value); break;
      case 'pomodoro.ack': d.onPomodoroAck?.(); break;
      case 'pomodoro.pause': d.onPomodoroPause?.(); break;
      case 'pomodoro.resume': d.onPomodoroResume?.(); break;
      case 'pomodoro.setMinutes': d.onPomodoroSetMinutes?.(action.minutes); break;
      case 'chat': d.onChat?.(action.text); break;
    }
  }, []);
}
