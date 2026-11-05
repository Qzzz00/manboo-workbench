import { useState } from 'react';
import { showToast } from '../../lib/toastStore.ts';
import { type CallSettings } from '../../lib/callSettingsStore.ts';

export type CallMode = 'voice' | 'video';

export interface UseCallResult {
  callOpen: boolean;
  /** 当前通话模式：voice=纯语音；video=视频通话 */
  callMode: CallMode;
  setCallOpen: (open: boolean) => void;
  /** 发起语音通话：未开启则提示并不打开。 */
  startCall: () => void;
  /** 发起视频通话：未开启则提示并不打开。 */
  startVideoCall: () => void;
}

/**
 * 通话开关（语音/视频）。从 App.tsx 抽出。
 * 通话浮层(CallOverlay)的渲染与 systemMessage 构建仍由 App.tsx 负责。
 */
export function useCall(callSettings: CallSettings): UseCallResult {
  const [callOpen, setCallOpen] = useState(false);
  const [callMode, setCallMode] = useState<CallMode>('voice');

  function open(mode: CallMode) {
    if (!callSettings.enabled) {
      showToast('通话功能未开启，请在设置中开启', 'warning');
      return;
    }
    setCallMode(mode);
    setCallOpen(true);
  }

  return {
    callOpen,
    callMode,
    setCallOpen,
    startCall: () => open('voice'),
    startVideoCall: () => open('video'),
  };
}
