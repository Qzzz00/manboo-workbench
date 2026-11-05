import { useEffect, useState } from 'react';
import type { AvatarManifest } from '../features/live2d/avatarManifest.ts';
import {
  loadCharacterSettings,
  saveCharacterSettings,
  deleteCharacterSettings,
  getDefaultSettings,
  type CharacterSettings,
} from '../lib/characterSettingsStore.ts';

type Props = {
  open: boolean;
  avatar: AvatarManifest;
  onClose: () => void;
  onSave: () => void;
};

function traitsToString(traits: string[]) {
  return traits.join('、');
}

export function CharacterSettingsModal({ open, avatar, onClose, onSave }: Props) {
  const [settings, setSettings] = useState<CharacterSettings>(getDefaultSettings());
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    if (!open || hasLoaded) return;
    const saved = loadCharacterSettings(avatar.id);
    if (saved) {
      setSettings(saved);
    } else {
      setSettings({
        customName: avatar.name,
        customPersona: '',
        customTone: avatar.persona.tone,
        customTraits: traitsToString(avatar.persona.traits),
        customStyleRules: avatar.persona.styleRules.join('\n'),
        worldBackground: '',
      });
    }
    setHasLoaded(true);
  }, [open, avatar]);

  useEffect(() => {
    if (!open) setHasLoaded(false);
  }, [open]);

  if (!open) return null;

  function handleSave() {
    saveCharacterSettings(avatar.id, settings);
    onSave();
    onClose();
  }

  function handleReset() {
    deleteCharacterSettings(avatar.id);
    setSettings({
      customName: avatar.name,
      customPersona: '',
      customTone: avatar.persona.tone,
      customTraits: traitsToString(avatar.persona.traits),
      customStyleRules: avatar.persona.styleRules.join('\n'),
      worldBackground: '',
    });
    onSave();
    onClose();
  }

  return (
    <div className="char-settings-overlay">
      <div className="char-settings-modal">
        <div className="char-settings-header">
          <button type="button" className="char-settings-back" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div>
            <p className="eyebrow">角色设定</p>
            <h2>{avatar.name}</h2>
          </div>
          <button type="button" className="char-settings-save-btn" onClick={handleSave}>
            保存
          </button>
        </div>

        <div className="char-settings-body">
          <label className="field">
            <span>角色姓名</span>
            <input
              type="text"
              value={settings.customName}
              onChange={(e) => setSettings((s) => ({ ...s, customName: e.target.value }))}
              placeholder={avatar.name}
            />
          </label>

          <label className="field">
            <span>角色人设 (Persona)</span>
            <textarea
              rows={4}
              value={settings.customPersona}
              onChange={(e) => setSettings((s) => ({ ...s, customPersona: e.target.value }))}
              placeholder="描述角色的身份、职业、年龄、外貌、性格特点等..."
              style={{ resize: 'vertical', minHeight: 60 }}
            />
          </label>

          <label className="field">
            <span>语气基调 (Tone)</span>
            <input
              type="text"
              value={settings.customTone}
              onChange={(e) => setSettings((s) => ({ ...s, customTone: e.target.value }))}
              placeholder={avatar.persona.tone}
            />
          </label>

          <label className="field">
            <span>性格标签 (用逗号或顿号分隔)</span>
            <input
              type="text"
              value={settings.customTraits}
              onChange={(e) => setSettings((s) => ({ ...s, customTraits: e.target.value }))}
              placeholder={traitsToString(avatar.persona.traits)}
            />
          </label>

          <label className="field">
            <span>说话风格规则 (每行一条)</span>
            <textarea
              rows={5}
              value={settings.customStyleRules}
              onChange={(e) => setSettings((s) => ({ ...s, customStyleRules: e.target.value }))}
              placeholder={avatar.persona.styleRules.join('\n')}
              style={{ resize: 'vertical', minHeight: 80 }}
            />
          </label>

          <label className="field">
            <span>世界观背景故事</span>
            <textarea
              rows={4}
              value={settings.worldBackground}
              onChange={(e) => setSettings((s) => ({ ...s, worldBackground: e.target.value }))}
              placeholder="例如：故事发生在一个魔法与科技并存的未来世界..."
              style={{ resize: 'vertical', minHeight: 60 }}
            />
          </label>

          <label className="field">
            <span>通话音色 (RTC)</span>
            <input
              type="text"
              value={settings.callVoice ?? ''}
              onChange={(e) => setSettings((s) => ({ ...s, callVoice: e.target.value }))}
              placeholder={avatar.voice ? `默认：${avatar.voice}` : '留空 = 角色默认音色'}
            />
          </label>

          <button type="button" className="settings-reset" onClick={handleReset} style={{ marginTop: 8 }}>
            恢复默认设定
          </button>
        </div>
      </div>
    </div>
  );
}
