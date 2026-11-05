import { useState } from 'react';
import type { LlmSettings } from '../lib/llm.ts';
import type { TtsSettings } from '../lib/tts.ts';
import {
  DEFAULT_QWEN_TTS_API_URL,
  DEFAULT_QWEN_TTS_INSTRUCTIONS,
} from '../lib/apiConfig.ts';
import type { BubbleStyle } from '../lib/bubbleStyleStore.ts';
import type { CallSettings } from '../lib/callSettingsStore.ts';
import {
  getLive2DRendererPref,
  setLive2DRendererPref,
  type Live2DRendererPref,
} from '../lib/deviceTier.ts';

type SettingsModalProps = {
  llmSettings: LlmSettings;
  ttsSettings: TtsSettings;
  callSettings: CallSettings;
  bubbleStyle: BubbleStyle;
  browserVoices: SpeechSynthesisVoice[];
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
  onUpdateLlm: (patch: Partial<LlmSettings>) => void;
  onUpdateTts: (patch: Partial<TtsSettings>) => void;
  onUpdateCall: (patch: Partial<CallSettings>) => void;
  onUpdateBubbleStyle: (style: BubbleStyle) => void;
  debugMode?: boolean;
  onDebugModeChange?: (v: boolean) => void;
  sensorEnabled?: boolean;
  onSensorEnabledChange?: (v: boolean) => void;
};

