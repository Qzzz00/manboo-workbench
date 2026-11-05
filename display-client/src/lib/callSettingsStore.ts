/**
 * 通话 (RTC) 全局配置
 *
 * 「和智能体打电话」走火山引擎 RTC 实时对话式 AI（RTC AIGC）。
 * 该方案绕不开后端：进房 Token 需用 AppKey 签发、StartVoiceChat 需用 AK/SK 调用，
 * 这些密钥只能放服务端。因此前端控制台里只配「后端服务地址」(+ 可选 AppId)，
 * AppKey / AK/SK / ASR / TTS 等敏感参数全部留在后端，不进前端。
 *
 * 后端约定接口（由 rtcCall.ts 调用）：
 *   POST {backendBaseUrl}/rtc/token  → { appId, roomId, userId, token }
 *   POST {backendBaseUrl}/rtc/start  → 启动智能体 (StartVoiceChat)
 *   POST {backendBaseUrl}/rtc/stop   → 停止智能体 (StopVoiceChat)
 */

const STORAGE_KEY = 'llm-live2d:call-settings';

export type CallSettings = {
  /** 是否开启通话功能（关闭时点听筒提示去设置开启） */
  enabled: boolean;
  /** 后端服务地址，例如 https://your-server.com/aigc（末尾不带斜杠） */
  backendBaseUrl: string;
  /** RTC AppId（非密钥，可放前端；留空则由后端 /rtc/token 下发） */
  rtcAppId: string;
};

export function getDefaultCallSettings(): CallSettings {
  return {
    enabled: true,
    backendBaseUrl: '',
    rtcAppId: '',
  };
}

export function loadStoredCallSettings(): CallSettings {
  const fallback = getDefaultCallSettings();
  if (typeof window === 'undefined') {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<CallSettings>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : fallback.enabled,
      backendBaseUrl: parsed.backendBaseUrl?.trim() ?? fallback.backendBaseUrl,
      rtcAppId: parsed.rtcAppId?.trim() ?? fallback.rtcAppId,
    };
  } catch {
    return fallback;
  }
}

export function saveStoredCallSettings(settings: CallSettings) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** 后端是否已配置：决定能否走真实 RTC（mock 模式下不依赖此项） */
export function isCallBackendConfigured(settings: CallSettings): boolean {
  return settings.backendBaseUrl.trim().length > 0;
}
