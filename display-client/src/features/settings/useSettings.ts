import { useEffect, useState } from 'react';
import {
  clearStoredLlmSettings,
  getDefaultLlmSettings,
  loadStoredLlmSettings,
  saveStoredLlmSettings,
  type LlmSettings,
} from '../../lib/llm.ts';
import {
  getDefaultTtsSettings,
  loadStoredTtsSettings,
  saveStoredTtsSettings,
  type TtsSettings,
} from '../../lib/tts.ts';
import { loadTtsEnabled, saveTtsEnabled } from '../../lib/ttsEnabledStore.ts';
import {
  getDefaultCallSettings,
  loadStoredCallSettings,
  saveStoredCallSettings,
  type CallSettings,
} from '../../lib/callSettingsStore.ts';
import {
  DEFAULT_QWEN_TTS_API_URL,
  DEFAULT_QWEN_TTS_INSTRUCTIONS,
  DEFAULT_QWEN_TTS_MODEL,
  DEFAULT_QWEN_TTS_VOICE,
} from '../../lib/apiConfig.ts';

export interface UseSettingsResult {
  llmSettings: LlmSettings;
  ttsSettings: TtsSettings;
  callSettings: CallSettings;
  ttsEnabled: boolean;
  browserVoices: SpeechSynthesisVoice[];
  updateLlmSettings: (patch: Partial<LlmSettings>) => void;
  updateTtsSettings: (patch: Partial<TtsSettings>) => void;
  updateCallSettings: (patch: Partial<CallSettings>) => void;
  /** 持久化当前三套设置（LLM/TTS/Call），用于设置弹窗「保存」。 */
  persistSettings: () => void;
  /** 重置三套设置为默认值并落盘。 */
  resetSettings: () => void;
  /** 设置语音播报开关并落盘（副作用如停播由调用方处理）。 */
  setTtsEnabled: (next: boolean) => void;
}

/**
 * 设置中心：LLM / TTS / 通话设置 + 语音播报开关 + 浏览器可用语音列表。
 * 从 App.tsx 抽出，行为保持不变（含挂载时读取存储、voiceschanged 同步、
 * qwen provider 切换时的默认值补全）。
 */
export function useSettings(): UseSettingsResult {
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(getDefaultLlmSettings());
  const [ttsSettings, setTtsSettings] = useState<TtsSettings>(getDefaultTtsSettings());
  const [callSettings, setCallSettings] = useState<CallSettings>(getDefaultCallSettings());
  const [ttsEnabled, setTtsEnabledState] = useState(loadTtsEnabled());
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    setLlmSettings(loadStoredLlmSettings());
    setTtsSettings(loadStoredTtsSettings());
    setCallSettings(loadStoredCallSettings());
  }, []);

  useEffect(() => {
    if (!('speechSynthesis' in window)) {
      return undefined;
    }

    function syncVoices() {
      setBrowserVoices(window.speechSynthesis.getVoices());
    }

    syncVoices();
    window.speechSynthesis.addEventListener('voiceschanged', syncVoices);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', syncVoices);
    };
  }, []);

  function updateLlmSettings(patch: Partial<LlmSettings>) {
    setLlmSettings((current) => ({
      ...current,
      ...patch,
    }));
  }

  function updateTtsSettings(patch: Partial<TtsSettings>) {
    setTtsSettings((current) => ({
      ...current,
      ...(patch.provider === 'qwen'
        ? {
            apiUrl: current.apiUrl || DEFAULT_QWEN_TTS_API_URL,
            apiModel: current.apiModel === 'tts-1' ? DEFAULT_QWEN_TTS_MODEL : current.apiModel || DEFAULT_QWEN_TTS_MODEL,
            apiVoice: current.apiVoice === 'alloy' ? DEFAULT_QWEN_TTS_VOICE : current.apiVoice || DEFAULT_QWEN_TTS_VOICE,
            apiInstructions: current.apiInstructions || DEFAULT_QWEN_TTS_INSTRUCTIONS,
          }
        : {}),
      ...patch,
    }));
  }

  function updateCallSettings(patch: Partial<CallSettings>) {
    setCallSettings((current) => ({
      ...current,
      ...patch,
    }));
  }

  function persistSettings() {
    saveStoredLlmSettings(llmSettings);
    saveStoredTtsSettings(ttsSettings);
    saveStoredCallSettings(callSettings);
  }

  function resetSettings() {
    clearStoredLlmSettings();
    const ttsDefaults = getDefaultTtsSettings();
    const callDefaults = getDefaultCallSettings();
    saveStoredTtsSettings(ttsDefaults);
    saveStoredCallSettings(callDefaults);
    setLlmSettings(getDefaultLlmSettings());
    setTtsSettings(ttsDefaults);
    setCallSettings(callDefaults);
  }

  function setTtsEnabled(next: boolean) {
    setTtsEnabledState(next);
    saveTtsEnabled(next);
  }

  return {
    llmSettings,
    ttsSettings,
    callSettings,
    ttsEnabled,
    browserVoices,
    updateLlmSettings,
    updateTtsSettings,
    updateCallSettings,
    persistSettings,
    resetSettings,
    setTtsEnabled,
  };
}