export function SettingsModal({
  llmSettings,
  ttsSettings,
  callSettings,
  bubbleStyle,
  browserVoices,
  onClose,
  onSave,
  onReset,
  onUpdateLlm,
  onUpdateTts,
  onUpdateCall,
  onUpdateBubbleStyle,
  debugMode,
  onDebugModeChange,
  sensorEnabled,
  onSensorEnabledChange,
}: SettingsModalProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 角色渲染引擎（自动/原生/网页）：设备级偏好存 localStorage，重启后由 Live2DStage 读取生效。
  const [rendererPref, setRendererPref] = useState<Live2DRendererPref>(() => getLive2DRendererPref());
  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <section
        className="settings-modal"
        onClick={(event) => event.stopPropagation()}
        aria-label="设置"
      >
        <div className="settings-modal-header">
          <button type="button" className="settings-close" onClick={onClose}>
            关闭
          </button>
          <div>
            <p className="eyebrow">设置</p>
            <h2>设置</h2>
          </div>
          <button type="button" className="settings-save" onClick={onSave}>
            保存
          </button>
        </div>

        {/* 大模型（API 地址/模型/密钥）仅在调试模式下可见，避免测试用户误改导致聊天异常。 */}
        {debugMode ? (
          <div className="settings-advanced-toggle">
            <button
              type="button"
              className="settings-reset"
              onClick={() => setShowAdvanced((prev) => !prev)}
            >
              {showAdvanced ? '▾ 收起大模型设置' : '▸ 大模型 / 自带密钥'}
            </button>
          </div>
        ) : null}

        {debugMode && showAdvanced && (
          <div className="settings-grid">
            <label className="field">
              <span>API 地址</span>
              <input
                type="text"
                value={llmSettings.apiUrl}
                onChange={(event) => onUpdateLlm({ apiUrl: event.target.value })}
                placeholder="https://..."
              />
            </label>
            <label className="field">
              <span>模型</span>
              <input
                type="text"
                value={llmSettings.model}
                onChange={(event) => onUpdateLlm({ model: event.target.value })}
                placeholder="gpt-4.1-mini"
              />
            </label>
            <label className="field settings-key-field">
              <span>API 密钥</span>
              <input
                type="password"
                value={llmSettings.apiKey}
                onChange={(event) => onUpdateLlm({ apiKey: event.target.value })}
                placeholder="sk-..."
              />
            </label>
          </div>
        )}

        <div className="settings-section">
          <div>
            <p className="eyebrow">语音</p>
            <h3>TTS 设置</h3>
          </div>
          <div className="settings-grid">
            <label className="field">
              <span>服务商</span>
              <select
                value={ttsSettings.provider}
                onChange={(event) => onUpdateTts({ provider: event.target.value as TtsSettings['provider'] })}
              >
                <option value="gateway">后台默认 TTS（推荐）</option>
                <option value="qwen">通义千问 / DashScope</option>
                <option value="browser">浏览器 / 系统语音</option>
                <option value="capacitor">原生语音（推荐）</option>
                <option value="api">TTS API</option>
                <option value="off">关闭</option>
              </select>
            </label>
            <label className="field">
              <span>浏览器语音</span>
              <select
                value={ttsSettings.browserVoice}
                onChange={(event) => onUpdateTts({ browserVoice: event.target.value })}
                disabled={ttsSettings.provider !== 'browser'}
              >
                <option value="">默认语音</option>
                {browserVoices.map((voice) => (
                  <option key={`${voice.name}-${voice.lang}`} value={voice.name}>
                    {voice.name} · {voice.lang}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>TTS API 地址</span>
              <input
                type="text"
                value={ttsSettings.apiUrl}
                onChange={(event) => onUpdateTts({ apiUrl: event.target.value })}
                placeholder={DEFAULT_QWEN_TTS_API_URL}
                disabled={ttsSettings.provider === 'gateway' || (ttsSettings.provider !== 'api' && ttsSettings.provider !== 'qwen')}
              />
            </label>
            <label className="field">
              <span>TTS 模型</span>
              <input
                type="text"
                value={ttsSettings.apiModel}
                onChange={(event) => onUpdateTts({ apiModel: event.target.value })}
                placeholder="qwen3-tts-instruct-flash"
                disabled={ttsSettings.provider === 'gateway' || (ttsSettings.provider !== 'api' && ttsSettings.provider !== 'qwen')}
              />
            </label>
            <label className="field">
              <span>TTS 语音</span>
              <input
                type="text"
                value={ttsSettings.apiVoice}
                onChange={(event) => onUpdateTts({ apiVoice: event.target.value })}
                placeholder="Bunny"
                disabled={ttsSettings.provider === 'gateway' || (ttsSettings.provider !== 'api' && ttsSettings.provider !== 'qwen')}
              />
            </label>
            <label className="field">
              <span>TTS API 密钥</span>
              <input
                type="password"
                value={ttsSettings.apiKey}
                onChange={(event) => onUpdateTts({ apiKey: event.target.value })}
                placeholder="留空 = 使用大模型 API 密钥"
                disabled={ttsSettings.provider === 'gateway' || (ttsSettings.provider !== 'api' && ttsSettings.provider !== 'qwen')}
              />
            </label>
            <label className="field settings-wide-field">
              <span>TTS 指令</span>
              <input
                type="text"
                value={ttsSettings.apiInstructions}
                onChange={(event) => onUpdateTts({ apiInstructions: event.target.value })}
                placeholder={DEFAULT_QWEN_TTS_INSTRUCTIONS}
                disabled={ttsSettings.provider !== 'qwen'}
              />
            </label>
          </div>
        </div>

        <div className="settings-section">
          <div>
            <p className="eyebrow">通话</p>
            <h3>语音通话 (RTC)</h3>
          </div>
          <p className="settings-hint">
            和角色打电话走火山引擎 RTC 实时对话式 AI。进房 Token、智能体启停需在后端完成，
            前端只填后端服务地址；AppKey / AK/SK 等密钥请勿填在此处。
          </p>
          <div className="settings-grid">
            <div className="settings-toggle-row">
              <span className="settings-toggle-label">开启通话功能</span>
              <button
                type="button"
                className={`settings-toggle ${callSettings.enabled ? 'is-active' : ''}`}
                onClick={() => onUpdateCall({ enabled: !callSettings.enabled })}
                aria-pressed={callSettings.enabled}
              >
                <span className="settings-toggle-track" aria-hidden="true">
                  <span className="settings-toggle-thumb" />
                </span>
                <span className="settings-toggle-state">{callSettings.enabled ? '开' : '关'}</span>
              </button>
            </div>
            <label className="field settings-wide-field">
              <span>后端服务地址</span>
              <input
                type="text"
                value={callSettings.backendBaseUrl}
                onChange={(event) => onUpdateCall({ backendBaseUrl: event.target.value })}
                placeholder="https://your-server.com/aigc（留空 = mock 体验）"
              />
            </label>
            <label className="field">
              <span>RTC AppId（可选）</span>
              <input
                type="text"
                value={callSettings.rtcAppId}
                onChange={(event) => onUpdateCall({ rtcAppId: event.target.value })}
                placeholder="留空 = 由后端下发"
              />
            </label>
          </div>
        </div>

        <div className="settings-section">
          <div>
            <p className="eyebrow">外观</p>
            <h3>聊天气泡</h3>
          </div>
          <div className="settings-grid">
            <label className="field">
              <span>气泡风格</span>
              <select
                value={bubbleStyle}
                onChange={(e) => onUpdateBubbleStyle(e.target.value as BubbleStyle)}
              >
                <option value="light">微乳白薄雾玻璃</option>
                <option value="dark">暗灰薄雾</option>
              </select>
            </label>
            <label className="field">
              <span>角色渲染引擎（重启生效）</span>
              <select
                value={rendererPref}
                onChange={(e) => {
                  const next = e.target.value as Live2DRendererPref;
                  setLive2DRendererPref(next);
                  setRendererPref(next);
                }}
              >
                <option value="auto">自动（低端机走原生）</option>
                <option value="native">强制原生渲染</option>
                <option value="webview">强制网页渲染</option>
              </select>
            </label>
          </div>
        </div>

        <div className="settings-section">
          <div>
            <p className="eyebrow">互动</p>
            <h3>体感互动</h3>
          </div>
          <div className="settings-grid">
            <div className="settings-toggle-row">
              <span className="settings-toggle-label">倾斜跟随视线 · 摇一摇互动</span>
              <button
                type="button"
                className={`settings-toggle ${sensorEnabled ? 'is-active' : ''}`}
                onClick={() => onSensorEnabledChange?.(!sensorEnabled)}
                aria-pressed={sensorEnabled}
              >
                <span className="settings-toggle-track" aria-hidden="true">
                  <span className="settings-toggle-thumb" />
                </span>
                <span className="settings-toggle-state">{sensorEnabled ? '开' : '关'}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div>
            <p className="eyebrow">开发者</p>
            <h3>调试模式</h3>
          </div>
          <div className="settings-grid">
            <div className="settings-toggle-row">
              <span className="settings-toggle-label">开启调试模式</span>
              <button
                type="button"
                className={`settings-toggle ${debugMode ? 'is-active' : ''}`}
                onClick={() => onDebugModeChange?.(!debugMode)}
                aria-pressed={debugMode}
              >
                <span className="settings-toggle-track" aria-hidden="true">
                  <span className="settings-toggle-thumb" />
                </span>
                <span className="settings-toggle-state">{debugMode ? '开' : '关'}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="settings-actions">
          <button type="button" className="settings-reset" onClick={onReset}>
            恢复默认
          </button>
        </div>
      </section>
    </div>
  );
}
