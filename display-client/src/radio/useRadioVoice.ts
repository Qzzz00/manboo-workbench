/**
 * U3 电台会话编排：麦克风常驻监听（复用 useHoloVoice）→ ASR 整句文本交 LLM 按语义判意图
 * （handleSubmit → useChat holoControl:true）。LLM 回 control(next/prev/pause/play/volume/open_app)
 * → 执行；纯聊天则只回复+角色 TTS。
 *
 * ★命中率：去掉了本地关键词正则快路径——高频硬指令也交 LLM 语义判断（覆盖自然/多样说法，正则表覆盖
 * 不全是命中率低的根源）。牺牲一点秒响应换准确率，链路也更简单（无双轨/抑制）。
 * 门控 muted=自己 TTS 播放中 || LLM 回合进行中；配合 useHoloVoice 的 AEC 回声消除，避免自听/回合重叠。
 */
import { useCallback } from 'react';
import { useHoloVoice } from '../holo/useHoloVoice.ts';
import { resolveIntent, playbackIntent } from '../holo/holoIntent.ts';
import type { HoloControl } from '../holo/holoControl.ts';
import { executeRadioAction, type RadioVoiceDeps } from './radioVoiceExecutor.ts';

export interface UseRadioVoiceArgs {
  /** 主开关：进电台即 true，获取麦克风。 */
  enabled: boolean;
  /** 瞬时门控：自己 TTS 说话 / LLM 回合进行中时 true（暂停收音，不释放流）。 */
  muted: boolean;
  /** 执行侧依赖（播控/音量/开应用/isPlaying）。 */
  deps: RadioVoiceDeps;
  /** LLM 对话入口（useChat.handleSubmit）。 */
  handleSubmit: (text: string) => void;
  /**
   * ASR 出整句非空文本时调用（早于 LLM 回合）。角色的应答叫声与动作都挂在这里。
   * ★别再想着「叫声不需要知道内容，可以提前到 VAD 断句」——那样会对着音乐/噪声乱叫，
   * 真机实测过（放歌 45s 误叫 6 次），详见 RadioApp 里 onHeard 上方的注释。
   */
  onHeard?: (text: string) => void;
}

export function useRadioVoice({
  enabled, muted, deps, handleSubmit, onHeard,
}: UseRadioVoiceArgs): { micReady: boolean; listening: boolean; onControl: (c: HoloControl) => void } {
  // LLM 判出控制意图 → 执行（经复用的 resolveIntent 翻成 HoloAction，再交执行器）。
  const onControl = useCallback((c: HoloControl) => {
    const action = resolveIntent(playbackIntent(c));
    console.info('[radio-voice] control:', c, '→', JSON.stringify(action));
    executeRadioAction(action, deps);
  }, [deps]);

  const onUtterance = useCallback((text: string) => {
    console.info('[radio-voice] utterance:', JSON.stringify(text));
    // 动作/表情需要知道说了什么，所以只能等到这里；但先于 handleSubmit 调用，不等 LLM。
    onHeard?.(text);
    handleSubmit(text); // 整句交 LLM 语义判意图（control + reply）
  }, [handleSubmit, onHeard]);

  const { micReady, listening } = useHoloVoice({
    enabled,
    muted,
    onUtterance,
    onError: (err) => console.warn('[radio-voice]', err),
  });

  return { micReady, listening, onControl };
}
