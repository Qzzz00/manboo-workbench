import { useState, useRef } from 'react';
import { generateBackground, saveBackground } from '../lib/backgroundGen.ts';

const PRESETS = [
  {
    label: '深夜温馨卧室',
    prompt:
      'A cozy anime-style bedroom at late night, soft warm bedside lamp glow, scattered plush pillows, faint silver moonlight through window, low saturation pink-purple tones, visual novel background style, soft ambient lighting, no characters',
  },
  {
    label: '清晨阳光房间',
    prompt:
      'A bright airy anime bedroom in early morning, soft golden sunlight through white lace curtains, pastel pink and cream tones, clean fresh atmosphere, visual novel background style, no characters',
  },
  {
    label: '梦幻星空窗台',
    prompt:
      'A dreamy anime bedroom with large window revealing starry night sky and firefly lights, warm wood-toned interior, cozy window seat, subtle magical atmosphere, Ghibli-inspired, visual novel background style, no characters',
  },
];

type BackgroundMode = 'ai' | 'local';

type BackgroundPanelProps = {
  avatarId: string;
  avatarName: string;
  currentBg: string | null;
  onApply: (url: string) => void;
  onRemove: () => void;
};

export function BackgroundPanel({
  avatarId,
  avatarName,
  currentBg,
  onApply,
  onRemove,
}: BackgroundPanelProps) {
  const [mode, setMode] = useState<BackgroundMode>('ai');
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState<string>('');
  const [error, setError] = useState('');
  const galleryInputRef = useRef<HTMLInputElement>(null);

  function switchMode(next: BackgroundMode) {
    if (next === mode) return;
    setMode(next);
    setPreviewUrl(null);
    setPreviewPrompt('');
    setError('');
  }

  function handleGalleryPick() {
    galleryInputRef.current?.click();
  }

  function handleGalleryFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setPreviewUrl(dataUrl);
      setPreviewPrompt('local-upload');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function handleGenerate() {
    const p = prompt.trim();
    if (!p || generating) return;
    setGenerating(true);
    setError('');
    try {
      const bg = await generateBackground(p);
      setPreviewUrl(bg.url);
      setPreviewPrompt(bg.prompt);
      saveBackground(avatarId, bg);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  }

  function handleApply() {
    if (!previewUrl) return;
    onApply(previewUrl);
    saveBackground(avatarId, {
      url: previewUrl,
      prompt: previewPrompt || 'local-upload',
      timestamp: Date.now(),
    });
  }

  return (
    <div className="bg-panel">
      <p className="control-drawer-label">背景设置 · {avatarName}</p>

      {/* Mode toggle */}
      <div className="bg-mode-tabs">
        <button
          type="button"
          className={`bg-mode-tab ${mode === 'ai' ? 'active' : ''}`}
          onClick={() => switchMode('ai')}
        >
          AI 生成
        </button>
        <button
          type="button"
          className={`bg-mode-tab ${mode === 'local' ? 'active' : ''}`}
          onClick={() => switchMode('local')}
        >
          本地上传
        </button>
      </div>

      {mode === 'ai' ? (
        <>
          {/* Presets */}
          <div className="bg-presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`chip ${prompt === preset.prompt ? 'active' : ''}`}
                onClick={() => setPrompt(preset.prompt)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Prompt input */}
          <textarea
            className="bg-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="输入自定义场景描述..."
            rows={2}
          />

          <div className="bg-actions">
            <button
              type="button"
              className="settings-save"
              onClick={handleGenerate}
              disabled={!prompt.trim() || generating}
            >
              {generating ? '生成中...' : '生成背景'}
            </button>
          </div>
        </>
      ) : (
        <div className="bg-upload-area">
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleGalleryFile}
          />
          <button
            type="button"
            className="settings-reset bg-upload-btn"
            onClick={handleGalleryPick}
          >
            从相册选择图片
          </button>
          <p className="bg-upload-hint">支持 JPG、PNG、WebP 格式</p>
        </div>
      )}

      {error ? <p className="bg-error">{error}</p> : null}

      {/* Preview */}
      {previewUrl ? (
        <div className="bg-preview">
          <img src={previewUrl} alt="背景预览" />
          <div className="bg-preview-actions">
            <button type="button" className="settings-save" onClick={handleApply}>
              应用背景
            </button>
          </div>
        </div>
      ) : null}

      {/* Current background */}
      {currentBg ? (
        <div className="bg-current">
          <p>当前背景</p>
          <img src={currentBg} alt="当前背景" />
          <button type="button" className="settings-reset" onClick={onRemove}>
            移除背景
          </button>
        </div>
      ) : null}
    </div>
  );
}
