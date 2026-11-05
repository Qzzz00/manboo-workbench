// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/VoiceForm.tsx(旅程立面子面板,本机版暂无页面引用)
/**
 * 旅程引擎：角色立面 - 语音子面板。
 *
 * 字段对齐 ALL-200 接口契约：
 * - tts_provider: 枚举 volc_seedtts / volc_v3 / qwen
 * - voice_id: 具体音色 ID
 * - emotion_mappings: 状态 → TTS 情绪参数映射表
 *
 * 试听按钮复用现有 /admin/tts-voices/preview 能力，由父组件传入 onPreview。
 */

import type { CharacterVoice, TtsEngine } from '@/shared/types';
import { MappingEditor } from '@/features/avatars/components/MappingEditor';

const ENGINE_OPTIONS: { value: TtsEngine; label: string }[] = [
  { value: 'volc_seedtts', label: '火山 SeedTTS' },
  { value: 'volc_v3', label: '火山 V3' },
  { value: 'qwen', label: '通义千问 (Qwen)' },
];

interface Props {
  value: CharacterVoice;
  onChange: (next: CharacterVoice) => void;
  onPreview?: (voiceId: string) => void;
  previewing?: boolean;
}

export function VoiceForm({ value, onChange, onPreview, previewing }: Props) {
  return (
    <div>
      <label>TTS 引擎 *</label>
      <select
        value={value.tts_provider}
        onChange={(e) => onChange({ ...value, tts_provider: e.target.value as TtsEngine })}
      >
        {ENGINE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <label>音色 ID *</label>
      <input
        type="text"
        value={value.voice_id}
        placeholder="如 BV001_streaming / S_cloned123"
        onChange={(e) => onChange({ ...value, voice_id: e.target.value })}
      />
      {onPreview && (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: 6 }}
          disabled={!value.voice_id.trim() || previewing}
          onClick={() => onPreview(value.voice_id.trim())}
        >
          {previewing ? '试听中…' : '🔊 试听'}
        </button>
      )}

      <MappingEditor
        label="情绪映射 emotion_mappings"
        value={value.emotion_mappings}
        onChange={(emotion_mappings) => onChange({ ...value, emotion_mappings })}
        keyPlaceholder="状态键（如 cheerful / melancholic）"
        valuePlaceholder="TTS 情绪参数（如 happy / sad）"
        emptyHint="暂无情绪映射，点击下方按钮添加"
      />

      <p className="hint" style={{ marginTop: 8 }}>
        运行时根据角色当前状态命中映射键，把对应情绪参数传给 TTS 引擎。
      </p>
    </div>
  );
}
